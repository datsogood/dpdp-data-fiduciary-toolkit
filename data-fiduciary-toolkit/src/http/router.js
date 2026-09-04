const express = require("express");

const { buildModels } = require("../models");
const { assertConfigured } = require("../config/catalog");
const { AppError } = require("../utils/errors");
const { findPrincipalByContact, findPrincipalById, lookupHash } = require("../utils/principalId");
const persistPIIwithconsent = require("../services/persistPIIwithconsent");
const withdrawConsent = require("../services/withdrawConsent");
const { getConsentState } = require("../services/consentState");
const { buildNotice, DEFAULT_NOTICE_LANGUAGE } = require("../config/notice");
const { listRights, exerciseRight, listRightsRequests, getRightsRequest } = require("../services/dataPrincipalRights");
const { complaintToTheBoard, escalateToBoard, listGrievances, getGrievance } = require("../services/complaintToTheBoard");
const consentManagerRequest = require("../services/consentManagerRequest");
const { listConsentManagerRequests } = consentManagerRequest;
const { getConsentTrail, recordTrail } = require("../services/consentTrail");
const {
  escapeHtml,
  renderRightsPage,
  renderGrievanceForm,
  renderConsentManagerForm,
  renderConsentPage,
  renderConsentReceipt,
  renderWithdrawalPage,
  renderWithdrawalReceipt,
} = require("./forms");
const { wantsHtml } = require("./negotiate");
const { wrap, errorMapper, makeCheckOrigin } = require("./shared");

/**
 * An HTML checkbox group sends one value as a string and two as an array, so a
 * single ticked box would otherwise fail array validation.
 */
function asArray(value) {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * The consent form always posts a hidden consentSubmitted=1, so an
 * all-unchecked submission is a real decision ("decline everything") rather
 * than being mistaken for a PII-only update that touches no consent.
 */
function readConsentTypes(body) {
  const types = asArray(body.consentTypes);
  if (types !== undefined) return types;
  return body.consentSubmitted ? [] : undefined;
}

/**
 * Accepts both wire shapes: nested { pii: {...} } from JSON API clients and
 * flat top-level fields from an HTML form. Never spreads req.body wholesale
 * into pii - that would let a caller inject arbitrary schema paths.
 */
function readPii(body) {
  if (body.pii && typeof body.pii === "object") return body.pii;
  const { name, email, phone, dob, pan, address } = body;
  const pii = { name, email, phone, dob, pan, address };
  for (const k of Object.keys(pii)) if (pii[k] === undefined) delete pii[k];
  return pii;
}

/**
 * A form checkbox arrives as the string "on"; a JSON client sends a real
 * boolean. Without this, urlencoded's "false" would be truthy and a form
 * could never express "no".
 */
function isTrue(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

/**
 * Who a principal-facing trail row is attributed to. Identity itself still
 * comes only from resolvePrincipal - this says nothing about WHO, only that
 * the actor is the data principal and which surface they reached us on. The
 * channel matters because an HTML refusal and an API refusal are different
 * failures to answer for: one was read by a person on a page.
 */
const principalActor = (req) => ({ role: "principal", channel: wantsHtml(req) ? "html" : "api" });

/**
 * @param {object}   opts
 * @param {object}   opts.db                - the connection returned by connect(). Required.
 * @param {Function} [opts.resolvePrincipal] - (req) => principalId | Promise<principalId>.
 *   The host application's session lookup. Required for every mutating route
 *   except signup; without it they all deny, so a misconfigured deployment
 *   fails closed.
 * @param {Function} [opts.onWithdrawal]    - called by withdrawConsent when something
 *   was actually withdrawn. A throw here DOES fail the request: this hook is how
 *   the host learns it must cease processing and erase, and a host whose pipeline
 *   is down needs to know rather than have the failure swallowed.
 * @param {Function} [opts.onGrievanceFiled] - called after a grievance is persisted.
 *   A throw here is logged and does NOT fail the request - the grievance is
 *   already filed, and failing the response would cost the principal their refId
 *   and produce a duplicate filing. Notification is not the filing.
 * @param {string[]} [opts.allowedOrigins] - ADDITIONAL origins permitted to
 *   make a state-changing request. The host the request arrived on is always
 *   allowed; this list is a union with it, never a replacement, so naming a
 *   partner origin cannot silently stop your own forms working. Needed when
 *   the browser origin and the `Host` this router sees differ - a reverse
 *   proxy that rewrites `Host`, or a front end served from a separate origin.
 *   Entries may be full origins ("https://app.example") or bare hosts
 *   ("app.example", "localhost:3000").
 */
function createRouter({ db, resolvePrincipal, onWithdrawal, onGrievanceFiled, allowedOrigins = [] } = {}) {
  if (!db || typeof db.model !== "function") {
    throw new Error("db is required - pass the connection returned by connect()");
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((o) => typeof o !== "string")) {
    throw new Error("allowedOrigins must be an array of origin strings, e.g. [\"https://app.example\"]");
  }
  // Before any route is built, so a deployment carrying a placeholder DPO
  // address or a NaN SLA fails at boot rather than in front of a data
  // principal who is trying to complain.
  assertConfigured();
  const models = buildModels(db);

  const router = express.Router();
  // FIRST, ahead of the body parsers and of requireAuth. There is no reason to
  // parse up to 100kb of a request that is about to be refused, and a forged
  // request should never reach the session lookup at all.
  router.use(makeCheckOrigin(allowedOrigins));
  router.use(express.json({ limit: "100kb" }));
  // extended:true is what let a cross-origin form build principalId[$ne].
  // extended:false produces only string values, removing that delivery path.
  router.use(express.urlencoded({ extended: false, limit: "100kb" }));

  /**
   * requireAuth's own 401, negotiated like the error mapper's three branches
   * below. GET /consent/new is the one deliberately unauthenticated page, and
   * it links to /consent/withdraw - which sits behind requireAuth - so a
   * signed-out visitor who clicks that link reaches this function with
   * Accept: text/html. JSON-only here left them with a raw
   * `{"error":"authentication required"}` body and nothing to act on: the
   * same shape of defect as a rendered page dead-ending in a machine-readable
   * error. Links back to the one page reachable with no session at all, so
   * they are not stranded.
   */
  function sendAuthRequired(req, res) {
    if (wantsHtml(req)) {
      const signInUrl = escapeHtml(`${req.baseUrl}/consent/new`);
      return res
        .status(401)
        .type("html")
        .send(`<p>You need to sign in to reach this page. <a href="${signInUrl}">Return to notice and consent</a>.</p>`);
    }
    res.status(401).json({ error: "authentication required" });
  }

  /**
   * Identity comes only from the host application. principalId is never read
   * from the request body: it is a database key, not a credential, and an
   * earlier version let anyone who knew a data principal's email act as them.
   *
   * With no resolvePrincipal configured every mutating route denies, so a
   * misconfigured deployment fails closed rather than open.
   *
   * The hook may be sync or async - resolving a session to a principal is
   * usually a database lookup, and a non-awaited Promise would fail the string
   * check and 401 every request with nothing to explain why.
   */
  async function requireAuth(req, res, next) {
    if (typeof resolvePrincipal !== "function") {
      return sendAuthRequired(req, res);
    }
    let id;
    try {
      id = await resolvePrincipal(req);
    } catch {
      return sendAuthRequired(req, res);
    }
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) {
      return sendAuthRequired(req, res);
    }
    req.principalId = id;
    next();
  }

  /**
   * Applied to every GET below that returns principal-identifying data. These
   * are the first cacheable responses in the toolkit that carry personal data
   * - every pre-existing PII route is POST or PUT, and neither is cacheable by
   * default. GET /consent in particular returns name, email, phone, dob, PAN
   * and address on a URL with no user-identifying component, distinguished
   * only by the host's session cookie: a shared cache or CDN in front of the
   * host, or a browser's disk or back-forward cache on a shared machine, could
   * otherwise serve one principal's response to the next. GET /consent/trail
   * is worse still: it is the whole lineage of one person on the same
   * undistinguished URL.
   *
   * The number of routes is deliberately not stated. It said "six" while the
   * code had seven, and a count in a comment drifts every time a read route is
   * added.
   */
  function noStore(req, res, next) {
    res.set("Cache-Control", "no-store");
    res.set("Vary", "Cookie");
    next();
  }

  /**
   * The contact fields supplied that are NOT the signed-in principal's own, or
   * null when everything matches.
   *
   * persistPIIwithconsent resolves a principal through findOrCreatePrincipal,
   * i.e. by contact hash. Passing a caller-supplied email into it would let any
   * authenticated principal overwrite a DIFFERENT person's PII and ledger - C1
   * again, merely requiring an account. Comparing against the session
   * principal's own stored hash refuses that without a lookup, so it also adds
   * no way to probe which addresses are registered.
   *
   * It returns rather than throwing, and is named for what it returns, because
   * the refusal now also writes a trail entry and that write is asynchronous.
   * Making an assert-named helper async would leave a synchronous call site
   * calling it without await, and a returned promise is truthy but never
   * throws: the 403 would silently stop happening, the write would land on the
   * victim, and the unhandled rejection would take the process down on every
   * mismatched request. Keeping the check synchronous and moving both the
   * write and the throw into the async handler makes that mistake unavailable.
   */
  function ownContactMismatch(principal, pii) {
    const fields = [];
    if (pii.email && lookupHash(pii.email) !== principal.emailHash) fields.push("email");
    if (pii.phone && lookupHash(pii.phone) !== principal.phoneHash) fields.push("phone");
    return fields.length ? fields : null;
  }

  // ---------------------------------------------------------------------------
  // Consent
  // ---------------------------------------------------------------------------

  /**
   * Public: the notice and consent capture page. This is the ONLY page in the
   * toolkit that does not require a principalId to reach, because giving
   * consent for the first time is how a principalId comes to exist at all -
   * every other rendered form now gets identity from the session instead of
   * asking for it.
   */
  router.get("/consent/new", (req, res) => {
    const notice = buildNotice({ language: req.query.lang || DEFAULT_NOTICE_LANGUAGE });
    res.type("html").send(renderConsentPage({ basePath: req.baseUrl, notice }));
  });

  /**
   * SIGNUP ONLY, and deliberately unauthenticated - a person has no account
   * until this succeeds, so requiring one would make the toolkit unusable.
   *
   * The existence check therefore runs BEFORE any write. Deciding afterwards by
   * reading persistPIIwithconsent's `created` flag would return the same 409
   * with the existing principal's name, phone, PAN and address already
   * overwritten and consent events already appended to an append-only ledger -
   * the whole of the C1 attack, behind a response that looks like a refusal.
   */
  router.post(
    "/consent",
    wrap(async (req, res) => {
      const pii = readPii(req.body);
      // EMAIL ONLY, matching findOrCreatePrincipal's own matching rule - the
      // two must agree or this route 409s people the service would have
      // treated as new. Passing the phone too used to 409 the second
      // phone-only member of a household sharing one handset, which is
      // precisely the population this toolkit names as its audience, and left
      // them with no way to register at all.
      const existing = await findPrincipalByContact({ models, email: pii.email });
      if (existing) {
        throw new AppError("principal already exists - sign in to change your consent", 409);
      }
      const notice = buildNotice({ language: req.query.lang || DEFAULT_NOTICE_LANGUAGE });
      const result = await persistPIIwithconsent({
        models, pii, consentTypes: readConsentTypes(req.body), notice, actor: principalActor(req),
      });
      // The receipt page is how a browser user obtains their principalId at
      // all - it is otherwise only ever returned in a JSON body, which is
      // unusable to someone without API access. no-store: the page displays
      // the identifier itself in a field the user is invited to copy, the
      // same reasoning that puts no-store on GET /consent below.
      if (wantsHtml(req)) {
        res.set("Cache-Control", "no-store");
        res.set("Vary", "Cookie");
        return res.status(201).type("html").send(renderConsentReceipt({ basePath: req.baseUrl, result }));
      }
      res.status(201).json(result);
    })
  );

  /**
   * AUTHENTICATED consent update. The principal is loaded by req.principalId
   * and the PII handed to the service is the STORED record, never the payload,
   * so there is no contact detail a caller can supply that redirects the write
   * at another person. Correcting contact details is a separate operation.
   */
  router.put(
    "/consent",
    requireAuth,
    wrap(async (req, res) => {
      const principal = await findPrincipalById({ models, principalId: req.principalId });
      if (!principal) throw new AppError("No principal found for that id", 404);
      // Erasure is terminal - see updatePrincipalContact. Without this an
      // erased record would fail later with a confusing message about a
      // missing name rather than saying what actually happened.
      if (principal.erasedAt) {
        // Recorded before the throw. Erasure is terminal, so this refusal is
        // the last thing that will ever happen on this record, and it is
        // thrown before any write - nothing else keeps it.
        await recordTrail(models, {
          principalId: req.principalId,
          kind: "consent_refused",
          outcome: "refused",
          reasonCode: "record_erased",
          actor: principalActor(req),
        });
        throw new AppError("This data principal's record has been erased and cannot be updated", 409);
      }
      const mismatched = ownContactMismatch(principal, readPii(req.body));
      if (mismatched) {
        // Awaited, and before the throw. recordTrail is fail-open and never
        // rejects, so this cannot turn a 403 the caller needs to read into a
        // 500. Only the NUMBER of mismatched fields is stored: the trail holds
        // no contact detail, and which field it was does not make the refusal
        // any more accountable.
        await recordTrail(models, {
          principalId: req.principalId,
          kind: "contact_mismatch_refused",
          outcome: "refused",
          reasonCode: "not_own_contact",
          // principalActor is already at module scope - Task 3 put it there
          // for exactly this. Re-inlining the object literal would give this
          // file two definitions of what a principal actor is, and the one
          // that drifted would be whichever a later reader did not open.
          actor: principalActor(req),
          count: mismatched.length,
        });
        throw new AppError(
          "The contact details supplied do not belong to the signed-in data principal. Use the correction route to change them.",
          403
        );
      }

      const notice = buildNotice({ language: req.query.lang || DEFAULT_NOTICE_LANGUAGE });
      const result = await persistPIIwithconsent({
        models,
        // Identity is passed explicitly. Without it the service re-derives it
        // from pii by contact hash, which on an authenticated update is both
        // ambiguous (phoneHash is non-unique) and, after a PRINCIPAL_ID_SECRET
        // rotation, capable of minting a NEW principal from a stale hash.
        principalId: req.principalId,
        pii: principal.pii.toObject(),
        consentTypes: readConsentTypes(req.body),
        regrant: isTrue(req.body.regrant),
        notice,
        actor: principalActor(req),
      });
      res.status(200).json(result);
    })
  );

  /**
   * Withdrawal. PUT is for API clients; POST exists because an HTML form
   * cannot issue PUT, and without it the withdrawal page has nothing to
   * submit to.
   *
   * asArray rather than readConsentTypes: a withdrawal naming no purpose is an
   * error, not a decline, and the service already answers it with a 400.
   */
  const withdraw = wrap(async (req, res) => {
    const result = await withdrawConsent({
      models,
      principalId: req.principalId,
      consentTypes: asArray(req.body.consentTypes),
      onWithdrawal,
      // The service defaults to UNATTRIBUTED, which is the honest answer for a
      // direct library call and the wrong one here: this request arrived with a
      // session, on a surface we can name. Same helper as every other
      // principal-facing site in this file.
      actor: principalActor(req),
    });
    // Same reasoning as the consent receipt above: withdrawal must be as easy
    // as granting, so a browser gets a page, not a JSON blob, and the same
    // no-store treatment - this response reveals which purposes are now
    // withdrawn, exactly the kind of principal-identifying state GET
    // /consent and GET /consent/withdraw are already never cached.
    if (wantsHtml(req)) {
      res.set("Cache-Control", "no-store");
      res.set("Vary", "Cookie");
      return res.status(200).type("html").send(renderWithdrawalReceipt({ basePath: req.baseUrl, result }));
    }
    res.status(200).json(result);
  });
  router.put("/consent/withdraw", requireAuth, withdraw);
  router.post("/consent/withdraw", requireAuth, withdraw);

  /**
   * Authenticated: the withdrawal page, listing only currently-granted,
   * withdrawable purposes - given the same prominence as consenting, per
   * Rule 3(c)(i). Carries PII-adjacent state (which purposes are granted),
   * so it gets the same no-store treatment as GET /consent below.
   */
  router.get(
    "/consent/withdraw",
    requireAuth,
    noStore,
    wrap(async (req, res) => {
      const { state } = await getConsentState({ models, principalId: req.principalId });
      res.type("html").send(renderWithdrawalPage({ basePath: req.baseUrl, state }));
    })
  );

  /**
   * The Section 11 right of access: the full event ledger, not just current
   * state, plus the PII on file - unless the principal has been erased, in
   * which case pii is null and erasedAt says when. Scoped to req.principalId
   * only, so this can never read another principal's ledger.
   */
  router.get(
    "/consent",
    requireAuth,
    noStore,
    wrap(async (req, res) => {
      const result = await getConsentState({ models, principalId: req.principalId });
      res.status(200).json(result);
    })
  );

  /**
   * The Section 11 lineage view, and the headline of the audit-trail feature.
   * Merges what the toolkit recorded about this principal with the events it
   * can derive from the primary collections, newest first. Scoped to
   * req.principalId only, so this can never read another principal's trail.
   *
   * includeOperatorRefs: false withholds actor.ref and caseRef. This read
   * deliberately DOES include the back-office access rows, so a data principal
   * can see that their record was looked at - but who looked is the adopter's
   * own employee's personal data, retained under the adopter's employment
   * basis, and the ticket reference is the adopter's internal case data.
   * Neither is the data principal's to receive.
   *
   * The read itself is not recorded. Logging a principal's own access would
   * make the right of access a write path and change its cost profile.
   */
  router.get(
    "/consent/trail",
    requireAuth,
    noStore,
    wrap(async (req, res) => {
      const result = await getConsentTrail({
        models,
        principalId: req.principalId,
        includeOperatorRefs: false,
      });
      res.status(200).json(result);
    })
  );

  // ---------------------------------------------------------------------------
  // Data principal rights - Chapter III
  // ---------------------------------------------------------------------------

  // Public: the catalog is static information about rights everyone holds.
  router.get("/rights", (req, res) => {
    if (wantsHtml(req)) return res.type("html").send(renderRightsPage({ basePath: req.baseUrl }));
    res.json(listRights());
  });

  router.post(
    "/rights/exercise",
    requireAuth,
    wrap(async (req, res) => {
      const result = await exerciseRight({
        models,
        principalId: req.principalId,
        right: req.body.right,
        details: req.body.details,
      });
      // Same status either way - a browser is not a reason to report 200 for
      // something that was created.
      if (wantsHtml(req)) {
        return res
          .status(201)
          .type("html")
          .send(`<p>Request received. Reference: <b>${escapeHtml(result.refId)}</b></p>`);
      }
      res.status(201).json(result);
    })
  );

  // Every rights request the session principal has filed, and one by refId -
  // both scoped to req.principalId only.
  router.get(
    "/rights/requests",
    requireAuth,
    noStore,
    wrap(async (req, res) => {
      res.status(200).json(await listRightsRequests({ models, principalId: req.principalId }));
    })
  );

  router.get(
    "/rights/requests/:refId",
    requireAuth,
    noStore,
    wrap(async (req, res) => {
      res.status(200).json(await getRightsRequest({ models, principalId: req.principalId, refId: req.params.refId }));
    })
  );

  // ---------------------------------------------------------------------------
  // Grievance redressal - Section 13
  // ---------------------------------------------------------------------------

  // Public: the form itself reveals nothing.
  router.get("/grievance/new", (req, res) => res.type("html").send(renderGrievanceForm({ basePath: req.baseUrl })));

  router.post(
    "/grievance",
    requireAuth,
    wrap(async (req, res) => {
      const result = await complaintToTheBoard({
        models,
        principalId: req.principalId,
        subject: req.body.subject,
        description: req.body.description,
      });
      // The grievance is already persisted. A throwing host callback must not
      // turn that into a 500, because the principal would never learn their
      // refId and would re-file, creating a duplicate grievance for the
      // Grievance Officer to reconcile. Notification is not the filing.
      if (typeof onGrievanceFiled === "function") {
        try {
          await onGrievanceFiled({ principalId: req.principalId, ...result });
        } catch (hookErr) {
          console.error("[dpdp-toolkit] onGrievanceFiled threw after the grievance was filed:", hookErr);
        }
      }
      // "Recorded", not "sent": this package has no outbound channel, and
      // telling a data principal their complaint was delivered when it was
      // only written to a collection is the same false assurance H7 names.
      if (wantsHtml(req)) {
        return res
          .status(201)
          .type("html")
          .send(
            `<p>Recorded for ${escapeHtml(result.addressedTo)}. Reference: <b>${escapeHtml(result.refId)}</b>. ` +
              `Due for resolution by ${escapeHtml(result.slaDueAt.toISOString().slice(0, 10))}.</p>`
          );
      }
      res.status(201).json(result);
    })
  );

  router.post(
    "/grievance/:refId/escalate",
    requireAuth,
    wrap(async (req, res) => {
      const result = await escalateToBoard({
        models,
        refId: req.params.refId,
        principalId: req.principalId,
        actor: principalActor(req),
      });
      res.status(200).json(result);
    })
  );

  // Every grievance the session principal has filed, and one by refId - both
  // scoped to req.principalId only.
  router.get(
    "/grievances",
    requireAuth,
    noStore,
    wrap(async (req, res) => {
      res.status(200).json(await listGrievances({ models, principalId: req.principalId }));
    })
  );

  router.get(
    "/grievances/:refId",
    requireAuth,
    noStore,
    wrap(async (req, res) => {
      res.status(200).json(await getGrievance({ models, principalId: req.principalId, refId: req.params.refId }));
    })
  );

  // ---------------------------------------------------------------------------
  // Consent Manager handoff - Section 6(7)-(9)
  // ---------------------------------------------------------------------------

  // Public: the form itself reveals nothing.
  router.get("/consent-manager/new", (req, res) =>
    res.type("html").send(renderConsentManagerForm({ basePath: req.baseUrl }))
  );

  router.post(
    "/consent-manager",
    requireAuth,
    wrap(async (req, res) => {
      const result = await consentManagerRequest({
        models,
        principalId: req.principalId,
        message: req.body.message,
        preferredConsentManager: req.body.preferredConsentManager,
      });
      if (wantsHtml(req)) {
        return res
          .status(201)
          .type("html")
          .send(`<p>Request received. Reference: <b>${escapeHtml(result.refId)}</b></p>`);
      }
      res.status(201).json(result);
    })
  );

  // Every consent-manager request the session principal has filed - scoped
  // to req.principalId only.
  router.get(
    "/consent-manager/requests",
    requireAuth,
    noStore,
    wrap(async (req, res) => {
      res.status(200).json(await listConsentManagerRequests({ models, principalId: req.principalId }));
    })
  );

  // ---------------------------------------------------------------------------
  // One error mapper, registered LAST. It lives in ./shared because the
  // back-office router needs the identical three branches, and two copies of an
  // error mapper drift - the half that drifts being the half that decides which
  // internal detail reaches a caller.
  // ---------------------------------------------------------------------------
  router.use(errorMapper);

  return router;
}

module.exports = createRouter;
