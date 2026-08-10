# Task 11 brief

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

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
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
