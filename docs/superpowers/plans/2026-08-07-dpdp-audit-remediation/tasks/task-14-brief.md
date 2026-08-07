# Task 14 brief

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
process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
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

- [ ] **Step 4b: Make the suite survive a cold start, and stop it compounding**

Two related problems, both observed for real during this branch:

1. **A cold `mongodb-memory-server` binary cache fails the suite.** `node --test` runs one process per test file, and each calls `MongoMemoryServer.create()`. On a machine that has never downloaded the mongod binary, all of them race for `~/.cache/mongodb-binaries/<version>.lock`, and the losers fail. Observed: 3 of 56 tests failed, each the *first* test in its file, each in about 11ms, with the lock path in the error. So a fresh clone's very first `npm test` fails - and then passes on the second run, which is the worst possible first impression for a compliance toolkit whose selling point is a defensible test suite.

2. **Runtime is compounding.** 8s at Task 2, ~28s by Task 7, and every task since has added a file with its own server.

Fix both by warming the binary once and sharing one server across files. Add to `package.json`:

```json
"scripts": {
  "pretest": "node test/helpers/warm-binary.js",
  "test": "node --test"
}
```

```js
// test/helpers/warm-binary.js
// Downloads and extracts the mongod binary once, before node --test forks a
// process per test file. Without this, a cold cache means every file races for
// ~/.cache/mongodb-binaries/<version>.lock and the losers fail on their first
// test - so a fresh clone's first `npm test` fails and the second passes.
const { MongoMemoryServer } = require("mongodb-memory-server");

(async () => {
  const server = await MongoMemoryServer.create();
  await server.stop();
})().catch((err) => {
  console.error("could not prepare the in-memory MongoDB binary:", err);
  process.exit(1);
});
```

Then pin the mongod version so the cache key is stable rather than drifting with the package's default, and verify: `rm -rf ~/.cache/mongodb-binaries && npm test` must pass first time. State the before and after wall-clock in your report.

If sharing a single server across files proves impractical under `node --test`'s process-per-file model, warming the binary alone fixes problem 1 - do that much, measure problem 2, and report the number rather than leaving it unmeasured.

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
