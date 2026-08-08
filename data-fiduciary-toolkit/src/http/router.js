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
const { escapeHtml, renderRightsPage, renderGrievanceForm, renderConsentManagerForm } = require("./forms");
const { wantsHtml } = require("./negotiate");

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

/** Wraps an async handler so a rejection reaches the error mapper below. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
 * @param {string[]} [opts.allowedOrigins] - origins permitted to make a
 *   state-changing request. Default `[]` means "the same host the request
 *   arrived on". Setting it REPLACES that default, so list your own origin too
 *   if you list anything at all. Needed when the browser origin and the
 *   `Host` this router sees differ - a reverse proxy that rewrites `Host`, or
 *   a front end served from a separate origin.
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
  router.use(express.json({ limit: "100kb" }));
  // extended:true is what let a cross-origin form build principalId[$ne].
  // extended:false produces only string values, removing that delivery path.
  router.use(express.urlencoded({ extended: false, limit: "100kb" }));

  /**
   * Same-origin check on state-changing requests.
   *
   * The original audit refuted a CSRF finding, and correctly: with no ambient
   * credential, a cross-site POST conferred nothing an attacker could not
   * already do with curl. resolvePrincipal changed that. Hosts back it with a
   * cookie session, and POST /consent/withdraw exists precisely so an HTML
   * form can reach it - so a cross-site form POST now rides that cookie, and
   * a forged withdrawal writes to an append-only ledger that cannot be undone.
   *
   * Not a substitute for CSRF tokens, which this library cannot issue - it has
   * no session store, by design, which is the whole point of the injected
   * hook. But the Fetch specification requires a browser to send Origin on
   * every request whose method is not GET or HEAD, so rejecting a mismatched
   * one closes the drive-by case. The absence of BOTH headers is treated as
   * same-origin because non-browser clients (curl, server-to-server) send
   * neither and are not the threat here; a browser cannot reach that branch.
   *
   * A referrer policy can reduce Origin to the literal string "null" rather
   * than remove it. That parses as neither a URL nor a host, so it lands in
   * the 403 below - which is right: "null" is evidence of a cross-origin or
   * sandboxed context, not of a same-origin one.
   *
   * Only the host is compared, not the scheme: req.get("host") carries no
   * scheme, and deriving one from req.protocol would depend on the host's
   * trust-proxy setting, which this library does not control.
   *
   * Hosts must still set SameSite=Lax or Strict on their session cookie -
   * see the README. This alone is not enough.
   */
  function checkOrigin(req, res, next) {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.get("origin") || req.get("referer");
    if (!origin) return next();

    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return res.status(403).json({ error: "bad origin" });
    }
    const allowed = allowedOrigins.length
      ? allowedOrigins.some((o) => {
          try {
            return new URL(o).host === host;
          } catch {
            return o === host;
          }
        })
      : host === req.get("host");
    if (!allowed) return res.status(403).json({ error: "cross-origin request refused" });
    next();
  }
  // Before every route, and before requireAuth: a forged request is refused
  // without consulting the session at all.
  router.use(checkOrigin);

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
      return res.status(401).json({ error: "authentication required" });
    }
    let id;
    try {
      id = await resolvePrincipal(req);
    } catch {
      return res.status(401).json({ error: "authentication required" });
    }
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) {
      return res.status(401).json({ error: "authentication required" });
    }
    req.principalId = id;
    next();
  }

  /**
   * These six routes are the first cacheable responses in the toolkit that
   * carry personal data - every pre-existing PII route is POST or PUT, and
   * neither is cacheable by default. GET /consent in particular returns
   * name, email, phone, dob, PAN and address on a URL with no
   * user-identifying component, distinguished only by the host's session
   * cookie: a shared cache or CDN in front of the host, or a browser's disk
   * or back-forward cache on a shared machine, could otherwise serve one
   * principal's response to the next.
   */
  function noStore(req, res, next) {
    res.set("Cache-Control", "no-store");
    res.set("Vary", "Cookie");
    next();
  }

  /**
   * Refuses contact details that are not the signed-in principal's own.
   *
   * persistPIIwithconsent resolves a principal through findOrCreatePrincipal,
   * i.e. by contact hash. Passing a caller-supplied email into it would let any
   * authenticated principal overwrite a DIFFERENT person's PII and ledger - C1
   * again, merely requiring an account. Comparing against the session
   * principal's own stored hash refuses that without a lookup, so it also adds
   * no way to probe which addresses are registered.
   */
  function assertOwnContact(principal, pii) {
    const mismatch =
      (pii.email && lookupHash(pii.email) !== principal.emailHash) ||
      (pii.phone && lookupHash(pii.phone) !== principal.phoneHash);
    if (mismatch) {
      throw new AppError(
        "The contact details supplied do not belong to the signed-in data principal. Use the correction route to change them.",
        403
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Consent
  // ---------------------------------------------------------------------------

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
      const existing = await findPrincipalByContact({ models, email: pii.email, phone: pii.phone });
      if (existing) {
        throw new AppError("principal already exists - sign in to change your consent", 409);
      }
      const notice = buildNotice({ language: req.query.lang || DEFAULT_NOTICE_LANGUAGE });
      const result = await persistPIIwithconsent({
        models, pii, consentTypes: readConsentTypes(req.body), notice,
      });
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
        throw new AppError("This data principal's record has been erased and cannot be updated", 409);
      }
      assertOwnContact(principal, readPii(req.body));

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
    });
    res.status(200).json(result);
  });
  router.put("/consent/withdraw", requireAuth, withdraw);
  router.post("/consent/withdraw", requireAuth, withdraw);

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
  // One error mapper, registered LAST. Replaces the six per-route catch blocks
  // that turned every fault into 400 with a raw internal message.
  // ---------------------------------------------------------------------------
  router.use((err, req, res, _next) => {
    // Branch order matters, and each branch closes a specific hole.

    // Mongoose input faults are the CLIENT's fault. CastError included: sending
    // pii.pan as an object or a malformed date produces one, and reporting that
    // as 500 would repeat the bug in the opposite direction. Send the field
    // name, not mongoose's raw text - that text quotes the offending value back.
    if (err && (err.name === "ValidationError" || err.name === "CastError")) {
      const fields = err.errors ? Object.keys(err.errors).join(", ") : err.path;
      return res.status(400).json({ error: `Invalid value for: ${fields}` });
    }

    // A deliberate AppError below 500 is safe to echo - the message is written
    // for the caller. At or above 500 it is NOT: AppError(..., 500) carries
    // internal configuration detail (utils/principalId.js throws one naming
    // PRINCIPAL_ID_SECRET and how to generate it, and that path is reachable
    // from the unauthenticated POST /consent route).
    if (err && typeof err.status === "number" && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }

    console.error("[dpdp-toolkit] unhandled error:", err);
    res.status(err && typeof err.status === "number" ? err.status : 500).json({ error: "internal error" });
  });

  return router;
}

module.exports = createRouter;
