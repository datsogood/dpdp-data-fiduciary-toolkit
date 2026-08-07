# Task 7 brief

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

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
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
  // Omission means "no consent decision was made"; an empty ARRAY means "I
  // decline everything". null must count as omission, not as a decline:
  // assertStringArray maps both undefined and null to [], so treating null as a
  // submission would walk the granted-plus-absent row for every live purpose and
  // withdraw the lot. A client that serialises an absent value as null rather
  // than dropping the key would silently revoke every optional consent, and the
  // ledger is append-only so it could never be undone.
  const consentSubmitted = consentTypes !== undefined && consentTypes !== null;
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
  }
  // Move updatedAt for a notice-only change too - refreshing the snapshot is a
  // modification of the record even when no consent state changed.
  if (newEvents.length || notice) {
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

  // Deduplicate. ["marketing", "marketing"] would otherwise append two
  // withdrawn events for one purpose, and the ledger is append-only, so a
  // duplicate can never be cleaned up afterwards.
  const requested = [...new Set(types)];
  const withdrawn = [];
  const rejected = [];
  const noChange = [];

  for (const type of requested) {
    if (!getValidConsentTypes().includes(type)) {
      // Must come before getCatalogEntry below - an unknown type has no entry,
      // and dereferencing its lawfulBasis would 500 on attacker input.
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

  // effectiveFrom only when something actually changed. Returning a timestamp
  // for a no-op withdrawal reports a revocation that did not happen, and a host
  // keying off it would act on nothing.
  return {
    docRef: record.docRef,
    receiptId,
    withdrawn,
    rejected,
    noChange,
    effectiveFrom: withdrawn.length ? now : null,
  };
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
