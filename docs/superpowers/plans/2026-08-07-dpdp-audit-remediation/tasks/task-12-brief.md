# Task 12 brief

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

### Task 12: HTTP layer - negotiation, errors, config validation, hooks

**Closes:** H5, H7, M1, M2, M6, M11, L2

**Files:**
- Create: `src/http/negotiate.js`
- Modify: `src/http/router.js`, `src/http/forms.js`, `src/config/catalog.js`
- Create: `test/http.test.js`

**Interfaces:**
- Produces:
  - `wantsHtml(req)` - `req.accepts(["json", "html"]) === "html"`.
  - Form renderers take `{ basePath }` and build actions from it.
  - `assertConfigured()` in `catalog.js`, called by `createRouter`, throwing on a placeholder DPO email or a non-numeric SLA.
  - `onGrievanceFiled` hook, and reworded response copy.

- [ ] **Step 1: Write the failing test `test/http.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";

const { buildModels } = require("../src/models");
const createRouter = require("../src/http/router");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };

async function boot(conn, basePath = "/dpdp") {
  const models = buildModels(conn);
  const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
  const app = express();
  app.use(basePath, createRouter({ db: conn, resolvePrincipal: () => principalId }));
  const server = app.listen(0);
  const port = server.address().port;
  return {
    principalId,
    call: (method, p, body, headers = {}) =>
      fetch(`http://localhost:${port}${basePath}${p}`, {
        method, headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test("a default API client (Accept: */*) gets 201 JSON, not 200 HTML", async () => {
  await withDb(async (conn) => {
    const { call, close } = await boot(conn);
    try {
      // fetch sends Accept: */* by default - exactly what curl does.
      const res = await call("POST", "/rights/exercise", { right: "erasure", details: "close my account" });
      assert.equal(res.status, 201, "*/* must not be treated as a browser asking for HTML");
      assert.match(res.headers.get("content-type"), /application\/json/);
      const body = await res.json();
      assert.match(body.refId, /^RQ-/);
      assert.equal(body.status, "received");
      assert.ok(body.contact.dpoEmail, "the DPO contact must be in the response");
    } finally {
      await close();
    }
  });
});

test("a browser (Accept: text/html) still gets HTML", async () => {
  await withDb(async (conn) => {
    const { call, close } = await boot(conn);
    try {
      const res = await call("POST", "/rights/exercise", { right: "access" }, { Accept: "text/html" });
      assert.match(res.headers.get("content-type"), /text\/html/);
    } finally {
      await close();
    }
  });
});

test("forms work when the router is mounted somewhere other than /", async () => {
  await withDb(async (conn) => {
    const { call, close } = await boot(conn, "/compliance/dpdp");
    try {
      const res = await call("GET", "/rights", undefined, { Accept: "text/html" });
      const html = await res.text();
      assert.match(html, /action="\/compliance\/dpdp\/rights\/exercise"/,
        "hardcoded absolute actions 404 whenever the router is not mounted at /");
    } finally {
      await close();
    }
  });
});

test("an internal fault is 500 with a generic body, not 400 with the raw message", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: [] });
    const app = express();
    app.use("/dpdp", createRouter({
      db: conn,
      resolvePrincipal: () => principalId,
      // Force an internal fault from inside a handler.
      onGrievanceFiled: () => { throw new Error("SECRET internal detail"); },
    }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/grievance`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ subject: "s", description: "d" }),
      });
      assert.equal(res.status, 500, "an internal fault must not be reported as a client error");
      const body = await res.json();
      assert.doesNotMatch(JSON.stringify(body), /SECRET internal detail/, "internal messages must not leak");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("a validation error is still 400 with a useful message", async () => {
  await withDb(async (conn) => {
    const { call, close } = await boot(conn);
    try {
      const res = await call("POST", "/rights/exercise", { right: "not-a-right" }, { Accept: "application/json" });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /unknown right/i);
    } finally {
      await close();
    }
  });
});

test("createRouter refuses to start with a placeholder DPO contact", async () => {
  await withDb(async (conn) => {
    const saved = process.env.FIDUCIARY_DPO_EMAIL;
    try {
      // catalog.js reads env at import, so re-require it fresh.
      delete require.cache[require.resolve("../src/config/catalog")];
      delete require.cache[require.resolve("../src/http/router")];
      process.env.FIDUCIARY_DPO_EMAIL = "dpo@example.com";
      const freshRouter = require("../src/http/router");
      assert.throws(() => freshRouter({ db: conn, resolvePrincipal: () => null }), /FIDUCIARY_DPO_EMAIL/);
    } finally {
      process.env.FIDUCIARY_DPO_EMAIL = saved;
      delete require.cache[require.resolve("../src/config/catalog")];
      delete require.cache[require.resolve("../src/http/router")];
    }
  });
});

test("the grievance response does not claim delivery the toolkit cannot perform", async () => {
  await withDb(async (conn) => {
    const { call, close } = await boot(conn);
    try {
      const res = await call("POST", "/grievance", { subject: "Unwanted calls", description: "..." }, { Accept: "application/json" });
      const body = await res.json();
      assert.doesNotMatch(body.note, /has been sent/i,
        "nothing is sent - the toolkit has no outbound channel, so it must not say it was");
      assert.match(body.note, /recorded/i);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test test/http.test.js`
Expected: FAIL on negotiation, mount path, error mapping, config guard, and copy.

- [ ] **Step 3: Write `src/http/negotiate.js`**

```js
/**
 * True when the client actually prefers HTML.
 *
 * req.accepts("html") is the trap: it returns "html" for Accept: */* - the
 * default curl and fetch send - and for a missing Accept header, so every
 * JSON API client was served an HTML fragment with the wrong status code.
 * Listing json first makes it win the wildcard tie-break.
 */
function wantsHtml(req) {
  return req.accepts(["json", "html"]) === "html";
}

module.exports = { wantsHtml };
```

- [ ] **Step 4: Add `assertConfigured()` to `catalog.js` (M11, L2)**

```js
const PLACEHOLDER_EMAILS = ["dpo@example.com", ""];

/**
 * Fails fast on configuration that would be shown to a data principal.
 * A grievance page telling people to contact dpo@example.com fails the duty
 * to publish valid Grievance Officer contact details while looking like it
 * satisfies it - so this is a startup error, not a warning.
 */
function assertConfigured() {
  if (PLACEHOLDER_EMAILS.includes(FIDUCIARY.dpoEmail)) {
    throw new Error(
      "FIDUCIARY_DPO_EMAIL is unset or still the placeholder (dpo@example.com). " +
      "The Act requires published, valid Grievance Officer contact details - set it before serving traffic."
    );
  }
  if (!Number.isInteger(FIDUCIARY.grievanceSlaDays) || FIDUCIARY.grievanceSlaDays < 1) {
    throw new Error(`GRIEVANCE_SLA_DAYS must be a positive integer, got: ${process.env.GRIEVANCE_SLA_DAYS}`);
  }
}
```

`createRouter` calls `assertConfigured()` before building routes.

- [ ] **Step 5: (moved) The error mapper now lands in T5 Step 3d**

M6 is closed by T5 Step 3d, which installs the single error middleware when the router is rewritten - several of T5's own tests depend on `AppError` statuses reaching the client, so it could not wait until here. **Do not add a second error middleware.** Verify T5's version is present and registered after all routes, and confirm no per-route `catch` block remains that swallows an error into a `res.status(400)`. If you find one, fix it here and say so in your report.

- [ ] **Step 6: Make forms mount-relative (M1) and fix the copy (H7)**

`renderRightsPage({ basePath })` etc., with `action="${basePath}/rights/exercise"`. The router passes `req.baseUrl`. Add an `escapeHtml` helper and run every interpolated value through it - no value is attacker-controlled today, but the templates gain user-supplied fields in T13.

`complaintToTheBoard`'s note becomes:

```js
note: `This grievance has been recorded and assigned to ${FIDUCIARY.name}'s Grievance Officer (${FIDUCIARY.dpoName}). If it is not resolved by ${slaDueAt.toISOString().slice(0, 10)}, you may escalate it to the Data Protection Board.`,
```

- [ ] **Step 7: Fix the README signature drift (M2)**

`escalateToBoard` is documented as `escalateToBoard(refId)` but destructures an object. Update `README.md:99` to `escalateToBoard({ refId, principalId })` and add the missing JSDoc `@param` block to the function.

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: `test/http.test.js` 7/7 PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "fix: correct content negotiation, error mapping, and form actions

Closes H5, H7, M1, M2, M6, M11, L2.

req.accepts(\"html\") returns \"html\" for Accept: */* - the default curl
and fetch send - so every JSON API client received a 200 HTML fragment
instead of the documented 201 JSON. Six identical catch blocks mapped
every failure to 400 with the raw err.message, so a database outage read
as a client error and Mongo internals leaked. Forms hardcoded absolute
action paths, so they 404'd whenever the router was mounted anywhere but
/. And the grievance response told the data principal their complaint
'has been sent' when the package has no outbound channel at all.

- wantsHtml() lists json first so it wins the wildcard tie-break
- one error middleware: AppError keeps its status, ValidationError is
  400, everything else is 500 with a generic body and a server-side log
- form actions are built from req.baseUrl
- assertConfigured() refuses to start on a placeholder DPO email or a
  non-integer SLA, instead of rendering example.com to data principals
- grievance copy says recorded, not sent; onGrievanceFiled lets the host
  actually deliver it
- escapeHtml applied to every interpolated value
- README escalateToBoard signature corrected, JSDoc added

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---
