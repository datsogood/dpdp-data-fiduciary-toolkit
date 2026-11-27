const { escapeHtml } = require("./forms");
const { wantsHtml } = require("./negotiate");

/** Wraps an async handler so a rejection reaches the error mapper below. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * The host of an origin, or null if there isn't one.
 *
 * Returning null for an EMPTY host matters as much as returning null for an
 * unparseable one. `new URL("localhost:3000")` does not throw - it reads
 * "localhost" as a scheme and yields host "" - and so do "file://" and
 * "about:blank". Letting "" through would mean a scheme-less config entry
 * silently never matched anything, while any Origin that also parsed to ""
 * matched it. Both sides collapse "" to null so neither can happen.
 */
function originHost(value) {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/**
 * Builds the same-origin check on state-changing requests for one router.
 *
 * A factory rather than a plain middleware because the check closes over
 * allowedOrigins, and the two routers this library ships are configured
 * separately. It lives here rather than in either router because a security
 * control duplicated across two files drifts, and the half that drifts is the
 * half nobody is looking at.
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
 * Absence is tested as `undefined`, not falsiness, so a present-but-empty
 * `Origin:` is refused rather than read as "no origin at all".
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
function makeCheckOrigin(allowedOrigins) {
  return function checkOrigin(req, res, next) {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const fromOrigin = req.get("origin");
    const origin = fromOrigin !== undefined ? fromOrigin : req.get("referer");
    if (origin === undefined) return next();

    const host = originHost(origin);
    if (!host) return res.status(403).json({ error: "bad origin" });

    // UNION, not replace. Configuring one partner origin must not stop your own
    // forms working - that footgun fails closed in a way an operator would only
    // discover in production, on the withdrawal route, which is the one route a
    // data principal most needs to reach.
    //
    // `originHost(o) || o` is what lets a scheme-less entry ("portal.example",
    // "localhost:3000") be written the way an operator naturally writes it: the
    // parse yields no host, so the raw string is compared against req.get("host"),
    // which carries no scheme either.
    const allowed = host === req.get("host") || allowedOrigins.some((o) => (originHost(o) || o) === host);
    if (!allowed) return res.status(403).json({ error: "cross-origin request refused" });
    next();
  };
}

/**
 * One error mapper, shared by every router this library builds and registered
 * LAST on each. Replaces the six per-route catch blocks that turned every
 * fault into 400 with a raw internal message.
 *
 * The fourth parameter is load-bearing even though it is unused: Express
 * decides a function is an error handler by its arity alone. Drop it and this
 * registers as ordinary middleware, never runs, and every fault falls through
 * to Express's default handler - which returns HTML and, outside production,
 * the stack trace this function exists to withhold.
 */
function errorMapper(err, req, res, _next) {
  // Branch order matters, and each branch closes a specific hole.

  // Mongoose input faults are the CLIENT's fault. CastError included: sending
  // pii.pan as an object or a malformed date produces one, and reporting that
  // as 500 would repeat the bug in the opposite direction. Send the field
  // name, not mongoose's raw text - that text quotes the offending value back.
  if (err && (err.name === "ValidationError" || err.name === "CastError")) {
    const fields = err.errors ? Object.keys(err.errors).join(", ") : err.path;
    const message = `Invalid value for: ${fields}`;
    if (wantsHtml(req)) return res.status(400).type("html").send(`<p>${escapeHtml(message)}</p>`);
    return res.status(400).json({ error: message });
  }

  // A deliberate AppError below 500 is safe to echo - the message is written
  // for the caller. At or above 500 it is NOT: AppError(..., 500) carries
  // internal configuration detail (utils/principalId.js throws one naming
  // PRINCIPAL_ID_SECRET and how to generate it, and that path is reachable
  // from the unauthenticated POST /consent route).
  //
  // A browser gets the same message rendered as HTML rather than a JSON
  // body - a data principal filling in the consent form has no way to read
  // JSON. This is also the answer a minor rejected for want of verifiable
  // parental consent (422, see persistPIIwithconsent) actually sees: the
  // stated reason, not a raw status code they cannot act on.
  if (err && typeof err.status === "number" && err.status < 500) {
    if (wantsHtml(req)) return res.status(err.status).type("html").send(`<p>${escapeHtml(err.message)}</p>`);
    return res.status(err.status).json({ error: err.message });
  }

  console.error("[dpdp-toolkit] unhandled error:", err);
  const status = err && typeof err.status === "number" ? err.status : 500;
  // Same content negotiation as the two branches above, which this branch
  // alone was missing - so a browser user filling in the consent form got a
  // raw JSON body with Content-Type: application/json, on the one branch a
  // misconfigured deployment actually lands them on. The MESSAGE is still
  // withheld for the reason given above; only the rendering changes.
  if (wantsHtml(req)) {
    return res.status(status).type("html").send("<p>Something went wrong at our end. Please try again later.</p>");
  }
  res.status(status).json({ error: "internal error" });
}

module.exports = { wrap, errorMapper, makeCheckOrigin };
