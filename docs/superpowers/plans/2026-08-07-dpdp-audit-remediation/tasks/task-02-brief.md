# Task 2 brief

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

### Task 2: Test harness, input validation, and the NoSQL injection fix

**Closes:** C2, M14, M15 (harness half)

**Files:**
- Create: `test/helpers/db.js`
- Create: `src/utils/validate.js`
- Create: `src/utils/errors.js`
- Create: `test/validate.test.js`
- Create: `test/injection.test.js`
- Modify: `src/services/withdrawConsent.js`
- Modify: `src/models/RightsRequest.js`, `src/models/Grievance.js`, `src/models/ConsentManagerRequest.js` (add `maxlength`)

**Interfaces:**
- Produces:
  - `withDb(fn)` from `test/helpers/db.js` - starts an in-memory Mongo, yields a mongoose connection, tears down.
  - `assertPrincipalId(value, field)`, `assertNonEmptyString(value, field, maxLength)`, `assertStringArray(value, field)` from `src/utils/validate.js`. Each throws `AppError` with `status: 400`.
  - `AppError` from `src/utils/errors.js`: `new AppError(message, status)` with `err.status`.

- [ ] **Step 1: Write `src/utils/errors.js`**

```js
/**
 * An error with an HTTP status attached, so the transport layer can map it
 * without guessing. Anything thrown that is NOT an AppError is treated as an
 * internal fault and reported as 500 with a generic message.
 */
class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}

module.exports = { AppError };
```

- [ ] **Step 2: Write the failing test `test/validate.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertPrincipalId, assertNonEmptyString, assertStringArray } = require("../src/utils/validate");

test("assertPrincipalId accepts a 64-char lowercase hex string", () => {
  const id = "a".repeat(64);
  assert.equal(assertPrincipalId(id, "principalId"), id);
});

test("assertPrincipalId rejects every NoSQL operator shape", () => {
  for (const bad of [{ $ne: null }, { $gt: "" }, { $regex: ".*" }, { $in: ["a"] }, [], 42, null, undefined, "short"]) {
    assert.throws(
      () => assertPrincipalId(bad, "principalId"),
      (err) => err.status === 400,
      `expected rejection for ${JSON.stringify(bad)}`
    );
  }
});

test("assertNonEmptyString enforces the max length", () => {
  assert.equal(assertNonEmptyString("hi", "subject", 10), "hi");
  assert.throws(() => assertNonEmptyString("x".repeat(11), "subject", 10), (e) => e.status === 400);
  assert.throws(() => assertNonEmptyString("   ", "subject", 10), (e) => e.status === 400);
  assert.throws(() => assertNonEmptyString({ $ne: "" }, "subject", 10), (e) => e.status === 400);
});

test("assertStringArray rejects non-arrays and non-string members", () => {
  assert.deepEqual(assertStringArray(["a", "b"], "consentTypes"), ["a", "b"]);
  assert.deepEqual(assertStringArray(undefined, "consentTypes"), []);
  assert.throws(() => assertStringArray("a", "consentTypes"), (e) => e.status === 400);
  assert.throws(() => assertStringArray([{ $ne: "" }], "consentTypes"), (e) => e.status === 400);
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `node --test test/validate.test.js`
Expected: FAIL - `Cannot find module '../src/utils/validate'`

- [ ] **Step 4: Write `src/utils/validate.js`**

```js
const { AppError } = require("./errors");

const PRINCIPAL_ID_RE = /^[a-f0-9]{64}$/;

/**
 * Guards a principalId before it is ever used in a query filter. Mongoose
 * does NOT strip query operators during schema casting - `{$gt: ""}` on a
 * String path reaches MongoDB verbatim and matches every document - so a
 * shape check here is the actual control, not a nicety.
 */
function assertPrincipalId(value, field = "principalId") {
  if (typeof value !== "string" || !PRINCIPAL_ID_RE.test(value)) {
    throw new AppError(`${field} must be a 64-character hex string`, 400);
  }
  return value;
}

function assertNonEmptyString(value, field, maxLength = 2000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(`${field} is required and must be a string`, 400);
  }
  if (value.length > maxLength) {
    throw new AppError(`${field} must be at most ${maxLength} characters`, 400);
  }
  return value;
}

function assertStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new AppError(`${field} must be an array of strings`, 400);
  }
  return value;
}

module.exports = { assertPrincipalId, assertNonEmptyString, assertStringArray };
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `node --test test/validate.test.js`
Expected: PASS, 4/4

- [ ] **Step 6: Write `test/helpers/db.js`**

```js
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

/**
 * Runs `fn(connection)` against a throwaway in-memory MongoDB. Uses an
 * isolated connection (not the global mongoose singleton) so tests exercise
 * the same path the library uses.
 */
async function withDb(fn) {
  const server = await MongoMemoryServer.create();
  const conn = await mongoose.createConnection(server.getUri()).asPromise();
  try {
    return await fn(conn);
  } finally {
    await conn.close();
    await server.stop();
  }
}

module.exports = { withDb };
```

- [ ] **Step 7: Write the failing injection test `test/injection.test.js`**

This is the regression test for C2. It must fail against the current code.

Note: this test builds its model inline rather than via `buildModels`, which does not exist until T3. That keeps this commit green - T3 rewrites the two setup lines to use the registry.

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { Schema } = require("mongoose");
const { withDb } = require("./helpers/db");
const withdrawConsent = require("../src/services/withdrawConsent");

// Built inline: buildModels() arrives in Task 3. T3 replaces this block.
function modelsFor(conn) {
  const eventSchema = new Schema(
    { type: String, status: String, basis: String, timestamp: Date },
    { _id: false }
  );
  const schema = new Schema({
    principalId: { type: String, required: true, unique: true },
    docRef: { type: String, required: true, unique: true },
    events: { type: [eventSchema], default: [] },
    updatedAt: Date,
  });
  schema.methods.currentState = function () {
    const latest = {};
    for (const e of this.events) {
      if (!latest[e.type] || e.timestamp >= latest[e.type].timestamp) latest[e.type] = e;
    }
    return latest;
  };
  return { ConsentRecord: conn.model("ConsentRecord", schema) };
}

test("withdrawConsent rejects a NoSQL operator instead of matching an arbitrary principal", async () => {
  await withDb(async (conn) => {
    const models = modelsFor(conn);
    const victimId = "b".repeat(64);
    await models.ConsentRecord.create({
      principalId: victimId,
      docRef: "CN-TEST-0001",
      events: [{ type: "marketing", status: "granted", basis: "Your consent", timestamp: new Date() }],
    });

    for (const payload of [{ $gt: "" }, { $ne: null }, { $regex: ".*" }]) {
      await assert.rejects(
        () => withdrawConsent({ models, principalId: payload, consentTypes: ["marketing"] }),
        (err) => err.status === 400,
        `operator ${JSON.stringify(payload)} must be rejected`
      );
    }

    // The victim's ledger must be untouched: still exactly one event.
    const after = await models.ConsentRecord.findOne({ principalId: victimId });
    assert.equal(after.events.length, 1);
    assert.equal(after.events[0].status, "granted");
  });
});
```

- [ ] **Step 8: Run it to confirm it fails**

**Order matters here, and the obvious order does not work.** Before the model is injected, `withdrawConsent` resolves `ConsentRecord` from the global mongoose singleton, which the test harness deliberately never connects - so the malicious query never reaches a live database and you get a 10-second buffering timeout instead of the vulnerability. The red phase would prove nothing. This was hit for real during implementation.

So do the mechanical refactor **first**, then the test:

**Step 8a - inject the model, no behaviour change.** Add `models` as the first destructured parameter of `withdrawConsent` and delete the module-scope `require("../models/ConsentRecord")`, reading `models.ConsentRecord` instead. Change nothing else. The function is now injectable.

**Step 8b - run the injection test.**

Run: `node --test test/injection.test.js`
Expected: FAIL, and specifically **the vulnerability reproducing**: `{$gt: ""}` matches the victim record, `findOne` returns it, and a `withdrawn` event is appended to a ledger the caller had no right to touch. The assertion fails because the call *resolved* instead of rejecting, and the victim's `events.length` has grown to 2. If you see a buffering timeout instead, the model was not injected - stop and say so.

**Step 8c - add the guard** (Step 9 below) and re-run. Green. This commit must end green.

Do **not** connect the global default connection in `test/helpers/db.js` to make the original ordering work. That contradicts the harness's isolation, which is exactly what T3 establishes.

- [ ] **Step 9: Add the guard to `withdrawConsent`**

At the top of the function body, before any query:

```js
const { assertPrincipalId, assertStringArray } = require("../utils/validate");
const { AppError } = require("../utils/errors");
...
async function withdrawConsent({ models, principalId, consentTypes } = {}) {
  assertPrincipalId(principalId);
  const types = assertStringArray(consentTypes, "consentTypes");
  if (!types.length) throw new AppError("consentTypes must include at least one purpose to withdraw", 400);
  ...
```

Leave the rest of the function's behaviour alone - T7 rewrites it. The `models` parameter replaces the module-level `require("../models/ConsentRecord")` import: delete that import and read `models.ConsentRecord` instead. Do not add a fallback to a global model - the whole point of T3 is that there is no global.

- [ ] **Step 10: Add `sanitizeFilter` as defence in depth**

In `src/db/connection.js`, at module scope:

**Do NOT add a module-scope `mongoose.set("sanitizeFilter", true)`.** That is global process state: verified by executing real queries against mongoose 8.24, it makes a host application's own `Model.find({ age: { $gt: 5 } })` throw `CastError`, so merely requiring this library would corrupt an unrelated app's data access. T3 sets it on the library's own connection instead, which was verified to leave the host's default connection untouched.

For this task, the per-field validation added in Step 4 is the whole control. Skip this step and note in your report that it was intentionally skipped, with the reason.

- [ ] **Step 11: Add length caps to the free-text fields (M14)**

`src/models/RightsRequest.js`: `details: { type: String, default: "", maxlength: 5000 }`
`src/models/Grievance.js`: `subject: { type: String, required: true, maxlength: 200 }`, `description: { type: String, required: true, maxlength: 10000 }`
`src/models/ConsentManagerRequest.js`: `message: { type: String, default: "", maxlength: 5000 }`, `preferredConsentManager: { type: String, default: "", maxlength: 200 }`

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "fix: reject NoSQL operators in withdrawConsent, add test harness

Closes C2, M14. Starts M15.

withdrawConsent passed req.body.principalId straight into a query filter
behind only a truthiness check. Mongoose does not strip query operators
during String-path casting, so {\$gt:\"\"} matched every ConsentRecord and
findOne returned an arbitrary victim, whose append-only ledger was then
written to. express.urlencoded({extended:true}) builds the same object
from a form field named principalId[\$ne], so a cross-origin form could
deliver it.

- add src/utils/validate.js with primitive assertions
- add src/utils/errors.js with AppError carrying an HTTP status
- guard withdrawConsent with assertPrincipalId
- set mongoose sanitizeFilter as defence in depth
- cap the unbounded free-text fields on the three request models
- add node:test + mongodb-memory-server harness

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---
