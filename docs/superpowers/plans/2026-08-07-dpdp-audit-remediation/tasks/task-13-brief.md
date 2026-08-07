# Task 13 brief

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

### Task 13: A usable browser surface

**Closes:** H6

**Files:**
- Modify: `src/http/forms.js` (consent page, withdrawal page, receipt page)
- Modify: `src/http/router.js` (`GET /consent/new`, `GET /consent/withdraw`)
- Create: `test/browser.test.js`

**Interfaces:**
- Produces:
  - `renderConsentPage({ basePath, notice })` - the itemised notice with a checkbox per optional purpose, required purposes shown as notice-only.
  - `renderConsentReceipt({ basePath, result })` - shows the `principalId` and `receiptId`, which is how a browser user obtains their identifier at all.
  - `renderWithdrawalPage({ basePath, state })` - a checkbox per currently-granted withdrawable purpose, given the same prominence as the consent page.
  - Routes `GET /consent/new` (public) and `GET /consent/withdraw` (authenticated).

- [ ] **Step 1: Write the failing test `test/browser.test.js`**

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
const HTML = { Accept: "text/html" };

test("the consent page states the notice and offers a checkbox per optional purpose", async () => {
  await withDb(async (conn) => {
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent/new`, { headers: HTML });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /name="consentTypes" value="marketing"/);
      assert.match(html, /name="consentTypes" value="analytics"/);
      assert.doesNotMatch(html, /name="consentTypes" value="kyc_reporting"/,
        "a legitimate use is not a choice - it must be stated, not offered as a checkbox");
      assert.match(html, /Prevention of Money-Laundering Act/, "the notice must state each lawful basis");
      assert.match(html, /name="dob"/, "the age gate needs a date of birth field");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("a browser user is shown their principalId after consenting - the forms are unusable without it", async () => {
  await withDb(async (conn) => {
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent`, {
        method: "POST",
        headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01", consentTypes: "marketing" }),
      });
      const html = await res.text();
      assert.match(html, /[a-f0-9]{64}/, "the receipt page must show the identifier every other form asks for");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("a withdrawal page exists, with the same prominence as consenting", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent/withdraw`, { headers: HTML });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /name="consentTypes" value="marketing"/);
      assert.match(html, /<form[^>]*method="POST"/i);
      assert.doesNotMatch(html, /name="consentTypes" value="kyc_reporting"/, "a non-withdrawable purpose must not be offered");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("rendered forms no longer demand a principalId the page cannot supply", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: [] });
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      for (const path of ["/rights", "/grievance/new", "/consent-manager/new"]) {
        const html = await (await fetch(`http://localhost:${port}/dpdp${path}`, { headers: HTML })).text();
        assert.doesNotMatch(html, /name="principalId"/,
          `${path}: identity comes from the session, not from a field the user cannot fill`);
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test test/browser.test.js`
Expected: FAIL - no consent page, no withdrawal page, and the forms still ask for `principalId`.

- [ ] **Step 3: Implement the three renderers and remove the `principalId` inputs**

Every form drops its `principalId` field - identity comes from `requireAuth`. Reuse the existing `baseStyle`.

- [ ] **Step 4: Wire the routes**

`GET /consent/new` public, `POST /consent` returning the receipt page when `wantsHtml(req)`, `GET /consent/withdraw` behind `requireAuth`.

**Verify `POST /consent/withdraw` exists** (T5 Step 3's route table adds it alongside the `PUT`). An HTML form can only issue GET or POST, so without the POST alias the rendered withdrawal form has no route to submit to and every browser user who ticks a purpose gets a 404 - the withdrawal page would dead-end exactly the way the three forms it exists to fix did, and H6 would be reported closed while withdrawal remained impossible for the non-API audience this task is written for. If T5 did not add it, add it here behind `requireAuth`, sharing the `PUT` handler.

The withdrawal form must post `consentSubmitted=1` as a hidden field alongside the checkboxes, so an all-unchecked submission is distinguishable from an empty one (T5 Step 3b).

- [ ] **Step 4b: Actually submit the rendered forms in the tests**

The Step 1 tests only pattern-match markup, so they would pass against a form whose action 404s. Add two tests that submit:

```js
test("the rendered withdrawal form can actually be submitted", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent/withdraw`, {
        method: "POST",
        headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ consentSubmitted: "1", consentTypes: "marketing" }),
      });
      assert.equal(res.status, 200, "a form POST must reach a real route, not 404");

      const record = await models.ConsentRecord.findOne({ principalId });
      const state = record.currentState();
      assert.equal(state.marketing.status, "withdrawn");
      assert.equal(state.analytics.status, "granted", "only the ticked purpose is withdrawn");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("a single ticked checkbox is accepted, not rejected as a non-array", async () => {
  // extended:false parses one value as a string and two as an array, so this is
  // the case that would 400 without the router's normalisation.
  await withDb(async (conn) => {
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent`, {
        method: "POST",
        headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          name: "Asha", email: "single@example.com", phone: "9000000001",
          dob: "1990-04-01", consentSubmitted: "1", consentTypes: "marketing",
        }),
      });
      assert.equal(res.status, 201);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: `test/browser.test.js` 4/4 PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: make the browser surface usable end to end

Closes H6.

All three rendered forms demanded a 64-character principalId in a text
field, and no HTML page in the toolkit could produce that value - it was
only ever returned in the JSON body of POST /consent, and there was no
consent page. Every browser-reachable path therefore dead-ended, which
matters because the stated audience is social and public sector
organisations whose data principals are beneficiaries, not API clients.
There was also no withdrawal page at all, so withdrawal could not be as
easy as granting.

- GET /consent/new renders the itemised notice with a checkbox per
  optional purpose; legitimate uses are stated, not offered as choices
- POST /consent returns a receipt page showing the principalId
- GET /consent/withdraw lists currently-granted withdrawable purposes
- the three existing forms drop their principalId field; identity comes
  from the session

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---
