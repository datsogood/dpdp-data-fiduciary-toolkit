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

- [ ] **Step 4b: (done early) Test infrastructure was fixed before Task 11**

The suite booted one `mongod` per `withDb` call - 76 per full run - which collided on ports often enough to fail whole runs during Tasks 5 and 10, and had grown from 8s to 38s. Waiting until here would have protected only this task's own verification while four earlier tasks and the whole-branch review ran against an unreliable gate, so it was pulled forward.

Now one server per process (so one per test file under `node --test`, 8 rather than 76), each `withDb` getting a fresh database on it, plus a `pretest` binary warm-up. Result: 105/105 across five consecutive runs with no flakes, and 38.4s down to about 19s.

Verify it still holds at the end of the branch: run the suite three times and report each result, rather than assuming it stayed fixed while six tasks added tests.

- [ ] **Step 4c: Sweep the remaining em dashes**

The Global Constraints forbid em and en dashes, and every task enforced it on lines it touched - correctly, under surgical-changes discipline. That leaves pre-existing ones in files no task rewrote wholesale. Known at time of writing: `src/index.js`, `src/models/ConsentManagerRequest.js`, `src/http/forms.js`, `src/services/consentManagerRequest.js`, `src/services/complaintToTheBoard.js`, `src/services/dataPrincipalRights.js`.

```bash
grep -rn $'[\u2013\u2014]' src/ examples/ test/ README.md
```

Replace each with a hyphen. This is the one task allowed to touch those lines, because it is the only one whose remit is the whole surface.

- [ ] **Step 4d: Note the `lastNotice` shape change for anyone with existing data**

Task 8 moved notice bodies out of `ConsentRecord.lastNotice` into the content-addressed `NoticeVersion` collection, leaving `lastNotice` as a `{ version, language, shownAt }` pointer. A document written before that change physically retains its `lastNotice.body` at rest, and Mongoose strict mode drops it silently on the next read or save - so the old body is lost without warning rather than migrated.

The package is unpublished at 0.x and no deployment exists, so no migration script is warranted. But say so plainly in the README's "Migrating from 0.1.0" section rather than letting someone discover it: if you have `ConsentRecord` documents from before this change, copy `lastNotice.body` into `NoticeVersion` keyed by `lastNotice.version` before upgrading, or the text of those notices is gone.

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
