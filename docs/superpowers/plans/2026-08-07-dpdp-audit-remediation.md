# DPDP Toolkit Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 43 findings in `reviews.md` - 4 critical, 12 high, 15 medium, 12 low - turning the toolkit from a write-only reference sketch into an authenticated, readable, legally-coherent DPDP implementation with a real test suite.

**Architecture:** Four structural changes carry most of the fixes. (1) Identity splits from PII: a random `principalId` on a new `Principal` document that holds erasable PII, with the append-only `ConsentRecord` ledger keyed by that id and holding no PII - this makes erasure and audit retention independently satisfiable. (2) Authentication becomes an injected `resolvePrincipal(req)` hook that the router requires, defaulting to deny, so `principalId` is never read from a request body. (3) The library owns an isolated mongoose connection with a per-connection model registry instead of hijacking the global singleton. (4) Consent writes become non-destructive: the service computes the delta against current state and only appends events that represent a real change, with a three-state event enum and a per-transaction receipt.

**Tech Stack:** Node >= 20, Express 4 (as a peerDependency), Mongoose 8, dotenv. Tests use the built-in `node:test` runner with `mongodb-memory-server` as the only devDependency - no test framework is added.

## Global Constraints

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
- **Finding IDs** (`C1`, `H5`, `M12`, `L3` ...) refer to `repo-root:reviews.md`. Every task lists the findings it closes; a task is not complete until each listed finding is actually addressed.

---

## File Structure

**New files:**

| Path | Responsibility |
| --- | --- |
| `src/utils/validate.js` | Primitive input assertions used before any value reaches a query filter |
| `src/utils/errors.js` | `AppError` with an HTTP status, so the router can map errors correctly |
| `src/models/index.js` | `buildModels(connection)` - per-connection model registry |
| `src/models/Principal.js` | Erasable PII + random `principalId` + lookup hashes |
| `src/config/notice.js` | Builds the itemised Section 5 notice from the catalog |
| `src/services/consentState.js` | `getConsentState` - the read side of the ledger |
| `src/services/erasure.js` | `erasePrincipalPII` - erases PII, retains the ledger |
| `src/services/requestLifecycle.js` | Status transitions for the three request types |
| `src/http/negotiate.js` | `wantsHtml(req)` - correct content negotiation |
| `test/*.test.js` | One test file per subsystem |
| `test/helpers/db.js` | In-memory Mongo lifecycle for tests |
| `repo-root:.gitignore` | Ignore `.env`, `node_modules`, logs |
| `.env.example` | Every env var the code reads, with defaults |

**Substantially rewritten:** `src/db/connection.js`, `src/config/catalog.js`, `src/services/persistPIIwithconsent.js`, `src/services/withdrawConsent.js`, `src/http/router.js`, `src/http/forms.js`, `src/index.js`, `README.md`, `package.json`.

**Modified:** `src/models/ConsentRecord.js`, `src/models/RightsRequest.js`, `src/models/Grievance.js`, `src/models/ConsentManagerRequest.js`, `src/services/dataPrincipalRights.js`, `src/services/complaintToTheBoard.js`, `src/services/consentManagerRequest.js`, `src/utils/principalId.js`, `examples/server.js`, `repo-root:README.md`.

---

## Task Dependency Order

**Execution order is NOT task-number order.** Task numbers are stable identifiers; the order below is the order to run them in.

```
 1. T1  hygiene/packaging      (independent)
 2. T2  test harness + C2 fix  (independent; every later task uses the harness)
 3. T3  isolated connection    (needs T2)
 4. T4  Principal model split  (needs T3)
 5. T6  lawful basis model     (needs T2)
 6. T7  consent state machine  (needs T4, T6)
 7. T9  age gate               (needs T7)
 8. T5  auth hook + router     (needs T4, T6, T7, T9)   <-- moved after T7/T9
 9. T8  notice capture         (needs T6, T7, T5)
10. T10 read path              (needs T4, T7, T5)
11. T11 lifecycle transitions  (needs T3)
12. T12 HTTP layer             (needs T5)
13. T13 browser surface        (needs T5, T12)
14. T14 docs sync + suite      (last)
```

**Why T5 moves after T7 and T9.** T5's tests exercise `POST /consent` end to end. But between T3 and T7 the consent service is deliberately broken in transit: T4 deletes `derivePrincipalId`, T3 makes `lawfulBasisKind` and `receiptId` required event fields that the old event builder never sets, T3 removes `ConsentRecord.pii`, and T6 removes `entry.basis` and `entry.required`. Nothing creates a `Principal` until T4 and nothing writes a valid event until T7, so T5's `201` and `409` assertions cannot pass at the original position. Running T6 -> T7 -> T9 first means the service is whole before the router is rewritten around it.

**T5 also absorbs the error middleware** that was originally in T12 Step 5, because T5 is where the router is rewritten and several of T5's own tests depend on `AppError` statuses reaching the client correctly. T12 keeps content negotiation, forms, and config validation.

---

### Task 1: Repo hygiene, packaging, and license

**Closes:** H12, M12, M13, L1, L4, L7, L9, L10, L11 (doc half), L12

**Files:**
- Create: `repo-root:.gitignore`
- Create: `data-fiduciary-toolkit/.env.example`
- Modify: `data-fiduciary-toolkit/package.json`
- Modify: `data-fiduciary-toolkit/README.md` (lines 1-46 and 130-141)
- Modify: `repo-root:README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` script that later tasks rely on; the `engines` floor; the `.env.example` variable list that T12 validates against.

- [ ] **Step 1: Create `repo-root:.gitignore`**

```gitignore
node_modules/
.env
.env.*
!.env.example
*.log
npm-debug.log*
.DS_Store
coverage/
.superpowers/
```

- [ ] **Step 2: Create `data-fiduciary-toolkit/.env.example`**

Every variable the code reads. `PRINCIPAL_ID_SECRET` is added by T4 and is included now so the file is complete.

```bash
# Required - MongoDB connection string.
MONGO_URI=mongodb://localhost:27017/dpdp-toolkit

# Required - secret used to derive the lookup hash for a data principal's
# email and phone. Generate with: openssl rand -hex 32
# Changing this orphans every existing principal lookup, so treat it as
# permanent once you have data.
PRINCIPAL_ID_SECRET=

# Your organisation's identity, shown to data principals.
FIDUCIARY_NAME=Kavach Finance

# Grievance Officer / Data Protection Officer contact. The toolkit refuses
# to start if these are left at the example.com placeholder.
FIDUCIARY_DPO_NAME=Data Protection Officer
FIDUCIARY_DPO_EMAIL=dpo@example.com

# Days the Grievance Officer has to resolve a grievance before a data
# principal may escalate. Must be a positive integer.
GRIEVANCE_SLA_DAYS=7

# Example server only.
PORT=4000
```

- [ ] **Step 3: Rewrite `package.json`**

`express` moves to `peerDependencies` (L4), license becomes Apache-2.0 (M12), `files` allowlist added (H12), `engines` floor and `repository` added, `test` script added.

```json
{
  "name": "dpdp-fiduciary-toolkit",
  "version": "0.2.0",
  "description": "Reference implementation of Digital Personal Data Protection Act, 2023 data-fiduciary obligations: consent capture, withdrawal, data principal rights, grievance redressal, and consent manager handoff.",
  "main": "src/index.js",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/datsogood/dpdp-data-fiduciary-toolkit.git",
    "directory": "data-fiduciary-toolkit"
  },
  "engines": {
    "node": ">=20"
  },
  "files": [
    "src/",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "test": "node --test",
    "example": "node examples/server.js"
  },
  "peerDependencies": {
    "express": "^4.19.2 || ^5.0.0"
  },
  "dependencies": {
    "mongoose": "^8.5.0",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "express": "^4.19.2",
    "mongodb-memory-server": "^10.1.2"
  }
}
```

- [ ] **Step 4: Copy the LICENSE into the package directory**

The `files` allowlist references `LICENSE`, so the package needs its own copy:

```bash
cp ../LICENSE ./LICENSE
```

Add `LICENSE` to `repo-root:.gitignore`? **No** - it must be committed. Verify with `git status` that `data-fiduciary-toolkit/LICENSE` is tracked.

- [ ] **Step 5: Fix the statute citation and the two misstated obligations in `README.md`**

Line 4: change `Digital Personal Data Protection Act, 2025 (DPDP Act)` to `Digital Personal Data Protection Act, 2023 (DPDP Act)`.

Obligation 1 (line 10) currently overstates the language rule. Replace with:

```markdown
1. Consent must be requested through a clear, plain-language notice, and the
   data principal must be able to read that notice in English or in any
   language listed in the Eighth Schedule to the Constitution.
```

Obligation 13 (line 22) misstates the Significant Data Fiduciary test. Replace with:

```markdown
13. A Significant Data Fiduciary is one the Central Government notifies as
    such, based on factors including the volume and sensitivity of personal
    data processed and the risk to data principals - it is a notification,
    not a threshold an organisation self-assesses. An SDF must appoint a
    Data Protection Officer based in India, appoint an independent data
    auditor, and carry out periodic data protection impact assessments and
    audits.
```

- [ ] **Step 6: Fix the setup snippet (L10) and the README's own "not" list**

Replace the quickstart block at lines 30-46 with a version that runs. The top-level `await` is the bug:

````markdown
## Setup

```bash
npm install
cp .env.example .env   # then set MONGO_URI and PRINCIPAL_ID_SECRET
```

```js
const express = require("express");
const { connect, createRouter } = require("dpdp-fiduciary-toolkit");

async function main() {
  const db = await connect(process.env.MONGO_URI);

  const app = express();
  app.use("/dpdp", createRouter({
    db,
    // Required. Return the authenticated principal's id, or null.
    resolvePrincipal: (req) => req.session?.principalId ?? null,
  }));
  app.listen(4000);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

`express` is a peer dependency - install it in your own project.

Or run the bundled example: `npm run example` (needs a Mongo instance at
`MONGO_URI`).
````

Add to the "What this is not" section (L11, L12 documentation half):

```markdown
- `principalId` is a random opaque identifier, not a hash of anything. Earlier
  versions derived it from the data principal's email, which made it guessable
  by anyone who knew the address. Lookup hashes are keyed with
  `PRINCIPAL_ID_SECRET`, so they are pseudonymous - and pseudonymous data is
  still personal data under the Act.
- The consent ledger records three states per purpose: `granted`, `denied`
  (offered and declined), and `withdrawn` (previously granted, then revoked).
  A purpose that was never offered has no event at all.
```

- [ ] **Step 7: Rewrite `repo-root:README.md`**

It is currently two lines and never mentions the nested package (M13).

```markdown
# dpdp-data-fiduciary-toolkit

This toolkit aims to codify the DPDP obligations of a data fiduciary, so that
any user organization can adhere to the DPDP regulations in a standard, secure
and an easy manner. This toolkit is primarily developed for the social and
public sector organizations that deal with a lot of PII data.

The Act referred to throughout is India's Digital Personal Data Protection
Act, 2023.

## Layout

The npm package lives in [`data-fiduciary-toolkit/`](data-fiduciary-toolkit) -
install and run from inside that directory:

```bash
cd data-fiduciary-toolkit
npm install
npm test
```

See [`data-fiduciary-toolkit/README.md`](data-fiduciary-toolkit/README.md) for
the API, and [`reviews.md`](reviews.md) for the audit this codebase was
remediated against.

## License

Apache-2.0. See [LICENSE](LICENSE).
```

- [ ] **Step 8: Verify nothing is packaged that should not be**

Run: `cd data-fiduciary-toolkit && npm pack --dry-run`
Expected: the file list contains only `src/`, `README.md`, `LICENSE`, `package.json`. No `.env`, no `test/`, no `examples/`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: fix packaging, license, and statute citations

Closes H12, M12, M13, L1, L4, L7, L9, L10, L12 from reviews.md.

- add .gitignore (no .env or node_modules could be ignored before)
- add .env.example with all six env vars the code reads
- package.json: Apache-2.0 to match LICENSE, files allowlist, engines
  floor, express moved to peerDependencies, npm test script
- README: the Act is 2023 not 2025; correct the Significant Data
  Fiduciary test and the language requirement; make the quickstart
  snippet actually run
- root README: document the nested package layout

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

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

### Task 3: Isolated connection and per-connection model registry

**Closes:** H8, M10

**Files:**
- Rewrite: `src/db/connection.js`
- Create: `src/models/index.js`
- Modify: all four files in `src/models/` (export schema-and-factory, not a global model)
- Create: `test/connection.test.js`
- Modify: `src/index.js`

**Interfaces:**
- Consumes: `withDb` from T2.
- Produces:
  - `connect(uri)` returns a **mongoose Connection** (not the global singleton) with `connection.models` populated. Callers pass it to `createRouter({ db })`.
  - `buildModels(connection)` returns `{ Principal, ConsentRecord, RightsRequest, Grievance, ConsentManagerRequest }` bound to that connection. `Principal` is added in T4 - until then the object has four keys.
  - Every model file exports `{ schema, build(connection) }`.

- [ ] **Step 1: Write the failing test `test/connection.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connection");
const { buildModels } = require("../src/models");

test("connect returns an isolated connection, not the global mongoose default", async () => {
  const server = await MongoMemoryServer.create();
  try {
    const conn = await connect(server.getUri());
    assert.notEqual(conn, mongoose.connection, "must not be the global default connection");
    assert.equal(mongoose.connection.readyState, 0, "global default must stay disconnected");
    assert.equal(conn.readyState, 1);
    await conn.close();
  } finally {
    await server.stop();
  }
});

test("two connects to different URIs yield two independent connections", async () => {
  const a = await MongoMemoryServer.create();
  const b = await MongoMemoryServer.create();
  try {
    const connA = await connect(a.getUri());
    const connB = await connect(b.getUri());
    assert.notEqual(connA, connB, "a second connect must not silently return the first connection");
    await connA.close();
    await connB.close();
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("sanitizeFilter is scoped to our connection and does not break a host app's queries", async () => {
  const server = await MongoMemoryServer.create();
  try {
    // A host application, using the global mongoose default connection.
    const hostConn = await mongoose.createConnection(server.getUri()).asPromise();
    const Host = hostConn.model("HostThing", new mongoose.Schema({ age: Number }));
    await Host.create([{ age: 10 }, { age: 20 }]);

    const ours = await connect(server.getUri());

    // The host's legitimate operator query must still work.
    const found = await Host.find({ age: { $gt: 5 } });
    assert.equal(found.length, 2, "requiring this library must not break a host app's operator queries");

    // Ours must reject an operator object.
    const models = buildModels(ours);
    await assert.rejects(
      () => models.ConsentRecord.findOne({ principalId: { $gt: "" } }),
      (err) => err.name === "CastError",
      "our own connection must sanitize operator filters"
    );

    await ours.close();
    await hostConn.close();
  } finally {
    await server.stop();
  }
});

test("buildModels binds models to the given connection and does not pollute the global registry", async () => {
  const server = await MongoMemoryServer.create();
  try {
    const conn = await connect(server.getUri());
    const models = buildModels(conn);
    assert.equal(models.ConsentRecord.db, conn);
    assert.ok(!mongoose.models.ConsentRecord, "global mongoose registry must stay clean");
    await conn.close();
  } finally {
    await server.stop();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/connection.test.js`
Expected: FAIL - the current `connect` returns `mongoose.connection`.

- [ ] **Step 3: Rewrite `src/db/connection.js`**

```js
const mongoose = require("mongoose");
const { AppError } = require("../utils/errors");

/**
 * Opens an isolated connection this library owns.
 *
 * Deliberately NOT mongoose.connect(): that mutates the global default
 * connection and the global model registry, so a host application already
 * using mongoose would either fail to connect or find its own models
 * silently rebound to this library's schemas.
 *
 * Each call returns a new connection - the caller owns its lifetime and
 * should close it on shutdown.
 */
async function connect(uri = process.env.MONGO_URI) {
  if (!uri || typeof uri !== "string") {
    throw new AppError("MONGO_URI is not set - pass one explicitly or set it in the environment", 500);
  }
  const connection = mongoose.createConnection(uri);

  // Defence in depth against query-operator injection, scoped to OUR
  // connection. Deliberately not mongoose.set(...): that is global process
  // state, and it would make a host application's own
  // Model.find({ age: { $gt: 5 } }) throw CastError just because this library
  // was required. Verified: set here, the host's default connection is
  // unaffected while our queries still reject operator objects.
  //
  // The primary control remains per-field validation in utils/validate.js.
  connection.set("sanitizeFilter", true);

  await connection.asPromise();
  return connection;
}

module.exports = { connect, mongoose };
```

- [ ] **Step 4: Convert each model file to a factory**

Pattern, applied to all four. `src/models/ConsentRecord.js`:

```js
const { Schema } = require("mongoose");

// Every grant, decline AND withdrawal is its own event, never overwritten -
// this is the audit trail DPDP expects a fiduciary to be able to produce.
// This document holds NO PII: PII lives on Principal so it can be erased
// without destroying the consent evidence.
const consentEventSchema = new Schema(
  {
    type: { type: String, required: true },
    status: { type: String, enum: ["granted", "denied", "withdrawn"], required: true },
    basis: { type: String, required: true },
    lawfulBasisKind: { type: String, enum: ["consent", "legitimate_use"], required: true },
    receiptId: { type: String, required: true },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

const consentRecordSchema = new Schema({
  principalId: { type: String, required: true, unique: true, index: true },
  docRef: { type: String, required: true, unique: true },
  events: { type: [consentEventSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

/** Current status per consent type, derived from the latest event of each type. */
consentRecordSchema.methods.currentState = function currentState() {
  const latestByType = {};
  for (const event of this.events) {
    const existing = latestByType[event.type];
    if (!existing || event.timestamp >= existing.timestamp) latestByType[event.type] = event;
  }
  return latestByType;
};

module.exports = {
  schema: consentRecordSchema,
  build: (connection) => connection.model("ConsentRecord", consentRecordSchema),
};
```

Note the two new event fields (`lawfulBasisKind`, `receiptId`) - T6 and T7 populate them. `status` gains `denied` (M5). The `pii` block is **removed** here; T4 moves it to `Principal`.

Apply the same `{ schema, build }` shape to `RightsRequest.js`, `Grievance.js`, `ConsentManagerRequest.js`, keeping their existing fields plus the T2 `maxlength` caps.

- [ ] **Step 5: Write `src/models/index.js`**

```js
const ConsentRecord = require("./ConsentRecord");
const RightsRequest = require("./RightsRequest");
const Grievance = require("./Grievance");
const ConsentManagerRequest = require("./ConsentManagerRequest");

/**
 * Binds every model to one connection and caches the registry on it, so
 * repeated calls with the same connection return the same model objects
 * (mongoose throws on re-registering a model name).
 */
function buildModels(connection) {
  if (!connection || typeof connection.model !== "function") {
    throw new Error("buildModels requires a mongoose Connection - pass the value returned by connect()");
  }
  if (connection.$dpdpModels) return connection.$dpdpModels;

  const models = {
    ConsentRecord: ConsentRecord.build(connection),
    RightsRequest: RightsRequest.build(connection),
    Grievance: Grievance.build(connection),
    ConsentManagerRequest: ConsentManagerRequest.build(connection),
  };
  connection.$dpdpModels = models;
  return models;
}

module.exports = { buildModels };
```

- [ ] **Step 6: Thread `models` through every service**

Each service takes `models` as its first destructured parameter instead of importing a model at module scope. Signatures become:

```js
persistPIIwithconsent({ models, pii, consentTypes, regrant })
withdrawConsent({ models, principalId, consentTypes })
exerciseRight({ models, principalId, right, details })
complaintToTheBoard({ models, principalId, subject, description })
escalateToBoard({ models, refId, principalId })
consentManagerRequest({ models, principalId, message, preferredConsentManager })
```

- [ ] **Step 7: Update `src/index.js` to export `buildModels`**

```js
const { connect } = require("./db/connection");
const { buildModels } = require("./models");
...
module.exports = { connect, buildModels, /* ...services, createRouter, config */ };
```

- [ ] **Step 8: Run the tests**

Also rewrite `test/injection.test.js` to use the registry: delete its inline `modelsFor` helper and the `Schema` import, `require("../src/models")`, and call `buildModels(conn)`. Add `lawfulBasisKind: "consent"` and `receiptId: "RC-TEST"` to the seeded event so it satisfies the tightened schema.

Run: `npm test`
Expected: `test/connection.test.js` 3/3 PASS, `test/validate.test.js` 4/4 PASS, `test/injection.test.js` 1/1 PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: own an isolated connection and model registry

Closes H8, M10.

The library called mongoose.connect() and registered models on the global
mongoose singleton, so the integration the README documents - dropping the
router into an existing Express app - either failed to connect or silently
rebound a host app's same-named models to this library's schemas. The
connected flag also made a second connect() with a different URI return
the first connection.

- connect() returns a dedicated mongoose.createConnection()
- models become { schema, build(connection) } factories
- buildModels(connection) caches a per-connection registry
- services take models as a parameter instead of importing globals
- ConsentRecord drops its pii block (moves to Principal in the next task)
  and gains the denied status plus lawfulBasisKind and receiptId

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---

### Task 4: Split PII from the ledger, randomise `principalId`

**Closes:** H9, H10, C1 (identity half), L11 (code half)

**Files:**
- Create: `src/models/Principal.js`
- Rewrite: `src/utils/principalId.js`
- Create: `src/services/erasure.js`
- Modify: `src/models/index.js`
- Create: `test/principal.test.js`, `test/erasure.test.js`

**Interfaces:**
- Produces:
  - `newPrincipalId()` returns a random 64-char hex string.
  - `lookupHash(value)` returns `HMAC-SHA256(PRINCIPAL_ID_SECRET, normalized)` as hex. Throws if the secret is unset.
  - `generateDocRef(prefix)` - unchanged name, widened entropy (M7).
  - `models.Principal` with `{ principalId, emailHash, phoneHash, pii, erasedAt }`.
  - `findOrCreatePrincipal({ models, pii })` returns `{ principal, created }`.
  - `findPrincipalByContact({ models, email, phone })` returns the matching `Principal` document or `null`. **Read-only - it must never create or modify anything.** The router needs to know whether a principal exists *before* it writes, so that `POST /consent` can refuse an unauthenticated update instead of performing the write and then reporting 409 after the damage is done.
  - `findPrincipalById({ models, principalId })` returns the `Principal` or `null`, used by the authenticated update path so identity comes from the session rather than from supplied contact details.
  - `updatePrincipalContact({ models, principalId, pii })` - the authenticated contact-correction path. Identity comes from `principalId`, never from the payload. Rejects with `409` if the new email or phone already belongs to another principal.
  - `erasePrincipalPII({ models, principalId })` from `src/services/erasure.js`.

- [ ] **Step 1: Write the failing test `test/principal.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
const { buildModels } = require("../src/models");
const {
  newPrincipalId, lookupHash, findOrCreatePrincipal, findPrincipalByContact, updatePrincipalContact,
} = require("../src/utils/principalId");

test("newPrincipalId is random, 64 hex chars, and never derived from input", () => {
  const a = newPrincipalId();
  const b = newPrincipalId();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, b);
});

test("lookupHash is keyed - it is not a bare sha256 of the email", () => {
  const crypto = require("node:crypto");
  const email = "asha@example.com";
  const bare = crypto.createHash("sha256").update(email).digest("hex");
  assert.notEqual(lookupHash(email), bare, "an unkeyed hash would be guessable from the email alone");
  assert.equal(lookupHash(" Asha@Example.COM "), lookupHash(email), "must normalise case and whitespace");
});

test("lookupHash refuses to run without a configured secret", () => {
  const saved = process.env.PRINCIPAL_ID_SECRET;
  delete process.env.PRINCIPAL_ID_SECRET;
  try {
    assert.throws(() => lookupHash("a@b.com"), /PRINCIPAL_ID_SECRET/);
  } finally {
    process.env.PRINCIPAL_ID_SECRET = saved;
  }
});

test("a principal can be registered by phone alone - no email required", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal, created } = await findOrCreatePrincipal({
      models,
      pii: { name: "Beneficiary", phone: "9876543210" },
    });
    assert.equal(created, true);
    assert.match(principal.principalId, /^[a-f0-9]{64}$/);
    assert.equal(principal.pii.email, undefined);
  });
});

test("two people sharing a phone can both register", async () => {
  // The stated audience is beneficiaries who share a household handset, so
  // "same phone" must not mean "same data principal".
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const mother = await findOrCreatePrincipal({ models, pii: { name: "Asha", email: "asha@example.com", phone: "9876543210" } });
    const daughter = await findOrCreatePrincipal({ models, pii: { name: "Priya", email: "priya@example.com", phone: "9876543210" } });

    assert.equal(daughter.created, true, "a second person on a shared phone must be able to register");
    assert.notEqual(daughter.principal.principalId, mother.principal.principalId);
    assert.equal(await models.Principal.countDocuments(), 2);
  });
});

test("correcting an email keeps the same principalId, via the authenticated path", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal } = await findOrCreatePrincipal({ models, pii: { name: "Asha", email: "old@example.com", phone: "9876543210" } });
    const id = principal.principalId;

    // Identity comes from the session, not from matching the payload against
    // stored contact hashes.
    const updated = await updatePrincipalContact({
      models, principalId: id, pii: { email: "new@example.com" },
    });
    assert.equal(updated.principalId, id, "identity must survive an email correction");
    assert.equal(updated.pii.email, "new@example.com");
    assert.equal(updated.pii.name, "Asha", "unrelated fields must be preserved");
    assert.equal(await models.Principal.countDocuments(), 1, "must not create an orphan second record");

    // The old email must no longer resolve to anyone.
    assert.equal(await findPrincipalByContact({ models, email: "old@example.com" }), null);
  });
});

test("a contact correction cannot steal another principal's email", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const a = await findOrCreatePrincipal({ models, pii: { name: "A", email: "a@example.com", phone: "1" } });
    await findOrCreatePrincipal({ models, pii: { name: "B", email: "b@example.com", phone: "2" } });

    await assert.rejects(
      () => updatePrincipalContact({ models, principalId: a.principal.principalId, pii: { email: "b@example.com" } }),
      (e) => e.status === 409,
      "must refuse rather than silently merge two people's records"
    );
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test test/principal.test.js`
Expected: FAIL - `newPrincipalId` is not exported.

- [ ] **Step 3: Write `src/models/Principal.js`**

```js
const { Schema } = require("mongoose");

/**
 * A data principal's identity and contact details.
 *
 * Deliberately separate from ConsentRecord: the Act requires PII to be
 * erasable on request AND requires the fiduciary to retain proof it had a
 * lawful basis. With PII and the ledger in one document those two duties are
 * mutually exclusive - deleting the document destroys the evidence, and
 * blanking required PII fields fails validation. Splitting them lets erasure
 * clear this document while the pseudonymous ledger survives.
 *
 * emailHash / phoneHash are keyed HMACs, not bare hashes, so knowing an
 * email does not let anyone compute the lookup key. They are the only
 * queryable form of the contact details.
 */
const principalSchema = new Schema({
  principalId: { type: String, required: true, unique: true, index: true },
  emailHash: { type: String, index: true, sparse: true },
  phoneHash: { type: String, index: true, sparse: true },
  pii: {
    name: String,
    email: String,
    phone: String,
    dob: Date,
    pan: String,
    address: String,
  },
  erasedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = {
  schema: principalSchema,
  build: (connection) => connection.model("Principal", principalSchema),
};
```

Note: no PII field is `required`. That is deliberate - erasure must be able to blank them (H9).

- [ ] **Step 4: Rewrite `src/utils/principalId.js`**

```js
const crypto = require("node:crypto");
const { AppError } = require("./errors");
const { assertPrincipalId } = require("./validate");

/**
 * A data principal's identifier is RANDOM, not derived.
 *
 * It used to be sha256(email), which meant anyone who knew a person's email
 * could compute their identifier and act as them against every endpoint.
 * A random id carries no information and cannot be guessed.
 */
function newPrincipalId() {
  return crypto.randomBytes(32).toString("hex");
}

function secret() {
  const s = process.env.PRINCIPAL_ID_SECRET;
  if (!s) {
    throw new AppError(
      "PRINCIPAL_ID_SECRET is not set - it is required to derive contact lookup hashes. Generate one with: openssl rand -hex 32",
      500
    );
  }
  return s;
}

/**
 * Keyed, one-way lookup hash for a contact detail. Keyed so that an attacker
 * who knows the email cannot compute the stored value; normalised so that
 * casing and stray whitespace still match the same person.
 *
 * Pseudonymous, not anonymous - the output is still personal data.
 */
function lookupHash(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("A non-empty string is required to derive a lookup hash", 400);
  }
  return crypto.createHmac("sha256", secret()).update(value.trim().toLowerCase()).digest("hex");
}

/**
 * Reference id. 8 random bytes rather than 3 - the old 24 bits inside a
 * single millisecond made same-millisecond collisions plausible, and the
 * timestamp prefix made references partially predictable.
 */
function generateDocRef(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
}

/**
 * SIGNUP path. Finds an existing principal by whichever contact detail is the
 * stronger identifier, and creates one if there is no match.
 *
 * Matching rule, and why it is not "either hash matches":
 *
 *   - email supplied -> match on emailHash ONLY.
 *   - no email       -> match on phoneHash.
 *
 * A phone number is not a person. The stated audience is social and public
 * sector beneficiaries, who routinely share one handset across a household, so
 * "same phone" cannot mean "same data principal": if a mother registers with
 * phone X and her daughter then registers a different email with phone X,
 * matching on phone would either hand the daughter her mother's record or - once
 * the router's existence check is in place - refuse to register the daughter at
 * all. Neither is acceptable.
 *
 * That means a plain email correction is NOT inferred here (an email that
 * matches nothing creates a new principal). Correcting an email is an
 * authenticated operation - see updatePrincipalContact, which takes identity
 * from the session rather than guessing it from the payload. That is the same
 * principle as C1: never infer identity from caller-supplied contact details.
 */
async function findOrCreatePrincipal({ models, pii }) {
  if (!pii || typeof pii !== "object") throw new AppError("pii is required", 400);
  const { name, email, phone } = pii;
  if (!name || typeof name !== "string") throw new AppError("pii.name is required", 400);
  if (!email && !phone) throw new AppError("pii.email or pii.phone is required", 400);
  if (email && typeof email !== "string") throw new AppError("pii.email must be a string", 400);
  if (phone && typeof phone !== "string") throw new AppError("pii.phone must be a string", 400);

  const emailHash = email ? lookupHash(email) : undefined;
  const phoneHash = phone ? lookupHash(phone) : undefined;

  // Email is the stronger identifier. Fall back to phone only when there is no
  // email at all - see the docstring on why a shared phone must not merge two
  // people.
  const filter = emailHash ? { emailHash } : { phoneHash };
  let principal = await models.Principal.findOne(filter);
  const created = !principal;

  if (created) {
    principal = new models.Principal({ principalId: newPrincipalId() });
  }

  principal.pii = { ...(principal.pii ? principal.pii.toObject() : {}), ...pii };
  if (emailHash) principal.emailHash = emailHash;
  if (phoneHash) principal.phoneHash = phoneHash;
  principal.updatedAt = new Date();
  await principal.save();

  return { principal, created };
}

/**
 * Read-only lookup by contact details. Creates nothing, modifies nothing.
 *
 * The router needs this to decide whether POST /consent is a signup or an
 * update BEFORE it writes anything. Deciding after the write - by reading
 * findOrCreatePrincipal's `created` flag - would mean an unauthenticated
 * caller had already overwritten an existing person's name, phone, PAN and
 * address by the time the 409 was sent, which is the whole of the C1 attack.
 */
async function findPrincipalByContact({ models, email, phone }) {
  // Must use the SAME matching rule as findOrCreatePrincipal, or the router's
  // existence check and the service's lookup disagree: the router would 409 a
  // person the service would have treated as new, or vice versa.
  if (email && typeof email === "string") {
    return models.Principal.findOne({ emailHash: lookupHash(email) });
  }
  if (phone && typeof phone === "string") {
    return models.Principal.findOne({ phoneHash: lookupHash(phone) });
  }
  return null;
}

/**
 * AUTHENTICATED contact correction. Identity comes from principalId - which the
 * router takes from resolvePrincipal, never from the payload - so correcting an
 * email cannot be used to reach another person's record.
 *
 * This is the path that satisfies the Section 12 right to correction without
 * orphaning the consent history, and it is deliberately separate from signup:
 * inferring "same person" from a shared phone number would merge two members of
 * a household who share a handset.
 */
async function updatePrincipalContact({ models, principalId, pii }) {
  assertPrincipalId(principalId);
  if (!pii || typeof pii !== "object") throw new AppError("pii is required", 400);

  const principal = await models.Principal.findOne({ principalId });
  if (!principal) throw new AppError("No principal found for that id", 404);

  // If the new contact detail already belongs to someone else, refuse rather
  // than silently merging two people's records.
  for (const [field, hashField] of [["email", "emailHash"], ["phone", "phoneHash"]]) {
    if (!pii[field]) continue;
    const hash = lookupHash(pii[field]);
    const clash = await models.Principal.findOne({ [hashField]: hash, principalId: { $ne: principalId } });
    if (clash) throw new AppError(`That ${field} is already registered to another data principal`, 409);
    principal[hashField] = hash;
  }

  principal.pii = { ...(principal.pii ? principal.pii.toObject() : {}), ...pii };
  principal.updatedAt = new Date();
  await principal.save();
  return principal;
}

async function findPrincipalById({ models, principalId }) {
  assertPrincipalId(principalId);
  return models.Principal.findOne({ principalId });
}

module.exports = {
  newPrincipalId,
  lookupHash,
  generateDocRef,
  findOrCreatePrincipal,
  findPrincipalByContact,
  findPrincipalById,
  updatePrincipalContact,
};
```

- [ ] **Step 5: Register `Principal` in `src/models/index.js`**

Add `const Principal = require("./Principal");` and `Principal: Principal.build(connection),` as the first entry of the `models` object.

- [ ] **Step 6: Write `src/services/erasure.js`**

```js
const { assertPrincipalId } = require("../utils/validate");
const { AppError } = require("../utils/errors");

/**
 * Erases a data principal's PII while preserving the consent ledger.
 *
 * The ledger is the fiduciary's own evidence that it had a lawful basis for
 * the processing it already did, so it is retained - pseudonymously, keyed
 * only by the random principalId. Erasure therefore clears the Principal
 * document's contact details and its lookup hashes, which also means the
 * person can never be re-identified from this system by email or phone.
 *
 * This is irreversible by design.
 *
 * KNOWN LIMIT, and it must stay documented rather than implied away: this
 * clears the Principal document only. A data principal who typed their own
 * name, email or address into the free-text body of a grievance, a rights
 * request or a consent-manager request still has that text in those
 * collections, and this function does not touch it. Redacting free text is a
 * judgement call an automated pass gets wrong, so it is left to the
 * fiduciary's own process - but a deployment that treats this function as
 * completing a Section 12 erasure request, without also reviewing those three
 * collections, has not completed it.
 */
async function erasePrincipalPII({ models, principalId }) {
  assertPrincipalId(principalId);

  const principal = await models.Principal.findOne({ principalId });
  if (!principal) throw new AppError("No principal found for that id", 404);
  if (principal.erasedAt) return { principalId, erasedAt: principal.erasedAt, alreadyErased: true };

  const erasedAt = new Date();
  principal.pii = { name: undefined, email: undefined, phone: undefined, dob: undefined, pan: undefined, address: undefined };
  principal.emailHash = undefined;
  principal.phoneHash = undefined;
  principal.erasedAt = erasedAt;
  principal.updatedAt = erasedAt;
  await principal.save();

  return { principalId, erasedAt, alreadyErased: false };
}

module.exports = { erasePrincipalPII };
```

- [ ] **Step 7: Write `test/erasure.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
const { buildModels } = require("../src/models");
const { findOrCreatePrincipal } = require("../src/utils/principalId");
const { erasePrincipalPII } = require("../src/services/erasure");

test("erasure clears PII but preserves the consent ledger", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal } = await findOrCreatePrincipal({
      models,
      pii: { name: "Asha", email: "asha@example.com", phone: "9876543210" },
    });
    const id = principal.principalId;

    await models.ConsentRecord.create({
      principalId: id,
      docRef: "CN-TEST-0002",
      events: [{ type: "marketing", status: "granted", basis: "Your consent", lawfulBasisKind: "consent", receiptId: "RC-1", timestamp: new Date() }],
    });

    await erasePrincipalPII({ models, principalId: id });

    const after = await models.Principal.findOne({ principalId: id });
    assert.equal(after.pii.name, undefined);
    assert.equal(after.pii.email, undefined);
    assert.equal(after.emailHash, undefined, "lookup hashes must go too, or the person stays re-identifiable");
    assert.ok(after.erasedAt);

    const ledger = await models.ConsentRecord.findOne({ principalId: id });
    assert.equal(ledger.events.length, 1, "the lawful-basis evidence must survive erasure");
    assert.equal(ledger.events[0].status, "granted");
  });
});

test("erasure is idempotent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal } = await findOrCreatePrincipal({ models, pii: { name: "A", phone: "1" } });
    await erasePrincipalPII({ models, principalId: principal.principalId });
    const second = await erasePrincipalPII({ models, principalId: principal.principalId });
    assert.equal(second.alreadyErased, true);
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: all files pass. `test/principal.test.js` 5/5, `test/erasure.test.js` 2/2.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: split PII from the ledger, randomise principalId

Closes H9, H10, L11 and the identity half of C1.

principalId was sha256(lowercased email) - unsalted and unkeyed - so
anyone who knew a data principal's email could compute their identifier
and act as them. It also meant correcting an email (a Section 12 right)
derived a different id, orphaning the entire consent history, and a
beneficiary with no email address could not be registered at all.

PII and the ledger also shared one document with required PII fields,
which made erasure and audit retention mutually exclusive: deleting
destroyed the lawful-basis evidence, and blanking failed validation.

- principalId is now 32 random bytes, carrying no information
- new Principal model holds erasable PII, no field required
- contact lookup uses a keyed HMAC so the email does not yield the key
- findOrCreatePrincipal matches on email OR phone hash, so an email
  correction keeps the same identity and a phone-only principal works
- erasePrincipalPII clears PII and lookup hashes, retains the ledger
- generateDocRef widened from 3 to 8 random bytes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

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

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
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

### Task 6: Lawful basis model

**Closes:** H1, L5

**Files:**
- Rewrite: `src/config/catalog.js`
- Create: `test/catalog.test.js`

**Interfaces:**
- Produces:
  - `CONSENT_CATALOG` entries shaped `{ type, title, purpose, lawfulBasis: { kind, clause, description }, withdrawable, retentionMonths }`.
  - `getCatalog()`, `getValidConsentTypes()`, `getWithdrawableTypes()` - **functions**, not frozen arrays (M3).
  - `RIGHTS_CATALOG` with corrected descriptions.
  - `FIDUCIARY` unchanged in shape.

**The substantive fix:** the Act recognises consent plus an enumerated list of legitimate uses. It has no general contractual-necessity ground. `underwriting` was marked non-withdrawable on the basis "Necessary to perform your loan contract", which is a GDPR concept - so the toolkit refused a withdrawal the statute guarantees. Underwriting becomes consent-based and withdrawable. The old single `kyc` purpose is split: `kyc_reporting` cites Section 7(d) (the only clause a private fiduciary's statutory duty can rest on, and only for disclosure to the State) and stays non-withdrawable, while `identity_verification` - our own checks and record-keeping, which go beyond that disclosure duty - becomes consent-based and withdrawable.

- [ ] **Step 1: Write the failing test `test/catalog.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { getCatalog, getValidConsentTypes, getWithdrawableTypes, RIGHTS_CATALOG } = require("../src/config/catalog");

// The real Section 7 sub-clauses, verified against the statute text. A
// legitimate use must cite one of these exactly. A prefix check like
// /^Section 7/ would bless "Section 7(b)" for a private lender's KYC, which is
// the State subsidy clause - so pin the enumeration instead.
const ALLOWED_S7_CLAUSES = [
  "Section 7(a)", "Section 7(b)", "Section 7(c)", "Section 7(d)", "Section 7(e)",
  "Section 7(f)", "Section 7(g)", "Section 7(h)", "Section 7(i)",
];

test("no purpose claims contractual necessity as a lawful basis", () => {
  for (const entry of getCatalog()) {
    assert.notMatch(
      entry.lawfulBasis.description,
      /contract/i,
      `${entry.type}: the Act has no contractual-necessity ground - use consent or a cited legitimate use`
    );
    assert.ok(["consent", "legitimate_use"].includes(entry.lawfulBasis.kind));
    if (entry.lawfulBasis.kind === "legitimate_use") {
      assert.ok(
        ALLOWED_S7_CLAUSES.includes(entry.lawfulBasis.clause),
        `${entry.type}: "${entry.lawfulBasis.clause}" is not a real Section 7 sub-clause`
      );
    }
  }
});

test("no legitimate use claims a general compliance-with-legal-obligation ground", () => {
  // Section 7 contains no such ground for a private fiduciary. 7(d) is confined
  // to disclosure obligations owed to the State, so a description asserting a
  // broad legal-obligation basis is a misstatement of the Act.
  for (const entry of getCatalog()) {
    if (entry.lawfulBasis.kind !== "legitimate_use") continue;
    assert.doesNotMatch(
      entry.lawfulBasis.description,
      /compliance with a legal obligation/i,
      `${entry.type}: no such ground exists - cite what the clause actually authorises`
    );
  }
});

test("underwriting is consent-based and therefore withdrawable", () => {
  const u = getCatalog().find((e) => e.type === "underwriting");
  assert.equal(u.lawfulBasis.kind, "consent");
  assert.equal(u.withdrawable, true);
  assert.ok(getWithdrawableTypes().includes("underwriting"));
});

test("the PMLA reporting duty rests on 7(d) and is not withdrawable", () => {
  const k = getCatalog().find((e) => e.type === "kyc_reporting");
  assert.equal(k.lawfulBasis.kind, "legitimate_use");
  assert.equal(k.lawfulBasis.clause, "Section 7(d)");
  assert.equal(k.withdrawable, false);
});

test("identity verification beyond the disclosure duty is consent-based and withdrawable", () => {
  // The 7(d) cover extends only to disclosing information to the State. Our own
  // verification and record-keeping is wider, so it needs consent.
  const v = getCatalog().find((e) => e.type === "identity_verification");
  assert.equal(v.lawfulBasis.kind, "consent");
  assert.equal(v.withdrawable, true);
});

test("the derived lists reflect catalog changes made after import", () => {
  const before = getValidConsentTypes().length;
  getCatalog().push({
    type: "research", title: "Impact research", purpose: "Programme evaluation",
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true, retentionMonths: 12,
  });
  assert.equal(getValidConsentTypes().length, before + 1, "derived lists must not be import-time snapshots");
  assert.ok(getValidConsentTypes().includes("research"));
  getCatalog().pop();
});

test("the erasure right is not described with a precondition the Act does not impose", () => {
  const erasure = RIGHTS_CATALOG.find((r) => r.key === "erasure");
  assert.doesNotMatch(
    erasure.description,
    /no longer needed/i,
    "the principal's request is the trigger; retention necessity is the fiduciary's exception to argue"
  );
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test test/catalog.test.js`
Expected: FAIL on all five - the current catalog uses `basis`/`required` and says "no longer needed".

- [ ] **Step 3: Rewrite `src/config/catalog.js`**

```js
// ---------------------------------------------------------------------------
// Consent catalog - the purposes this fiduciary processes personal data for.
//
// Under the Digital Personal Data Protection Act, 2023 there are exactly two
// kinds of lawful basis: the data principal's consent, and the enumerated
// "certain legitimate uses" in Section 7. There is NO general
// contractual-necessity ground - that is GDPR Article 6(1)(b), and it does
// not exist here. So a purpose is either consent-based and withdrawable, or
// it cites a specific Section 7 clause and is not.
//
// Getting this wrong is not cosmetic: a purpose wrongly marked
// non-withdrawable makes this toolkit refuse a withdrawal the statute
// guarantees.
// ---------------------------------------------------------------------------
const CONSENT_CATALOG = [
  // IMPORTANT - read before changing this entry.
  //
  // Section 7 has NO general "compliance with a legal obligation" ground for a
  // private data fiduciary. The clauses were checked against the statute text:
  //   7(b) - the State providing a subsidy, benefit, service, certificate,
  //          licence or permit. Nothing to do with a private lender.
  //   7(c) - the State performing a function under law.
  //   7(d) - "fulfilling any obligation under any law ... on any person to
  //          disclose any information to the State or any of its
  //          instrumentalities". THIS is the only clause a private fiduciary's
  //          statutory duty can rest on, and only for the DISCLOSURE limb.
  //
  // So the PMLA reporting obligation - handing prescribed information to the
  // Financial Intelligence Unit - fits 7(d). Verifying a customer's identity
  // for our OWN records goes beyond that disclosure duty, and processing for
  // that purpose needs consent under Section 6. Modelling the whole of "KYC"
  // as non-withdrawable would repeat exactly the mistake H1 was raised for:
  // refusing a withdrawal the Act guarantees, on a basis that does not cover it.
  {
    type: "kyc_reporting",
    title: "Anti-money-laundering reporting",
    purpose:
      "Reporting the information the law requires us to report about you to the Financial Intelligence Unit.",
    lawfulBasis: {
      kind: "legitimate_use",
      clause: "Section 7(d)",
      description:
        "Obligation under law to disclose information to the State - reporting under the Prevention of Money-Laundering Act, 2002",
    },
    withdrawable: false,
    prohibitedForChildren: false,
    retentionMonths: 60,
  },
  {
    type: "identity_verification",
    title: "Identity verification (KYC checks)",
    purpose: "Checking that you are who you say you are, and keeping a record of that check.",
    // Consent-based: this is our own verification and record-keeping, which is
    // wider than the Section 7(d) disclosure obligation above, so it does not
    // inherit that clause's cover.
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true,
    prohibitedForChildren: false,
    retentionMonths: 60,
  },
  {
    type: "underwriting",
    title: "Loan underwriting and credit assessment",
    purpose: "Assessing whether we can offer you a loan, and on what terms.",
    lawfulBasis: {
      kind: "consent",
      clause: "Section 6",
      description: "Your consent",
    },
    // Consent-based, so withdrawable. Withdrawing it may mean we cannot
    // continue the service - that is a commercial consequence, and it is not
    // a reason to refuse the withdrawal.
    withdrawable: true,
    retentionMonths: 60,
  },
  {
    type: "marketing",
    title: "Marketing and personalised offers",
    purpose: "Telling you about products we think you will want.",
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true,
    retentionMonths: 24,
  },
  {
    type: "analytics",
    title: "Product analytics and improvement",
    purpose: "Understanding how our product is used so we can improve it.",
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true,
    retentionMonths: 24,
  },
];

// Functions, not module-level snapshots. Snapshots meant that an adopter who
// customised the catalog at boot got a half-applied change: the validator
// rejected the new purpose while the event writer happily wrote events for it.
const getCatalog = () => CONSENT_CATALOG;
const getValidConsentTypes = () => CONSENT_CATALOG.map((c) => c.type);
const getWithdrawableTypes = () => CONSENT_CATALOG.filter((c) => c.withdrawable).map((c) => c.type);
const getConsentBasedTypes = () => CONSENT_CATALOG.filter((c) => c.lawfulBasis.kind === "consent").map((c) => c.type);
const getCatalogEntry = (type) => CONSENT_CATALOG.find((c) => c.type === type);
```

`RIGHTS_CATALOG` - fix the erasure description (L5) and keep the verified section numbers:

```js
const RIGHTS_CATALOG = [
  { key: "access", title: "Right to access information", section: "Section 11",
    description: "Get a summary of the personal data we hold about you, what we are doing with it, and who we have shared it with." },
  { key: "correction", title: "Right to correction and completion", section: "Section 12",
    description: "Ask us to correct inaccurate personal data, complete what is incomplete, or update what is out of date." },
  { key: "erasure", title: "Right to erasure", section: "Section 12",
    description: "Ask us to delete the personal data we hold about you. We must comply unless the law requires us to keep it - we will tell you which, and why." },
  { key: "nominate", title: "Right to nominate", section: "Section 14",
    description: "Name someone to exercise these rights on your behalf if you die or become incapacitated." },
  { key: "grievance", title: "Right to grievance redressal", section: "Section 13",
    description: "Raise a complaint with our Grievance Officer. If it is not resolved in time, you may complain to the Data Protection Board." },
];
```

Export both the functions and, for backwards compatibility with `src/index.js`, `CONSENT_CATALOG` and `RIGHTS_CATALOG` directly.

- [ ] **Step 4: Run the tests**

Run: `node --test test/catalog.test.js`
Expected: PASS 5/5

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: model lawful basis on the Act, not on GDPR

Closes H1, L5, M3.

The catalog marked underwriting non-withdrawable with the basis
'Necessary to perform your loan contract', attributed to Section 7. The
Act has no general contractual-necessity ground - it has consent plus the
enumerated legitimate uses in Section 7 - so the toolkit was refusing a
withdrawal the statute guarantees. Underwriting is consent-based and
withdrawable.

The single kyc purpose is also split, because Section 7 has no general
compliance-with-legal-obligation ground for a private fiduciary. Checked
against the statute: 7(b) is the State issuing a subsidy or licence, 7(c)
is the State performing a function under law, and 7(d) - the only clause
that can carry a private duty - is confined to disclosing information to
the State. So kyc_reporting cites 7(d) for the PMLA reporting obligation
and stays non-withdrawable, while identity_verification, which is our own
record-keeping and wider than that disclosure duty, is consent-based and
withdrawable. Citing 7(b) here would have repeated the same class of
error this commit fixes.

- lawfulBasis { kind, clause, description } replaces basis + required
- withdrawable is derived from the basis kind, not set by hand
- the catalog test pins an allow-list of real Section 7 sub-clauses
  instead of matching a /^Section 7/ prefix, which would bless any letter
- derived type lists become functions, so a catalog customised at boot no
  longer half-applies
- the erasure right no longer tells the principal it only covers data
  'no longer needed' - their request is the trigger, and retention
  necessity is the fiduciary's exception to raise
- each purpose gains a plain-language purpose string and a retention
  period, both needed for the Section 5 notice

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---

### Task 7: Non-destructive consent writes

**Closes:** C3, M5, M4, M7, M9

**Files:**
- Rewrite: `src/services/persistPIIwithconsent.js`
- Rewrite: `src/services/withdrawConsent.js`
- Create: `test/consent.test.js`

**Interfaces:**
- Consumes: `findOrCreatePrincipal` (T4), catalog getters (T6).
- Produces:
  - `persistPIIwithconsent({ models, pii, consentTypes, regrant, notice })` returns `{ docRef, receiptId, principalId, created, events, state }`. Only appends events representing an actual state change.
  - `withdrawConsent({ models, principalId, consentTypes, onWithdrawal })` returns `{ docRef, receiptId, withdrawn, rejected, noChange, effectiveFrom }`.
  - Event statuses: `granted` (chose it), `denied` (offered, declined), `withdrawn` (had it, revoked it).

**Behaviour table to implement exactly:**

| Current state | Submitted | Result |
| --- | --- | --- |
| no event | in `consentTypes` | append `granted` |
| no event | absent | append `denied` |
| `granted` | in `consentTypes` | **no event** - nothing changed |
| `granted` | absent | append `withdrawn` |
| `denied` | in `consentTypes` | append `granted` |
| `denied` | absent | **no event** |
| `withdrawn` | in `consentTypes` | **no event unless `regrant: true`**; with the flag, append `granted` |
| `withdrawn` | absent | **no event** |

- [ ] **Step 1: Write the failing test `test/consent.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
const { buildModels } = require("../src/models");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const withdrawConsent = require("../src/services/withdrawConsent");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };

function statusOf(state, type) {
  return state[type] ? state[type].status : undefined;
}

test("a declined optional purpose is recorded as denied, never as withdrawn", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const r = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    assert.equal(statusOf(r.state, "marketing"), "granted");
    assert.equal(statusOf(r.state, "analytics"), "denied",
      "a purpose that was offered and declined was never granted, so it cannot have been withdrawn");
    const record = await models.ConsentRecord.findOne({ principalId: r.principalId });
    assert.equal(record.events.filter((e) => e.status === "withdrawn").length, 0);
  });
});

test("re-posting the same choices appends no new events", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const first = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const countAfterFirst = (await models.ConsentRecord.findOne({ principalId: first.principalId })).events.length;

    const second = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const countAfterSecond = (await models.ConsentRecord.findOne({ principalId: second.principalId })).events.length;
    assert.equal(countAfterSecond, countAfterFirst, "an unchanged submission must not grow the ledger");
    assert.equal(second.events.length, 0);
  });
});

test("re-posting does NOT silently resurrect a withdrawn consent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });

    // A profile-update screen re-posts with the box still ticked.
    const after = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    assert.equal(statusOf(after.state, "marketing"), "withdrawn",
      "a withdrawal must survive a re-post - reversing it requires an explicit act");
  });
});

test("regrant: true reverses a withdrawal explicitly", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });
    const after = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"], regrant: true });
    assert.equal(statusOf(after.state, "marketing"), "granted");
  });
});

test("a profile update that omits consentTypes does not silently withdraw a live consent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const first = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    // consentTypes omitted entirely - this is a PII update, not a consent decision.
    const after = await persistPIIwithconsent({ models, pii: { ...PII, phone: "9999999999" } });
    assert.equal(statusOf(after.state, "marketing"), "granted", "omitting consentTypes must not revoke anything");
    assert.equal(statusOf(after.state, "analytics"), "granted");
  });
});

test("underwriting can now be withdrawn, and the 7(d) reporting duty still cannot", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["underwriting"] });
    const r = await withdrawConsent({ models, principalId, consentTypes: ["underwriting", "kyc_reporting"] });
    assert.deepEqual(r.withdrawn, ["underwriting"]);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].type, "kyc_reporting");
  });
});

test("withdrawing an already-withdrawn purpose is a no-op, not a duplicate event", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const first = await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });
    const before = (await models.ConsentRecord.findOne({ principalId })).events.length;
    const second = await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });
    const after = (await models.ConsentRecord.findOne({ principalId })).events.length;
    assert.equal(after, before, "a replayed withdrawal must not append a second event");
    assert.deepEqual(second.withdrawn, []);
    assert.deepEqual(second.noChange, ["marketing"]);
    assert.equal(first.effectiveFrom.getTime() <= Date.now(), true);
  });
});

test("each submission gets its own receipt id, distinct from the record ref", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const a = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const b = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    assert.equal(a.docRef, b.docRef, "docRef identifies the record");
    assert.notEqual(a.receiptId, b.receiptId, "a receipt must identify the transaction, not the person");
  });
});

test("an onWithdrawal hook fires with the purposes that actually changed", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    const calls = [];
    await withdrawConsent({
      models, principalId, consentTypes: ["marketing", "kyc_reporting"],
      onWithdrawal: (payload) => calls.push(payload),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].types, ["marketing"], "only real changes are reported, not rejections");
    assert.equal(calls[0].principalId, principalId);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test test/consent.test.js`
Expected: FAIL on most - the current service always rewrites every purpose.

- [ ] **Step 3: Rewrite `persistPIIwithconsent.js`**

```js
const { getCatalog, getCatalogEntry, getValidConsentTypes } = require("../config/catalog");
const { findOrCreatePrincipal, generateDocRef } = require("../utils/principalId");
const { assertStringArray } = require("../utils/validate");
const { AppError } = require("../utils/errors");

/**
 * Records a data principal's consent decisions.
 *
 * Non-destructive by design. An earlier version appended an event for every
 * purpose on every call, which meant a profile update silently withdrew live
 * consents and a re-post silently resurrected a withdrawn one. Here the
 * service computes the delta against current state and appends only events
 * that represent a real change - and reversing a withdrawal requires the
 * caller to say so explicitly with regrant: true.
 *
 * @param {object}   input
 * @param {object}   input.models
 * @param {object}   input.pii            - { name, email?, phone?, dob?, pan?, address? }
 * @param {string[]} [input.consentTypes] - omit entirely for a PII-only update
 * @param {boolean}  [input.regrant]      - allow reversing a prior withdrawal
 * @param {object}   [input.notice]       - Section 5 notice snapshot (Task 8)
 */
async function persistPIIwithconsent({ models, pii, consentTypes, regrant = false, notice } = {}) {
  const consentSubmitted = consentTypes !== undefined;
  const chosen = assertStringArray(consentTypes, "consentTypes");

  const unknown = chosen.filter((t) => !getValidConsentTypes().includes(t));
  if (unknown.length) throw new AppError(`Unknown consent type(s): ${unknown.join(", ")}`, 400);

  const { principal, created } = await findOrCreatePrincipal({ models, pii });
  const principalId = principal.principalId;
  const now = new Date();
  const receiptId = generateDocRef("RC");

  let record = await models.ConsentRecord.findOne({ principalId });
  if (!record) {
    record = new models.ConsentRecord({ principalId, docRef: generateDocRef("CN"), events: [], createdAt: now });
  }
  const state = record.currentState();
  const newEvents = [];

  for (const entry of getCatalog()) {
    const current = state[entry.type] ? state[entry.type].status : undefined;
    const target = decide({ entry, current, chosen, consentSubmitted, regrant });
    if (!target || target === current) continue;
    newEvents.push({
      type: entry.type,
      status: target,
      basis: entry.lawfulBasis.description,
      lawfulBasisKind: entry.lawfulBasis.kind,
      receiptId,
      timestamp: now,
    });
  }

  if (newEvents.length) {
    record.events.push(...newEvents);
    record.updatedAt = now;
  }
  if (notice) record.lastNotice = notice;
  await record.save();

  return {
    docRef: record.docRef, receiptId, principalId, created,
    events: newEvents, state: record.currentState(),
  };
}

/** Implements the state table in the plan. Returns the target status, or null for no change. */
function decide({ entry, current, chosen, consentSubmitted, regrant }) {
  // A legitimate use does not depend on choice - record it once, for notice.
  if (entry.lawfulBasis.kind === "legitimate_use") return current ? null : "granted";
  // A PII-only update carries no consent decision at all.
  if (!consentSubmitted) return null;

  const wants = chosen.includes(entry.type);
  if (wants) {
    if (current === "granted") return null;
    if (current === "withdrawn") return regrant ? "granted" : null;
    return "granted"; // undefined or denied
  }
  // Omitting a non-withdrawable purpose must not withdraw it. No catalog this
  // plan ships can reach here - every consent-based entry is withdrawable - but
  // an adopter who hand-authors a consent-based, non-withdrawable purpose would
  // otherwise find POST /consent silently withdrawing what withdrawConsent
  // explicitly refuses to withdraw. Keep the two in agreement by construction.
  if (current === "granted") return entry.withdrawable ? "withdrawn" : null;
  return current ? null : "denied";
}

module.exports = persistPIIwithconsent;
```

- [ ] **Step 4: Rewrite `withdrawConsent.js`**

```js
const { getCatalogEntry, getValidConsentTypes, getWithdrawableTypes } = require("../config/catalog");
const { assertPrincipalId, assertStringArray } = require("../utils/validate");
const { generateDocRef } = require("../utils/principalId");
const { AppError } = require("../utils/errors");

/**
 * Withdraws consent for one or more purposes. Append-only: never edits or
 * deletes history.
 *
 * Withdrawal triggers a duty to cease processing and erase - which this
 * library cannot perform on the integrator's behalf, since it does not know
 * where else the data went. So it reports what changed through onWithdrawal
 * and leaves the pipeline to the host. Logging the withdrawal without giving
 * the host a way to act on it would be worse than not logging it.
 */
async function withdrawConsent({ models, principalId, consentTypes, onWithdrawal } = {}) {
  assertPrincipalId(principalId);
  const types = assertStringArray(consentTypes, "consentTypes");
  if (!types.length) throw new AppError("consentTypes must include at least one purpose to withdraw", 400);

  const record = await models.ConsentRecord.findOne({ principalId });
  if (!record) throw new AppError("No consent record found for this principal", 404);

  const now = new Date();
  const receiptId = generateDocRef("RC");
  const state = record.currentState();
  const withdrawn = [];
  const rejected = [];
  const noChange = [];

  for (const type of types) {
    if (!getValidConsentTypes().includes(type)) {
      rejected.push({ type, reason: "Unknown consent type" });
      continue;
    }
    if (!getWithdrawableTypes().includes(type)) {
      const entry = getCatalogEntry(type);
      rejected.push({
        type,
        reason: `This purpose rests on ${entry.lawfulBasis.clause} (${entry.lawfulBasis.description}), not on your consent, so it cannot be withdrawn`,
      });
      continue;
    }
    const current = state[type] ? state[type].status : undefined;
    if (current !== "granted") {
      // Already withdrawn, declined, or never granted - nothing to revoke.
      noChange.push(type);
      continue;
    }
    record.events.push({
      type, status: "withdrawn",
      basis: getCatalogEntry(type).lawfulBasis.description,
      lawfulBasisKind: "consent",
      receiptId, timestamp: now,
    });
    withdrawn.push(type);
  }

  // Only persist when something actually changed.
  if (withdrawn.length) {
    record.updatedAt = now;
    await record.save();
    if (typeof onWithdrawal === "function") {
      await onWithdrawal({ principalId, types: withdrawn, effectiveFrom: now, receiptId });
    }
  }

  return { docRef: record.docRef, receiptId, withdrawn, rejected, noChange, effectiveFrom: now };
}

module.exports = withdrawConsent;
```

- [ ] **Step 5: Handle the create race (M7)**

Wrap the `record.save()` for a newly built `ConsentRecord` so a concurrent double-submit does not surface a raw E11000:

The recovery must **recompute** the delta against the winning document, not replay the events computed against the losing one. `newEvents` was derived from an empty state, so re-pushing it onto a record that already has those events would append a duplicate `granted`/`denied` for every purpose - and because the ledger is append-only by design, those duplicates can never be removed. That would break the very invariant this task establishes.

```js
async function saveWithRaceRecovery({ models, record, principalId, notice, now, decideFor }) {
  try {
    await record.save();
    return { record, events: record.$dpdpNewEvents || [] };
  } catch (err) {
    if (!err || err.code !== 11000) throw err;

    // Another request created this principal's record between our findOne and
    // our save. Re-read the winner and recompute the delta against ITS state.
    const existing = await models.ConsentRecord.findOne({ principalId });
    if (!existing) throw err;

    const recomputed = decideFor(existing.currentState());
    if (recomputed.length) {
      existing.events.push(...recomputed);
      existing.updatedAt = now;
    }
    // Re-apply the notice snapshot: it was set on the losing document and
    // would otherwise be silently dropped, taking H3's evidence with it.
    if (notice) {
      existing.lastNotice = { version: notice.version, language: notice.language, body: notice, shownAt: now };
    }
    await existing.save();
    return { record: existing, events: recomputed };
  }
}
```

Structure `persistPIIwithconsent` so the `decide()` loop is a callable taking a state object (`decideFor(state)` returning the event array), then use it for both the first attempt and the recovery. Return the **recomputed** events so the response's `events` array is truthful.

Add a concurrency test: fire two identical `persistPIIwithconsent` calls with `Promise.all` and assert the ledger holds exactly one event per purpose.

- [ ] **Step 6: Run the tests**

Run: `node --test test/consent.test.js`
Expected: PASS 9/9

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix: make consent writes non-destructive and state-aware

Closes C3, M5, M4, M7, M9.

POST /consent appended an event for every catalog purpose on every call,
with no reference to current state. Two symmetrical failures followed: a
profile update that omitted consentTypes silently withdrew every live
optional consent, and a re-post with a box still ticked silently reversed
a withdrawal - no fresh consent act required. Optional purposes the
principal never ticked were also written as 'withdrawn', which claims a
revocation that never happened.

- the service computes a delta against currentState and appends only
  events that represent a real change
- new 'denied' status distinguishes offered-and-declined from revoked
- reversing a withdrawal requires an explicit regrant: true
- omitting consentTypes is a PII-only update and touches no consent
- per-transaction receiptId; docRef stays the record identifier
- withdrawConsent skips no-op withdrawals instead of appending duplicate
  events and moving effectiveFrom forward, and only saves when something
  changed
- onWithdrawal hook reports the purposes that actually changed, so the
  host can run its cessation and erasure pipeline
- concurrent first-write E11000 is recovered instead of surfacing raw

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---

### Task 8: Section 5 notice capture

**Closes:** H3, L6

**Files:**
- Create: `src/config/notice.js`
- Modify: `src/models/ConsentRecord.js` (notice snapshot on the record)
- Modify: `src/services/persistPIIwithconsent.js` (store the notice)
- Modify: `src/services/dataPrincipalRights.js`, `src/services/withdrawConsent.js` (include DPO contact in responses)
- Create: `test/notice.test.js`

**Interfaces:**
- Produces:
  - `buildNotice({ language })` returns `{ language, fiduciary, purposes: [{ type, title, purpose, lawfulBasis, retentionMonths }], rights, grievance, dpo, generatedAt, version }`.
  - `SUPPORTED_NOTICE_LANGUAGES` - `["en"]` plus any configured, with the Eighth Schedule codes documented.
  - `contactBlock()` returning `{ dpoName, dpoEmail }`, added to the return value of `exerciseRight` and `withdrawConsent`.

- [ ] **Step 1: Write the failing test `test/notice.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
const { buildNotice, SUPPORTED_NOTICE_LANGUAGES } = require("../src/config/notice");
const { buildModels } = require("../src/models");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");

test("the notice itemises every purpose with its lawful basis and retention", () => {
  const notice = buildNotice({ language: "en" });
  assert.ok(notice.purposes.length >= 4);
  for (const p of notice.purposes) {
    assert.ok(p.title && p.purpose, "each purpose needs a plain-language description");
    assert.ok(p.lawfulBasis.kind);
    assert.ok(Number.isInteger(p.retentionMonths));
  }
  assert.ok(notice.dpo.email, "the notice must carry the DPO contact");
  assert.ok(notice.rights.length >= 4, "the notice must tell the principal how to exercise their rights");
  assert.ok(notice.version, "a notice snapshot needs a version to be evidence");
});

test("the notice declares its language and rejects an unsupported one", () => {
  assert.equal(buildNotice({ language: "en" }).language, "en");
  assert.ok(SUPPORTED_NOTICE_LANGUAGES.includes("en"));
  assert.throws(() => buildNotice({ language: "kl" }), /language/i);
});

test("the notice shown at consent time is stored with the record", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const notice = buildNotice({ language: "en" });
    const r = await persistPIIwithconsent({
      models,
      pii: { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" },
      consentTypes: ["marketing"],
      notice,
    });
    const record = await models.ConsentRecord.findOne({ principalId: r.principalId });
    assert.equal(record.lastNotice.version, notice.version,
      "without the notice the fiduciary cannot show what the principal was told");
    assert.equal(record.lastNotice.language, "en");
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test test/notice.test.js`
Expected: FAIL - `src/config/notice.js` does not exist.

- [ ] **Step 3: Write `src/config/notice.js`**

```js
const crypto = require("node:crypto");
const { getCatalog, RIGHTS_CATALOG, FIDUCIARY } = require("./catalog");
const { AppError } = require("../utils/errors");

/**
 * Section 5 requires an itemised notice accompanying (or preceding) the
 * request for consent: what personal data, for what purpose, how to exercise
 * rights, and how to complain. Section 5(3) requires it to be available in
 * English or any language in the Eighth Schedule to the Constitution.
 *
 * The notice is generated from the catalog rather than written by hand, so it
 * cannot drift from what the code actually processes - and a hash of it is
 * stored with the consent, because "we obtained consent" is only evidence if
 * you can also show what the person was told.
 *
 * Only 'en' ships here. Add translations by supplying NOTICE_LANGUAGES and a
 * translation map - the structure is deliberately data, not prose, so it can
 * be translated without touching code.
 */
const EIGHTH_SCHEDULE = [
  "as", "bn", "brx", "doi", "gu", "hi", "kn", "ks", "kok", "mai", "ml", "mni",
  "mr", "ne", "or", "pa", "sa", "sat", "sd", "ta", "te", "ur",
];

const SUPPORTED_NOTICE_LANGUAGES = (process.env.NOTICE_LANGUAGES || "en")
  .split(",").map((s) => s.trim()).filter(Boolean);

function buildNotice({ language = "en" } = {}) {
  if (!SUPPORTED_NOTICE_LANGUAGES.includes(language)) {
    throw new AppError(
      `Unsupported notice language: ${language}. Configured: ${SUPPORTED_NOTICE_LANGUAGES.join(", ")}. ` +
      `Section 5(3) permits English or any Eighth Schedule language (${EIGHTH_SCHEDULE.join(", ")}).`,
      400
    );
  }

  const purposes = getCatalog().map((c) => ({
    type: c.type, title: c.title, purpose: c.purpose,
    lawfulBasis: c.lawfulBasis, withdrawable: c.withdrawable,
    retentionMonths: c.retentionMonths,
  }));

  const body = {
    language,
    fiduciary: { name: FIDUCIARY.name },
    purposes,
    rights: RIGHTS_CATALOG.map((r) => ({ key: r.key, title: r.title, section: r.section, description: r.description })),
    grievance: {
      route: "Raise it with our Grievance Officer first. If it is not resolved within the stated period, you may complain to the Data Protection Board.",
      slaDays: FIDUCIARY.grievanceSlaDays,
    },
    dpo: { name: FIDUCIARY.dpoName, email: FIDUCIARY.dpoEmail },
    statute: "Digital Personal Data Protection Act, 2023",
  };

  // Content-addressed version: the same catalog and config always produce the
  // same version, and any change to what we tell people produces a new one.
  const version = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { ...body, version, generatedAt: new Date() };
}

module.exports = { buildNotice, SUPPORTED_NOTICE_LANGUAGES, EIGHTH_SCHEDULE };
```

- [ ] **Step 4: Add the notice snapshot to `ConsentRecord`**

```js
const noticeSnapshotSchema = new Schema(
  { version: { type: String, required: true }, language: { type: String, required: true }, body: { type: Schema.Types.Mixed }, shownAt: { type: Date, default: Date.now } },
  { _id: false }
);
// on consentRecordSchema:
lastNotice: { type: noticeSnapshotSchema, default: undefined },
```

In `persistPIIwithconsent`, replace `if (notice) record.lastNotice = notice;` with:

```js
if (notice) {
  record.lastNotice = { version: notice.version, language: notice.language, body: notice, shownAt: now };
}
```

- [ ] **Step 4b: Wire `buildNotice()` into `POST /consent` - otherwise H3 is not closed**

Add `src/http/router.js` to this task's Files list. Without this step the notice is snapshotted only when a direct service caller hands one in, and the only test exercising it calls the service directly - so over HTTP, which is every consent a real deployment captures, `notice` is `undefined` and `record.lastNotice` is never set. `getConsentState` would always return `notice: null` while the suite reported H3 closed.

In the `POST /consent` handler (and the `PUT /consent` update handler), build the notice and pass it through:

```js
const notice = buildNotice({ language: req.query.lang || DEFAULT_NOTICE_LANGUAGE });
const result = await persistPIIwithconsent({ models, pii, consentTypes, regrant, notice });
```

`GET /consent/new` (T13) must render the same object it will store, so the principal sees exactly what gets snapshotted.

Add an HTTP-level test asserting `record.lastNotice.version` is set after a `POST /consent`, not just after a direct service call.

- [ ] **Step 4c: Add the notice items the Act requires**

Section 5(1) requires the notice to state the personal data and the purpose, **the manner in which the principal may exercise their rights**, and **the manner of making a complaint to the Board**. The DPDP Rules, 2025 add an itemised description of the personal data and the means of withdrawing consent. The `body` object in Step 3 covers purposes, rights and grievance but omits three items. Extend it:

```js
  // Rule 3(b)(i) - an itemised description of the personal data, not just the
  // purposes it is used for.
  personalData: [
    { field: "name", description: "Your full name" },
    { field: "email", description: "Your email address" },
    { field: "phone", description: "Your mobile number" },
    { field: "dob", description: "Your date of birth" },
    { field: "pan", description: "Your PAN, where we are required to collect it" },
    { field: "address", description: "Your postal address" },
  ],
  // Rule 3(c)(i) - how to withdraw, with ease comparable to giving consent.
  withdrawal: {
    description: "You can withdraw consent for any consent-based purpose at any time, as easily as you gave it.",
    path: "/consent/withdraw",
  },
  // Section 5(1)(iii) - the manner of complaining to the Board.
  boardComplaint: {
    description:
      "Raise it with our Grievance Officer first. If it is not resolved within the stated period, you may complain to the Data Protection Board of India directly.",
    grievancePath: "/grievance/new",
  },
```

Also add the Section 6(4) right of withdrawal to `RIGHTS_CATALOG` in T6's catalog, so the notice's `rights` array actually enumerates it - today withdrawal is a right the notice never lists. Tighten the Step 1 test to assert `personalData`, `withdrawal` and `boardComplaint` are all present and non-empty.

- [ ] **Step 4d: Add `NOTICE_LANGUAGES` to `.env.example`**

This step introduces `process.env.NOTICE_LANGUAGES`. `.env.example` is written once in T1 and no later task amends it, so without this the file that L9 exists to make complete ships incomplete again. Append it with its default of `en` and a comment listing the Eighth Schedule codes.

- [ ] **Step 5: Add the DPO contact to rights and withdrawal responses (L6)**

In `src/config/catalog.js`, export:

```js
const contactBlock = () => ({ dpoName: FIDUCIARY.dpoName, dpoEmail: FIDUCIARY.dpoEmail });
```

Add `contact: contactBlock()` to the object returned by `exerciseRight` and by `withdrawConsent`.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: `test/notice.test.js` 3/3 PASS, all previous green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: generate and store the Section 5 notice

Closes H3, L6.

The consent path produced, stored and returned no notice at all, so the
fiduciary could show that a granted event exists on a date but not what
the data principal was told at that moment - and 'we obtained consent' is
only evidence if you can show the notice that preceded it.

- buildNotice() itemises every purpose with its lawful basis, plain
  language description and retention period, generated from the catalog
  so it cannot drift from what the code processes
- content-addressed version, so any change to what we tell people yields
  a new version
- the notice is snapshotted onto the consent record at capture time
- declares its language and validates it against the configured set,
  with the Eighth Schedule codes documented for translators
- rights and withdrawal responses now carry the DPO contact

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---

### Task 9: Age gate and parental consent

**Closes:** H4

**Files:**
- Modify: `src/models/Principal.js` (`isMinor`, `parentalConsent`)
- Modify: `src/services/persistPIIwithconsent.js`
- Create: `test/children.test.js`

**Interfaces:**
- Produces:
  - `ageInYears(dob, asOf)` exported from `src/utils/age.js`.
  - `persistPIIwithconsent` requires `pii.dob`. When the principal is under 18, `parentalConsent: { name, email, relationship, verifiedAt }` is required, and without it the call throws `AppError(…, 422)`.
  - Minors never get tracking/advertising purposes: any purpose flagged `prohibitedForChildren: true` in the catalog is refused even with parental consent.

- [ ] **Step 1: Add the flag to the catalog**

`marketing` and `analytics` gain `prohibitedForChildren: true`. `kyc_reporting`, `identity_verification` and `underwriting` get `false` (T6 already sets it on the first two).

- [ ] **Step 2: Write the failing test `test/children.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
const { buildModels } = require("../src/models");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const { ageInYears } = require("../src/utils/age");

const ADULT_DOB = "1990-04-01";
function minorDob() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 14);
  return d.toISOString().slice(0, 10);
}

test("ageInYears handles the birthday boundary", () => {
  assert.equal(ageInYears("2008-08-07", new Date("2026-08-06")), 17);
  assert.equal(ageInYears("2008-08-07", new Date("2026-08-07")), 18);
});

test("date of birth is required - an age gate cannot work without it", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () => persistPIIwithconsent({ models, pii: { name: "A", email: "a@b.com", phone: "1" }, consentTypes: [] }),
      (e) => e.status === 400 && /dob/i.test(e.message)
    );
  });
});

test("a minor cannot be registered without verifiable parental consent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () => persistPIIwithconsent({
        models,
        pii: { name: "Child", email: "c@example.com", phone: "1", dob: minorDob() },
        consentTypes: [],
      }),
      (e) => e.status === 422 && /parental consent/i.test(e.message)
    );
  });
});

test("tracking and advertising are refused for a minor even with parental consent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const r = await persistPIIwithconsent({
      models,
      pii: { name: "Child", email: "c@example.com", phone: "1", dob: minorDob() },
      consentTypes: ["marketing", "analytics"],
      parentalConsent: { name: "Parent", email: "p@example.com", relationship: "mother", verifiedAt: new Date() },
    });
    assert.equal(r.state.marketing, undefined, "behavioural advertising to a child must never be recorded as granted");
    assert.equal(r.state.analytics, undefined);
    assert.ok(r.refusedForChild.includes("marketing"));
    const principal = await models.Principal.findOne({ principalId: r.principalId });
    assert.equal(principal.isMinor, true);
    assert.equal(principal.parentalConsent.name, "Parent");
  });
});

test("an adult is unaffected", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const r = await persistPIIwithconsent({
      models, pii: { name: "Asha", email: "a@example.com", phone: "1", dob: ADULT_DOB }, consentTypes: ["marketing"],
    });
    assert.equal(r.state.marketing.status, "granted");
    assert.deepEqual(r.refusedForChild, []);
  });
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `node --test test/children.test.js`
Expected: FAIL - no age handling exists.

- [ ] **Step 4: Write `src/utils/age.js`**

```js
/** Whole years between dob and asOf. Returns null for an unparseable date. */
function ageInYears(dob, asOf = new Date()) {
  const birth = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  let age = asOf.getFullYear() - birth.getFullYear();
  const monthDiff = asOf.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < birth.getDate())) age -= 1;
  return age;
}

module.exports = { ageInYears, ADULT_AGE: 18 };
```

- [ ] **Step 5: Add the gate to `persistPIIwithconsent`**

After validating `pii` and before `findOrCreatePrincipal`:

```js
const age = ageInYears(pii && pii.dob);
if (age === null) {
  throw new AppError("pii.dob is required and must be a valid date - the Act requires a child's data to be treated differently, which cannot be done without it", 400);
}
const isMinor = age < ADULT_AGE;
if (isMinor && !isVerifiedParentalConsent(parentalConsent)) {
  throw new AppError("Verifiable parental consent is required before processing a child's personal data", 422);
}
```

And when building events, skip any purpose the catalog marks
`prohibitedForChildren` for a minor, collecting them into `refusedForChild`:

```js
if (isMinor && entry.prohibitedForChildren) { refusedForChild.push(entry.type); continue; }
```

Persist `isMinor` and `parentalConsent` on the `Principal`.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: `test/children.test.js` 5/5 PASS, all previous green.

- [ ] **Step 6b: Document what the gate deliberately does not do**

`parentalConsent` is a **server-side parameter only**. No step wires it into `POST /consent`, into the router, or into any rendered form, and that is intentional: a child filling in their parent's name and a `verifiedAt` timestamp on a public form is not verifiable parental consent, it is a text box. The Rules require the check to be made against reliable details of identity, which this library has no way to perform.

The consequence, which must be stated rather than left for someone to discover: **over HTTP, a minor cannot complete signup at all** - they receive the 422 and there is no field through which a parent's consent can be supplied. That is the correct conservative default for a reference implementation, but it is a gap, not a feature. Add to the package README's "What this is not":

```markdown
- No verifiable parental consent mechanism. The toolkit detects that a data
  principal is under 18 and refuses to process their data, but it cannot verify
  a parent's identity, so there is no HTTP path for a minor to be registered
  even with genuine parental consent. An adopter serving minors must build that
  verification and call `persistPIIwithconsent` with a `parentalConsent` object
  from trusted server-side code. Do not expose that parameter to a form.
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add an age gate and parental consent

Closes H4.

There was no age check anywhere. A 14-year-old could submit the consent
form and the toolkit would record granted events for marketing and
analytics - behavioural advertising and tracking aimed at a child - with
nothing in the code path able to detect it. The schema had an optional
dob field that nothing read.

- pii.dob is now required; an age gate cannot exist without it
- a minor cannot be registered without verifiable parental consent (422)
- purposes flagged prohibitedForChildren are refused for a minor even
  when a parent consents, and reported back in refusedForChild
- isMinor and the parental consent record persist on Principal

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---

### Task 10: The read path

**Closes:** C4

**Files:**
- Create: `src/services/consentState.js`
- Modify: `src/services/dataPrincipalRights.js`, `src/services/complaintToTheBoard.js`, `src/services/consentManagerRequest.js` (list functions)
- Modify: `src/http/router.js` (authenticated GET routes)
- Create: `test/readpath.test.js`

**Interfaces:**
- Produces:
  - `getConsentState({ models, principalId })` returns `{ docRef, principalId, state, ledger, notice, pii, erasedAt }` - `state` is `currentState()`, `ledger` is the full event array.
  - `listRightsRequests({ models, principalId })`, `listGrievances({ models, principalId })`, `listConsentManagerRequests({ models, principalId })`.
  - `getRightsRequest({ models, principalId, refId })` and siblings, each scoped to the owner.
  - Routes: `GET /consent`, `GET /rights/requests`, `GET /rights/requests/:refId`, `GET /grievances`, `GET /grievances/:refId`, `GET /consent-manager/requests` - all behind `requireAuth`.

- [ ] **Step 1: Write the failing test `test/readpath.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
const { buildModels } = require("../src/models");
const createRouter = require("../src/http/router");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const withdrawConsent = require("../src/services/withdrawConsent");
const { getConsentState } = require("../src/services/consentState");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };

test("a principal's full consent history can be read back", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });

    const view = await getConsentState({ models, principalId });
    assert.equal(view.state.marketing.status, "withdrawn");
    assert.equal(view.ledger.length, view.ledger.filter(Boolean).length);
    assert.ok(view.ledger.length >= 2, "the ledger must expose grant and withdrawal, not just current state");
    assert.ok(view.ledger.every((e) => e.timestamp && e.receiptId));
  });
});

test("GET /consent returns the ledger to the authenticated owner only", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    let acting = principalId;
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => acting }));
    const server = app.listen(0);
    const port = server.address().port;
    const get = (p) => fetch(`http://localhost:${port}/dpdp${p}`, { headers: { Accept: "application/json" } });

    try {
      const mine = await get("/consent");
      assert.equal(mine.status, 200);
      const body = await mine.json();
      assert.equal(body.state.marketing.status, "granted");

      // Another principal must not see it.
      acting = "f".repeat(64);
      const theirs = await get("/consent");
      assert.equal(theirs.status, 404, "a different principal must not read this ledger");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test test/readpath.test.js`
Expected: FAIL - `src/services/consentState.js` does not exist.

- [ ] **Step 3: Write `src/services/consentState.js`**

```js
const { assertPrincipalId } = require("../utils/validate");
const { AppError } = require("../utils/errors");

/**
 * The read side of the ledger.
 *
 * Without this the toolkit was write-only: consent was recorded correctly and
 * could not be got out, so the Section 11 right of access it advertises could
 * not be answered, and an auditor asking for a principal's consent history had
 * to be given raw database access. currentState() existed on the model and had
 * no call sites at all.
 */
async function getConsentState({ models, principalId }) {
  assertPrincipalId(principalId);

  const record = await models.ConsentRecord.findOne({ principalId });
  if (!record) throw new AppError("No consent record found for this principal", 404);
  const principal = await models.Principal.findOne({ principalId });

  return {
    docRef: record.docRef,
    principalId,
    state: record.currentState(),
    ledger: record.events.map((e) => ({
      type: e.type, status: e.status, basis: e.basis,
      lawfulBasisKind: e.lawfulBasisKind, receiptId: e.receiptId, timestamp: e.timestamp,
    })),
    notice: record.lastNotice ? { version: record.lastNotice.version, language: record.lastNotice.language, shownAt: record.lastNotice.shownAt } : null,
    pii: principal && !principal.erasedAt ? principal.pii : null,
    erasedAt: principal ? principal.erasedAt : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

module.exports = { getConsentState };
```

- [ ] **Step 4: Add the owner-scoped list and get functions**

Each follows this shape - the `principalId` in the filter is what scopes it:

```js
async function listRightsRequests({ models, principalId }) {
  assertPrincipalId(principalId);
  const rows = await models.RightsRequest.find({ principalId }).sort({ createdAt: -1 }).lean();
  return rows.map(({ refId, right, details, status, createdAt, updatedAt }) => ({ refId, right, details, status, createdAt, updatedAt }));
}
```

- [ ] **Step 5: Wire the authenticated GET routes**

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: `test/readpath.test.js` 2/2 PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add the read path for consent and requests

Closes C4.

The toolkit was write-only. Every GET route served a static form or the
static rights catalog; no route or export read a ConsentRecord,
RightsRequest, Grievance or ConsentManagerRequest. currentState() was
defined, documented in the README, and had zero call sites. So the
Section 11 access right the rights page advertises could not be
answered, the refIds handed to data principals were not actually
trackable, and 'audit trail available at any point in time' meant handing
an auditor raw Mongo access.

- getConsentState() returns current state plus the full event ledger
- owner-scoped list and get functions for all three request types
- authenticated GET routes for each, scoped by principalId so one
  principal can never read another's records

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---

### Task 11: Request lifecycle transitions

**Closes:** H11, L3, L8

**Files:**
- Create: `src/services/requestLifecycle.js`
- Modify: `src/models/RightsRequest.js` (add `slaDueAt`, `resolution`)
- Modify: `src/services/complaintToTheBoard.js` (guard re-escalation)
- Create: `test/lifecycle.test.js`

**Interfaces:**
- Produces:
  - `advanceRightsRequest({ models, refId, status, resolution })`
  - `advanceGrievance({ models, refId, status, resolution })`
  - `advanceConsentManagerRequest({ models, refId, status })`
  - Each validates the transition against an allowed-transition map and throws `AppError(…, 409)` on an illegal one. These are **fiduciary-side** functions - not exposed on the principal-facing router.

- [ ] **Step 1: Write the failing test `test/lifecycle.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
const { buildModels } = require("../src/models");
const { advanceRightsRequest, advanceGrievance } = require("../src/services/requestLifecycle");
const { escalateToBoard } = require("../src/services/complaintToTheBoard");

const PID = "a".repeat(64);

test("a rights request can be advanced through its lifecycle", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await models.RightsRequest.create({ principalId: PID, refId: "RQ-1", right: "erasure", status: "received", slaDueAt: new Date() });

    const inProgress = await advanceRightsRequest({ models, refId: "RQ-1", status: "in_progress" });
    assert.equal(inProgress.status, "in_progress");
    const closed = await advanceRightsRequest({ models, refId: "RQ-1", status: "closed", resolution: "PII erased" });
    assert.equal(closed.status, "closed");
    assert.equal(closed.resolution, "PII erased");
    assert.ok(closed.updatedAt > closed.createdAt, "updatedAt must move when the status changes");
  });
});

test("an illegal transition is refused", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await models.RightsRequest.create({ principalId: PID, refId: "RQ-2", right: "access", status: "closed", slaDueAt: new Date() });
    await assert.rejects(
      () => advanceRightsRequest({ models, refId: "RQ-2", status: "in_progress" }),
      (e) => e.status === 409
    );
  });
});

test("a grievance can reach resolved, which makes the resolved guard reachable", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({ principalId: PID, refId: "GR-1", subject: "s", description: "d", addressedTo: "DPO", status: "open", slaDueAt: past });
    await advanceGrievance({ models, refId: "GR-1", status: "resolved", resolution: "Calls stopped" });
    await assert.rejects(
      () => escalateToBoard({ models, refId: "GR-1", principalId: PID }),
      (e) => /resolved/i.test(e.message)
    );
  });
});

test("re-escalation does not overwrite the original escalation date", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({ principalId: PID, refId: "GR-2", subject: "s", description: "d", addressedTo: "DPO", status: "open", slaDueAt: past });
    const first = await escalateToBoard({ models, refId: "GR-2", principalId: PID });
    await assert.rejects(
      () => escalateToBoard({ models, refId: "GR-2", principalId: PID }),
      (e) => e.status === 409,
      "a second escalation must not silently overwrite escalatedAt"
    );
    const row = await models.Grievance.findOne({ refId: "GR-2" });
    assert.equal(row.escalatedAt.getTime(), first.escalatedAt.getTime());
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test test/lifecycle.test.js`
Expected: FAIL - `src/services/requestLifecycle.js` does not exist.

- [ ] **Step 3: Write `src/services/requestLifecycle.js`**

```js
const { assertNonEmptyString } = require("../utils/validate");
const { AppError } = require("../utils/errors");

/**
 * Fiduciary-side status transitions.
 *
 * Three models declared multi-state status enums that no code could advance,
 * so every request ever filed sat at its initial value forever: a data
 * principal got a refId that could never change state, and the guard in
 * escalateToBoard that checks for a resolved grievance was unreachable.
 *
 * These are back-office operations. They are deliberately NOT mounted on the
 * principal-facing router - a data principal must not be able to close their
 * own grievance, and the fiduciary's staff auth is the host's concern.
 */
const RIGHTS_TRANSITIONS = { received: ["in_progress", "closed"], in_progress: ["closed"], closed: [] };
// "escalated" is deliberately NOT reachable from here. escalateToBoard is the
// only path into that state, because it is the only one that checks the SLA has
// lapsed and sets escalatedAt/escalatedToBoard. Allowing it here would let a
// grievance sit in status "escalated" with escalatedAt null and
// escalatedToBoard false - two fields contradicting each other in the audit
// record - and the re-escalation guard would then dereference null and return
// 500 to a data principal exercising an escalation right.
const GRIEVANCE_TRANSITIONS = { open: ["in_progress", "resolved"], in_progress: ["resolved"], resolved: [], escalated: ["resolved"] };
const CM_TRANSITIONS = { received: ["connected", "closed"], connected: ["closed"], closed: [] };

function assertTransition(map, from, to, kind) {
  const allowed = map[from];
  if (!allowed) throw new AppError(`${kind} is in an unknown state: ${from}`, 409);
  if (!allowed.includes(to)) {
    throw new AppError(`Cannot move ${kind} from ${from} to ${to}. Allowed: ${allowed.join(", ") || "none"}`, 409);
  }
}

async function advance({ model, map, kind, refId, status, resolution, extraFields = {} }) {
  assertNonEmptyString(refId, "refId", 64);
  assertNonEmptyString(status, "status", 32);
  const row = await model.findOne({ refId });
  if (!row) throw new AppError(`No ${kind} found with that reference`, 404);
  assertTransition(map, row.status, status, kind);

  row.status = status;
  if (resolution !== undefined) row.resolution = resolution;
  Object.assign(row, extraFields);
  row.updatedAt = new Date();
  await row.save();
  return row.toObject();
}

const advanceRightsRequest = ({ models, refId, status, resolution }) =>
  advance({ model: models.RightsRequest, map: RIGHTS_TRANSITIONS, kind: "rights request", refId, status, resolution });

const advanceGrievance = ({ models, refId, status, resolution }) =>
  advance({ model: models.Grievance, map: GRIEVANCE_TRANSITIONS, kind: "grievance", refId, status, resolution });

const advanceConsentManagerRequest = ({ models, refId, status }) =>
  advance({ model: models.ConsentManagerRequest, map: CM_TRANSITIONS, kind: "consent manager request", refId, status });

module.exports = { advanceRightsRequest, advanceGrievance, advanceConsentManagerRequest, RIGHTS_TRANSITIONS, GRIEVANCE_TRANSITIONS, CM_TRANSITIONS };
```

- [ ] **Step 4: Guard re-escalation in `escalateToBoard` (L3)**

Null-safe, because a document could reach `escalated` by a route this plan does not control (a direct database edit, or a future caller):

```js
if (grievance.status === "escalated") {
  const when = grievance.escalatedAt ? grievance.escalatedAt.toISOString() : "earlier";
  throw new AppError(`This grievance was already escalated on ${when}`, 409);
}
```

Add a test asserting `advanceGrievance({ status: "escalated" })` is refused with 409.

- [ ] **Step 5: Add the missing schema fields**

`RightsRequest` gains `slaDueAt: { type: Date, required: true }` and `resolution: { type: String, default: "", maxlength: 5000 }`. `exerciseRight` sets `slaDueAt` from a new `RIGHTS_SLA_DAYS` config (default 30).

**`Grievance` also needs `resolution: { type: String, default: "", maxlength: 5000 }`.** It has no such path today, so under Mongoose's default `strict: true` the `advance()` helper's `row.resolution = resolution` is dropped with no error and no warning - the fiduciary's record of *how* a grievance was resolved, which is the substantive output of Section 13 redressal and the first thing an auditor would ask for, silently lost on every closure while the signature and the passing test both imply it was saved. Assert `row.resolution` in the grievance test.

`ConsentManagerRequest` has no `resolution` concept, so `advanceConsentManagerRequest` must not accept the parameter - its signature is `{ models, refId, status }` only.

Also append `RIGHTS_SLA_DAYS` to `.env.example` with its default of 30. That file is written once in T1 and no later task amends it, so a variable introduced here would recreate exactly the L9 gap this branch closed.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: `test/lifecycle.test.js` 4/4 PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add request lifecycle transitions

Closes H11, L3, L8.

RightsRequest, Grievance and ConsentManagerRequest each declared a
multi-state status enum, and the only transition any code could perform
was open -> escalated. Every rights request ever filed therefore sat at
'received' with updatedAt equal to createdAt, the refId given to the data
principal was not actually trackable, and the resolved-grievance guard in
escalateToBoard was unreachable dead code.

- advanceRightsRequest / advanceGrievance / advanceConsentManagerRequest
  with explicit allowed-transition maps, 409 on an illegal move
- deliberately not mounted on the principal-facing router: a data
  principal must not be able to close their own grievance
- RightsRequest gains slaDueAt and resolution, so rights requests are
  measurable the way grievances already were
- re-escalation is refused instead of silently overwriting escalatedAt

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

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

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
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

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
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

### Task 14: Documentation sync and the remaining test cases

**Closes:** M15 (completion), L12, plus README drift introduced by T1-T13

**Files:**
- Rewrite: `data-fiduciary-toolkit/README.md` (API sections)
- Modify: `src/index.js` (export surface)
- Modify: `examples/server.js`
- Create: `test/index.test.js`

- [ ] **Step 1: Write `test/index.test.js`**

Guards the public API against silent drift and asserts the README's documented exports all exist.

```js
const test = require("node:test");
const assert = require("node:assert/strict");
process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
const toolkit = require("../src/index");

test("the documented public API is all exported", () => {
  const expected = [
    "connect", "buildModels", "createRouter",
    "persistPIIwithconsent", "withdrawConsent",
    "listRights", "exerciseRight", "getConsentState",
    "complaintToTheBoard", "escalateToBoard", "consentManagerRequest",
    "erasePrincipalPII",
    "advanceRightsRequest", "advanceGrievance", "advanceConsentManagerRequest",
    "listRightsRequests", "listGrievances", "listConsentManagerRequests",
    "buildNotice", "newPrincipalId",
    "CONSENT_CATALOG", "RIGHTS_CATALOG", "FIDUCIARY",
  ];
  for (const name of expected) {
    assert.ok(toolkit[name] !== undefined, `missing export: ${name}`);
  }
});

test("derivePrincipalId is gone - it was the guessable-identity bug", () => {
  assert.equal(toolkit.derivePrincipalId, undefined,
    "exporting it again would reintroduce sha256(email) as an identifier");
});
```

- [ ] **Step 2: Update `src/index.js`** to export exactly that surface.

- [ ] **Step 3: Update `examples/server.js`**

It must demonstrate `resolvePrincipal`. Use a deliberately minimal, clearly-labelled demo session so the example is not mistaken for production auth:

The session map must actually get populated, or every authenticated route 401s and the example demonstrates nothing beyond `POST /consent`:

```js
require("dotenv").config();
const crypto = require("node:crypto");
const express = require("express");
const { connect, createRouter, buildModels } = require("../src/index");
const { findPrincipalByContact } = require("../src/utils/principalId");

async function main() {
  const db = await connect(process.env.MONGO_URI);
  const models = buildModels(db);
  const app = express();

  // DEMO ONLY - an in-memory token map, not a session store.
  //
  // A real deployment authenticates the data principal (an emailed one-time
  // link, or an existing account session) and returns the principalId from
  // that. It must never trust a client-supplied value: principalId is a
  // database key, not a credential.
  const demoSessions = new Map();

  app.use(express.json());

  // Clearly-labelled demo sign-in, so the rest of the example is reachable.
  // Exchange a contact detail for a token. A real deployment would send a
  // one-time link to that address instead of returning a token here.
  app.post("/demo/login", async (req, res) => {
    const principal = await findPrincipalByContact({ models, email: req.body.email, phone: req.body.phone });
    if (!principal) return res.status(404).json({ error: "no such principal - POST /consent first" });
    const token = crypto.randomBytes(16).toString("hex");
    demoSessions.set(token, principal.principalId);
    res.json({ demoSessionToken: token, hint: "send this as the x-demo-session header" });
  });

  app.use("/", createRouter({
    db,
    resolvePrincipal: (req) => demoSessions.get(req.get("x-demo-session")) ?? null,
    onWithdrawal: async ({ principalId, types }) => {
      // Where a real deployment would tell its processors to stop and run its
      // erasure pipeline. See erasePrincipalPII for the erasure primitive.
      console.log(`[demo] cease processing for ${principalId}: ${types.join(", ")}`);
    },
    onGrievanceFiled: async ({ refId }) => console.log(`[demo] notify the DPO about ${refId}`),
  }));

  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`DPDP toolkit example running on http://localhost:${port}`));
}

main().catch((err) => { console.error("Failed to start:", err); process.exit(1); });
```

Add a header comment to the file giving the end-to-end demo sequence: `POST /consent` to create a principal, `POST /demo/login` to get a token, then any authenticated route with `x-demo-session`.

- [ ] **Step 4: Rewrite the README API sections**

Every documented request and response must match the implementation exactly - the audit found four of the negotiating routes documented wrongly. Include: the new auth requirement and `resolvePrincipal`, the `denied` status, `regrant`, `receiptId` vs `docRef`, `dob` and parental consent, the read endpoints, the lifecycle functions, `onWithdrawal`/`onGrievanceFiled`, and `erasePrincipalPII`. Add a "Migrating from 0.1.0" section stating plainly that `principalId` values from 0.1.0 are email hashes and cannot be carried over.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: every test file passes. Record the total count in the report.

- [ ] **Step 5b: Verify `.env.example` is actually complete**

Run and reconcile - the two lists must match exactly:

```bash
grep -rho 'process\.env\.[A-Z_]*' src/ examples/ | sed 's/.*process\.env\.//' | sort -u
grep -o '^[A-Z_]*' .env.example | grep -v '^$' | sort -u
```

By the end of the branch the set is: `MONGO_URI`, `PRINCIPAL_ID_SECRET`, `FIDUCIARY_NAME`, `FIDUCIARY_DPO_NAME`, `FIDUCIARY_DPO_EMAIL`, `GRIEVANCE_SLA_DAYS`, `RIGHTS_SLA_DAYS`, `NOTICE_LANGUAGES`, `PORT`. Add anything missing.

- [ ] **Step 5c: State M13's real status honestly**

M13 ("install-from-git fails, and `require("dpdp-fiduciary-toolkit")` cannot resolve") is only *documented* by T1, not fixed - npm does not use `repository.directory` for install resolution, it is metadata for source links only. So after this branch, installing from the git URL still fails. Unlike H2 and M14, that was not flagged as a deliberate boundary.

Add to the package README's "What this is not":

```markdown
- Not yet published to npm, and `npm install <git-url>` does not work, because
  `package.json` lives in the `data-fiduciary-toolkit/` subdirectory rather than
  at the repository root. Until it is published, vendor the `src/` directory or
  add it as a path dependency. The `require("dpdp-fiduciary-toolkit")` in the
  examples above is the name it will publish under.
```

And record it in the coverage note alongside H2 and M14 as closed-by-documentation rather than fixed.

- [ ] **Step 6: Verify the packaged file list one more time**

Run: `npm pack --dry-run`
Expected: `src/`, `README.md`, `LICENSE`, `package.json` only.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: sync the README with the remediated API

Closes M15, L12.

- document resolvePrincipal, the auth requirement, and the 409 on an
  unauthenticated update of an existing principal
- document the denied status, regrant, and receiptId vs docRef
- document dob, the age gate, and parental consent
- document the read endpoints and the lifecycle functions
- document onWithdrawal and onGrievanceFiled
- add a Migrating from 0.1.0 note: 0.1.0 principalIds are email hashes
  and cannot be carried forward
- examples/server.js demonstrates resolvePrincipal and both hooks
- test/index.test.js pins the public export surface and asserts
  derivePrincipalId stays gone

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---

## Self-Review

**Spec coverage** - every finding in `reviews.md` maps to a task:

| Task | Findings closed |
| --- | --- |
| T1 | H12, M12, M13, L1, L4, L7, L9, L10, L12 |
| T2 | C2, M14, M15 (harness) |
| T3 | H8, M10 |
| T4 | H9, H10, L11, C1 (identity) |
| T5 | C1 (authorisation), M8 |
| T6 | H1, L5, M3 |
| T7 | C3, M5, M4, M7, M9 |
| T8 | H3, L6 |
| T9 | H4 |
| T10 | C4 |
| T11 | H11, L3, L8 |
| T12 | H5, H7, M1, M2, M6, M11, L2 |
| T13 | H6 |
| T14 | M15 (completion) |

All 4 critical, 12 high, 15 medium, and 12 low findings are assigned. Count check: C1-C4 (4), H1-H12 (12), M1-M15 (15), L1-L12 (12) = 43.

**Two findings need a note on how they are closed rather than fixed:**
- **H2** (no cessation or erasure on withdrawal) is closed by T7's `onWithdrawal` hook plus T4's `erasePrincipalPII`. The library cannot itself notify a processor it does not know about; it gives the host the trigger and the erasure primitive, and the README documents that wiring them is the integrator's duty. This is the honest boundary for a library.
- **M14** (rate limiting) is closed only as to unbounded field lengths and body size. A rate limiter is host middleware, not library code; the README notes it as a deployment requirement.

**Placeholder scan:** no "TBD", no "add appropriate error handling", no "similar to Task N". Every code step carries real code. T2 Step 8 documents an expected failure with the reason and the task that resolves it, which is intentional sequencing rather than a placeholder.

**Type consistency:** `models` is the first destructured parameter of every service. `principalId` is always a 64-char hex string. `buildModels(connection)` is the only model constructor. `generateDocRef(prefix)` keeps its name from the original code. `currentState()` keeps its name and semantics. `wantsHtml(req)` is used everywhere HTML is possible. `AppError(message, status)` is the only error type any service throws deliberately.

**Known interface change to flag at review:** `withdrawConsent`'s `basisByType` module-level constant is deleted in T7 (it read the old `basis` field that T6 removes). Any reference to `entry.basis` or `entry.required` outside these tasks is stale and must be updated to `entry.lawfulBasis.description` / `entry.withdrawable`.
