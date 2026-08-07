# Task 5 brief

Extracted from `docs/superpowers/plans/2026-08-07-dpdp-audit-remediation/plan.md`. Do not edit - regenerate if the plan changes.

## Global Constraints

These bind this task even where its steps do not repeat them.

- **Writing style:** always use a hyphen ( - ). Never an em dash or en dash. Applies to all code comments, prose, docs, and commit messages.
- **Statute citations:** the Act is the **Digital Personal Data Protection Act, 2023**. Never write "DPDP Act, 2025". The DPDP Rules, 2025 are a separate instrument and must be cited by their own name where referenced.
- **License:** `Apache-2.0`. The root `LICENSE` file (Apache 2.0) is authoritative; `package.json` must declare `"license": "Apache-2.0"`.
- **No secrets in source:** every org-specific value comes from an env var with a documented default. A placeholder default that would be shown to a data principal must fail startup instead.
- **`principalId` is never read from `req.body` or `req.query` on any route.** It comes only from `resolvePrincipal(req)`. Services still accept it as a parameter so they stay framework-agnostic.
- **Every value that reaches a Mongoose query filter must be validated as a primitive first.** Per-field validation in `src/utils/validate.js` is the primary control. `sanitizeFilter` is defence in depth and **must be set on the library's own connection only** - `connection.set("sanitizeFilter", true)`. **Never `mongoose.set("sanitizeFilter", true)`**: verified against mongoose 8.24 by executing real queries, that global setting makes a host application's own `Model.find({ age: { $gt: 5 } })` throw `CastError`, which is precisely the global-singleton hijack H8 exists to eliminate. Also verified: per-query `.setOptions({ sanitizeFilter: true })` does **not** sanitize and is silently inert - do not use it.
- **The consent ledger is append-only.** No code path may delete or mutate an existing event. Erasure removes PII from `Principal`, never events from `ConsentRecord`.
- **Test commands:** `npm test` runs the whole suite via bare `node --test` (no path argument). **Verified in this environment (Node v26.3.1): `node --test test/` FAILS** - it treats the positional `test/` as a module to load and reports a phantom failing test regardless of the real suite. Bare `node --test` discovers `test/**/*.test.js` correctly and treats `test/helpers/db.js` as a zero-test file. To run one file, invoke it directly: `node --test test/validate.test.js`. **Never write `npm test -- test/<file>`** - npm appends the argument, producing the broken two-path form. Every task that changes behaviour ships tests in the same commit.
- **Commit style:** conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`). Every commit message body ends with the two trailer lines used in this repo:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K
  ```
- **Working directory:** all paths below are relative to `data-fiduciary-toolkit/` unless prefixed with `repo-root:`.
- **Finding IDs** (`C1`, `H5`, `M12`, `L3` ...) refer to [`spec.md`](spec.md) beside this plan. Every task lists the findings it closes; a task is not complete until each listed finding is actually addressed.

---

### Task 5: Authentication hook, default-deny

**Closes:** C1 (authorisation half), M8

**Files:**
- Rewrite: `src/http/router.js`
- Create: `test/auth.test.js`
- Modify: `src/services/complaintToTheBoard.js` (ownership check on escalate)

**Interfaces:**
- Consumes: `buildModels` (T3), `findOrCreatePrincipal` (T4).
- Produces:
  - `createRouter({ db, resolvePrincipal, onWithdrawal, onGrievanceFiled })`. `db` is required. `resolvePrincipal` is required for every mutating route except the signup path.
  - `escalateToBoard({ models, refId, principalId })` - `principalId` now required and compared against the grievance.

**Design rule to implement exactly:**

| Route | Auth |
| --- | --- |
| `POST /consent` | **Signup only.** Call `findPrincipalByContact` FIRST, before any write. If it returns a principal, respond `409 { error: "principal already exists - sign in to change your consent" }` and write nothing. If it returns null, proceed with `persistPIIwithconsent`. |
| `PUT /consent` | **Authenticated consent update.** Takes `consentTypes` and optional `regrant`. Loads the principal by `req.principalId` ONLY - never by supplied contact details. Ignores any `pii.email`/`pii.phone` that hashes to a different principal, rejecting with `403`. |
| `PUT /consent/withdraw` **and** `POST /consent/withdraw` | Same handler, both methods. `PUT` is for API clients; `POST` exists because an HTML form cannot issue `PUT`, and without it the T13 withdrawal page has nothing to submit to. |
| `POST /rights/exercise`, `POST /grievance`, `POST /grievance/:refId/escalate`, `POST /consent-manager`, and every `GET` read route from T10 | `resolvePrincipal(req)` must return a valid principalId, else `401`. |
| `GET /rights`, `GET /grievance/new`, `GET /consent-manager/new`, `GET /consent/new` | Public - static informational pages. |
| `GET /consent`, `GET /consent/withdraw` | Authenticated. |

**Two things the 409 rule must get right, both of which are C1 reopening if missed:**

1. **Check before you write.** The existence check happens *before* `persistPIIwithconsent` is called. Reading `result.created` afterwards is too late: by then the existing principal's `pii` has already been overwritten and consent delta events already appended. There must be a test asserting the stored PII and the ledger are unchanged after a 409.
2. **The authenticated update path resolves identity from the session, not the payload.** `persistPIIwithconsent` finds the principal via `findOrCreatePrincipal({ pii })`, i.e. by contact hash. If `PUT /consent` passed a caller-supplied email through to it, any authenticated principal could submit a *different* person's email and overwrite that person's PII and ledger - the C1 attack again, merely requiring any account. So `PUT /consent` must load by `req.principalId` and, if supplied contact details resolve to a different principal, return `403`.

- [ ] **Step 1: Write the failing test `test/auth.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
const createRouter = require("../src/http/router");

/** Boots an app with the given options and returns a fetch helper. */
async function app(conn, opts = {}) {
  const a = express();
  a.use("/dpdp", createRouter({ db: conn, ...opts }));
  const server = a.listen(0);
  const port = server.address().port;
  return {
    call: (method, path, body, headers = {}) =>
      fetch(`http://localhost:${port}/dpdp${path}`, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test("createRouter requires a db handle", () => {
  assert.throws(() => createRouter({}), /db is required/);
});

test("every mutating route is 401 when no resolvePrincipal is supplied", async () => {
  await withDb(async (conn) => {
    const { call, close } = await app(conn);
    try {
      const cases = [
        ["PUT", "/consent/withdraw", { consentTypes: ["marketing"] }],
        ["POST", "/rights/exercise", { right: "erasure" }],
        ["POST", "/grievance", { subject: "s", description: "d" }],
        ["POST", "/consent-manager", { message: "m" }],
        ["POST", "/grievance/GR-ABC/escalate", {}],
      ];
      for (const [method, path, body] of cases) {
        const res = await call(method, path, body);
        assert.equal(res.status, 401, `${method} ${path} must be 401 without auth`);
        assert.equal((await res.json()).error, "authentication required");
      }
    } finally {
      await close();
    }
  });
});

test("principalId in the request body is ignored - it never grants access", async () => {
  await withDb(async (conn) => {
    const victim = "c".repeat(64);
    const { call, close } = await app(conn, { resolvePrincipal: () => null });
    try {
      const res = await call("PUT", "/consent/withdraw", { principalId: victim, consentTypes: ["marketing"] });
      assert.equal(res.status, 401, "a body-supplied principalId must not authenticate anyone");
    } finally {
      await close();
    }
  });
});

test("POST /consent creates a new principal unauthenticated, but refuses to update an existing one", async () => {
  await withDb(async (conn) => {
    const { call, close } = await app(conn);
    try {
      const first = await call("POST", "/consent", {
        pii: { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" },
        consentTypes: ["marketing"],
      });
      assert.equal(first.status, 201);
      const body = await first.json();
      assert.match(body.principalId, /^[a-f0-9]{64}$/);

      // The attack from C1: overwrite an existing principal's PII with no credential.
      const second = await call("POST", "/consent", {
        pii: { name: "Attacker", email: "asha@example.com", phone: "0000000000", pan: "AAAAA0000A" },
        consentTypes: [],
      });
      assert.equal(second.status, 409, "must not let an unauthenticated caller overwrite existing PII");
    } finally {
      await close();
    }
  });
});

test("escalateToBoard refuses a refId belonging to another principal", async () => {
  await withDb(async (conn) => {
    const { buildModels } = require("../src/models");
    const models = buildModels(conn);
    const owner = "d".repeat(64);
    const other = "e".repeat(64);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({
      principalId: owner, refId: "GR-OWNED", subject: "s", description: "d",
      addressedTo: "DPO", status: "open", slaDueAt: past,
    });

    const { call, close } = await app(conn, { resolvePrincipal: () => other });
    try {
      const res = await call("POST", "/grievance/GR-OWNED/escalate", {});
      assert.equal(res.status, 403, "a different principal must not escalate someone else's grievance");
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test test/auth.test.js`
Expected: FAIL - the current router has no auth at all.

- [ ] **Step 3: Rewrite `src/http/router.js`**

Key structure. The `requireAuth` middleware is the control; no handler reads `req.body.principalId`.

```js
const express = require("express");
const { buildModels } = require("../models");
const { AppError } = require("../utils/errors");
const { assertPrincipalId } = require("../utils/validate");

function createRouter({ db, resolvePrincipal, onWithdrawal, onGrievanceFiled } = {}) {
  if (!db || typeof db.model !== "function") {
    throw new Error("db is required - pass the connection returned by connect()");
  }
  const models = buildModels(db);
  const router = express.Router();
  router.use(express.json({ limit: "100kb" }));
  router.use(express.urlencoded({ extended: false, limit: "100kb" }));

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

  // ... routes, each mutating one wrapped in requireAuth and passing
  // req.principalId (never req.body.principalId) into the service.

  // Error mapper, registered LAST. Replaces the six per-route catch blocks.
  // See Step 3d for the full version and why the branch order matters.
  return router;
}
```

Note `express.urlencoded({ extended: false })` - `extended: true` is what let a cross-origin form build `principalId[$ne]`. `extended: false` produces only string values, removing that delivery path entirely.

- [ ] **Step 3b: Normalise the request body before it reaches any service**

`extended: false` has a consequence the services must not absorb. Verified: `querystring.parse("consentTypes=marketing")` yields the **string** `"marketing"`, and an array only when two or more boxes are ticked. So a data principal who ticks exactly one purpose would hit `assertStringArray`'s `400 consentTypes must be an array of strings`. Worse, unticking *every* box submits no `consentTypes` field at all, which T7 reads as "no consent decision was made" - so a deliberate "I decline everything" would silently record nothing.

Add these two helpers to the router and use them on `POST /consent` and both withdraw methods:

```js
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
```

The `POST /consent` handler therefore reads `const pii = readPii(req.body)` and `const consentTypes = readConsentTypes(req.body)`, and passes those - never `req.body` itself.

- [ ] **Step 3c: Convert the three services' deliberate throws to `AppError`**

`exerciseRight` (`dataPrincipalRights.js:25`), `complaintToTheBoard.js:19-20` and `consentManagerRequest.js:18-19` still `throw new Error(...)`. A plain `Error` has no `.status` and `name === "Error"`, so the Step 6 mapper would send `500 { error: "internal error" }` for every malformed request to those three routes - the mirror image of M6, which this branch exists to fix. Replace each deliberate throw with `new AppError(message, 400)`, or `404` where a lookup misses, and validate their string inputs with `assertNonEmptyString`.

- [ ] **Step 3d: Install the single error mapper (moved here from T12)**

Every handler becomes `async (req, res, next) => { try { ... } catch (err) { next(err); } }`, and this middleware is registered after all routes:

```js
router.use((err, req, res, _next) => {
  // Branch order matters, and each branch closes a specific hole.
  //
  // Previously all six routes did res.status(400).json({ error: err.message }),
  // so a database outage read as a client error and Mongo internals leaked.

  // Mongoose input faults are the CLIENT's fault. CastError included: sending
  // pii.pan as an object or a malformed date produces one, and reporting that
  // as 500 would repeat the bug in the opposite direction. Send the field name,
  // not mongoose's raw text.
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
```

Add two tests for this in `test/auth.test.js`: an `AppError` thrown with status 500 must not echo its message, and a `CastError` must come back as 400.

- [ ] **Step 4: Add the ownership check to `escalateToBoard`**

```js
async function escalateToBoard({ models, refId, principalId } = {}) {
  assertNonEmptyString(refId, "refId", 64);
  assertPrincipalId(principalId);

  const grievance = await models.Grievance.findOne({ refId });
  if (!grievance) throw new AppError("No grievance found with that reference", 404);
  if (grievance.principalId !== principalId) {
    // Do not reveal whether the reference exists for someone else.
    throw new AppError("This grievance does not belong to you", 403);
  }
  ...
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: `test/auth.test.js` 5/5 PASS, everything else still green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: require an injected auth hook, default-deny

Closes the authorisation half of C1, and M8.

No endpoint authenticated anything. principalId was accepted from the
request body, and because it was derived from the email, anyone who knew
a data principal's address could withdraw their consent, file an erasure
demand in their name, overwrite their stored PII, or file a grievance as
them. escalateToBoard took a refId and never checked ownership.

- createRouter({ db, resolvePrincipal }) - the host supplies identity
- with no resolvePrincipal every mutating route returns 401, so a
  misconfigured deployment fails closed
- principalId is never read from a request body on any route
- POST /consent stays open only for creating a new principal; updating an
  existing one requires auth and otherwise returns 409
- escalateToBoard compares the grievance owner and returns 403
- urlencoded parsing drops extended:true, removing the nested-object
  delivery path for operator injection
- request bodies capped at 100kb

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---
