const express = require("express");

const { buildModels } = require("../models");
const { assertConfigured } = require("../config/catalog");
const { AppError } = require("../utils/errors");
const { assertPrincipalId, assertNonEmptyString, assertOpaqueRef } = require("../utils/validate");
const { findPrincipalByContact, findPrincipalById } = require("../utils/principalId");
const { recordTrailStrict, getConsentTrail } = require("../services/consentTrail");
const { wrap, errorMapper, makeCheckOrigin } = require("./shared");

/**
 * The fiduciary's own back office: find a data principal by a contact detail
 * they have given you, and read their consent trail.
 *
 * MOUNT THIS SEPARATELY FROM createRouter, on its own path, behind your own
 * staff authentication. Every route here is operator-facing. Nothing on it is
 * scoped to a session principal, because an operator authorised to read one
 * data principal's trail is authorised to read any - that is what a back
 * office is - and the control is therefore attribution, not scoping: every
 * disclosure is recorded, with who made it and which ticket it was for,
 * before any data leaves.
 *
 * @param {object}   opts
 * @param {object}   opts.db - the connection returned by connect(). Required.
 * @param {Function} [opts.resolveOperator] - (req) => { actorRef } |
 *   Promise<{ actorRef }>. Your staff session lookup, the exact counterpart of
 *   createRouter's resolvePrincipal. Absent, throwing, or returning anything
 *   else and every route here denies with 401, so a misconfigured mount fails
 *   closed. actorRef is host-supplied and opaque - a staff id, a UUID, an LDAP
 *   uid - and is guarded by assertOpaqueRef.
 * @param {true}     opts.rateLimitedByHost - REQUIRED, and required to be
 *   literally true. See the throw below for why.
 * @param {string[]} [opts.allowedOrigins] - ADDITIONAL origins permitted to
 *   make a state-changing request, exactly as on createRouter. The host the
 *   request arrived on is always allowed; this list is a union with it.
 */
function createBackOfficeRouter({ db, resolveOperator, rateLimitedByHost, allowedOrigins = [] } = {}) {
  if (!db || typeof db.model !== "function") {
    throw new Error("db is required - pass the connection returned by connect()");
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((o) => typeof o !== "string")) {
    throw new Error("allowedOrigins must be an array of origin strings, e.g. [\"https://back-office.example\"]");
  }
  // A plain Error, never an AppError: this must not be mappable to an HTTP
  // response. It is a boot-time refusal, the same shape as assertConfigured's,
  // and for the same reason - the alternative fails silently at boot and then
  // loudly in front of the people it was supposed to protect.
  if (rateLimitedByHost !== true) {
    throw new Error(
      "createBackOfficeRouter requires rateLimitedByHost: true. This router is a people-search: " +
        "POST /principals/lookup answers whether an email address belongs to a registered data principal, " +
        "and for the shipped catalog's lender that means answering whether someone has applied for credit. " +
        "This package ships no rate limiting by documented decision, so put request-volume limiting " +
        "(e.g. express-rate-limit) in front of this mount, then pass rateLimitedByHost: true to say you have."
    );
  }
  // Same boot gate createRouter uses. It is not the DPO address that matters
  // here - it is PRINCIPAL_ID_SECRET, which lookupHash needs on the very first
  // lookup. Unset, this router builds fine and then 500s on the first search.
  assertConfigured();
  const models = buildModels(db);

  const router = express.Router();
  // Same order and same reasoning as createRouter: the origin check runs
  // FIRST, ahead of the body parsers, so there is no reason to parse up to
  // 100kb of a request that is about to be refused, and a forged request never
  // reaches the operator lookup at all.
  router.use(makeCheckOrigin(allowedOrigins));
  router.use(express.json({ limit: "100kb" }));
  router.use(express.urlencoded({ extended: false, limit: "100kb" }));

  /**
   * Operator identity comes only from the host's own staff authentication,
   * exactly as principal identity comes only from resolvePrincipal. It is
   * never read from the payload: actorRef is the entire content of the
   * accountability record, and one the caller chooses is not accountability.
   *
   * The ENTIRE shape check sits inside the try/catch, and the value is copied
   * into a local before it is validated. A hook that throws, returns a Proxy,
   * or exposes actorRef as a getter answering differently on each read must
   * produce a 401 - not an unhandled rejection that takes the process down,
   * and not a value that was validated and then swapped before it was stored.
   *
   * JSON only, deliberately not negotiated like createRouter's 401. There is
   * no signed-out data principal here to send back to a page; the only client
   * of this router is your own back-office application.
   */
  async function requireOperator(req, res, next) {
    if (typeof resolveOperator !== "function") {
      return res.status(401).json({ error: "operator authentication required" });
    }
    let actorRef;
    try {
      const resolved = await resolveOperator(req);
      if (!resolved || typeof resolved !== "object") {
        throw new AppError("resolveOperator did not return an operator", 401);
      }
      // Read ONCE, into a local, and validate the local - never the property.
      const candidate = resolved.actorRef;
      actorRef = assertOpaqueRef(candidate, "actorRef");
    } catch {
      return res.status(401).json({ error: "operator authentication required" });
    }
    req.actor = { role: "operator", ref: actorRef, channel: "api" };
    next();
  }

  /**
   * caseRef is the adopter's own ticket reference for the access, so the
   * record says WHY someone was looked up and not only by whom - answering a
   * Section 11 request rather than browsing. Optional, host-supplied, opaque,
   * and validated as a primitive before it can reach a stored field.
   */
  function readCaseRef(body) {
    const value = body.caseRef;
    if (value === undefined || value === null) return undefined;
    return assertOpaqueRef(value, "caseRef");
  }

  // ---------------------------------------------------------------------------
  // Back office - operator-facing, every disclosure recorded before it happens
  // ---------------------------------------------------------------------------

  /**
   * Find a data principal by a contact detail your operator already has.
   *
   * POST, not GET, and the address travels in the body: a raw email in a path
   * or a query string lands in access logs, browser history, Referer headers
   * and CDN cache keys, none of which this library can reach to clean up.
   *
   * EMAIL ONLY, refusing the phone branch findPrincipalByContact still offers
   * to direct library callers - the same rule POST /consent already applies.
   * One handset can belong to a whole household, so a phone number identifies
   * nobody on its own, and an operator surface must not guess.
   */
  router.post(
    "/principals/lookup",
    requireOperator,
    wrap(async (req, res) => {
      const caseRef = readCaseRef(req.body);
      // Validated as a primitive BEFORE it reaches a filter. Without this,
      // {"email": {"$ne": null}} would fall past findPrincipalByContact's
      // `typeof email === "string"` guard into its phone branch and answer a
      // clean "no match" for a payload that was an attack.
      // 320 is the RFC 5321 maximum for an address; nothing longer is one.
      const email = assertNonEmptyString(req.body.email, "email", 320);

      const principal = await findPrincipalByContact({ models, email });

      // THE RECORD IS WRITTEN BEFORE ANYTHING IS RETURNED, and it fails
      // closed: recordTrailStrict throws 503 if it cannot write, so no record
      // means no disclosure. An unaudited people-search is worse than no
      // people-search, and this is the whole of D7.
      //
      // WHAT THE ROW CARRIES is the design's central privacy invariant:
      //
      //   - on a HIT: principalId, and no hash of the address. A row carrying
      //     both would rebuild the email-to-person index erasure exists to
      //     destroy - the fiduciary holds PRINCIPAL_ID_SECRET, so it could
      //     recompute lookupHash("asha@...") at any time and rejoin an erased
      //     person to their surviving record forever.
      //   - on a MISS: no subject at all. A contact-derived identifier for
      //     someone who is not a data principal of this fiduciary would be
      //     personal data with no notice, no consent, no erasure path and no
      //     lawful basis for retention.
      //
      // TrailEntry has no field either hash could be written to, so neither
      // hazard can be reintroduced by a later edit here. Which addresses were
      // probed is forensics; that an operator searched, and found or did not
      // find, is accountability. Only the second is recorded.
      await recordTrailStrict(models, {
        principalId: principal ? principal.principalId : undefined,
        kind: "operator_lookup",
        outcome: "recorded",
        reasonCode: principal ? undefined : "no_match",
        actor: req.actor,
        caseRef,
      });

      if (!principal) {
        throw new AppError("No data principal matches that contact detail", 404);
      }
      res.status(200).json({ principalId: principal.principalId });
    })
  );

  /**
   * Read one data principal's consent trail.
   *
   * POST, for two reasons. It keeps the principalId out of access logs and
   * Referer headers, and - under D7 - this read performs a database write,
   * while GET is exempt from the same-origin check. A cross-site-triggerable
   * write into the accountability record, attributed to a signed-in operator,
   * is not acceptable.
   *
   * principalId IS READ FROM THE BODY HERE, and that is a deliberate carve-out
   * from a rule the rest of this library treats as absolute. On createRouter's
   * principal-facing routes principalId is a CREDENTIAL: reading it from a
   * payload would let anyone who knew an id act as that person, which is the
   * exact bug an earlier version shipped. Here it is a QUERY SUBJECT, and four
   * things have to hold for that distinction to be sound:
   *
   *   1. Operator identity still comes only from resolveOperator(req), never
   *      from the payload. The rule is unchanged for the thing it protects.
   *   2. The operator is not the subject, so there is no privilege to escalate
   *      by naming a different id - an operator authorised to read one trail
   *      is authorised to read any, which is what a back office is.
   *   3. assertPrincipalId runs before the value reaches any filter, so the
   *      injection half of the rule is enforced exactly as it is elsewhere.
   *   4. The route is gated by operator auth AND a fail-closed access record,
   *      so every single use of the carve-out is attributable.
   */
  router.post(
    "/principals/trail",
    requireOperator,
    wrap(async (req, res) => {
      const caseRef = readCaseRef(req.body);
      const principalId = assertPrincipalId(req.body.principalId);

      // The existence check runs BEFORE the record, but it is not itself a
      // disclosure - it decides what the record can truthfully say, not
      // whether it gets written. getConsentTrail below is the disclosure,
      // and it still runs only after recordTrailStrict has succeeded.
      const principal = await findPrincipalById({ models, principalId });

      // Fail-closed, and before anything is disclosed: if the access record
      // cannot be written, recordTrailStrict throws 503 and no data goes out
      // on ANY path, including this one, where principal lookup already
      // happened and would otherwise be thrown away unrecorded.
      //
      // outcome and reasonCode say what actually happened, not merely that
      // the surface was used: an operator who reads a real trail gets
      // "recorded"; an operator who probes an id with nothing behind it gets
      // "refused" / "no_match", exactly like the lookup route's miss branch.
      // A row that always said "recorded" would make a probe of a
      // non-existent id indistinguishable, to an auditor, from an actual
      // disclosure of someone's whole lineage.
      await recordTrailStrict(models, {
        principalId,
        kind: "operator_trail_read",
        outcome: principal ? "recorded" : "refused",
        reasonCode: principal ? undefined : "no_match",
        actor: req.actor,
        caseRef,
      });

      // The 404 is thrown AFTER the record, not before. An operator who
      // probes an id that does not exist has still used this surface, and a
      // 404 that left no trace would be the one way to use it unrecorded.
      if (!principal) throw new AppError("No data principal found for that id", 404);

      // includeOperatorRefs: this is the back-office view. actor.ref and
      // caseRef are present here and withheld on the data principal's own
      // read, where naming the individual member of staff is not the point -
      // that someone in the back office looked, is.
      res.status(200).json(await getConsentTrail({ models, principalId, includeOperatorRefs: true }));
    })
  );

  // The same three-branch mapper createRouter uses, registered LAST. It is
  // shared rather than duplicated: a security-relevant response shape
  // maintained twice drifts. recordTrailStrict's AppError(..., 503) lands in
  // its third branch, which keeps the status and withholds the message.
  router.use(errorMapper);

  return router;
}

module.exports = createBackOfficeRouter;
