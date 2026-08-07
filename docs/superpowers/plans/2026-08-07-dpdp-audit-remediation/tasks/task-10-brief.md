# Task 10 brief

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

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
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
