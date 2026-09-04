# Consent Audit Trail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the lineage of every action a data principal performs over time - including the refusals and silent no-ops that currently vanish - and expose that timeline both to the principal and to back-office staff who hold a contact detail rather than an id.

**Architecture:** One new append-only collection, `TrailEntry`, holding only facts that are destroyed or never written anywhere else. Everything a read can recover from a primary collection - grants, filings, escalations, erasure - is derived at read time and never copied, which makes double-reporting impossible by construction rather than by a dedup pass. Two surfaces sit on top: `GET /consent/trail` for the data principal, and a separate `createBackOfficeRouter` factory whose every disclosure writes a fail-closed access record before it returns anything.

**Tech Stack:** Node >= 20, Express 4 or 5 (peerDependency), Mongoose 8, dotenv. Tests use the built-in `node:test` runner with `mongodb-memory-server`. No new dependency is added by this plan.

**Spec:** [`spec.md`](spec.md) beside this file. The plan argues from the spec; executors read both. Section 4 (the partition rule) is the one section nothing else makes sense without.

## Global Constraints

Every task's requirements implicitly include this section.

- **Writing style:** always use a hyphen ( - ). Never an em dash or en dash. Applies to all code comments, prose, docs, and commit messages.
- **Statute citations:** the Act is the **Digital Personal Data Protection Act, 2023**. Never "DPDP Act, 2025". The DPDP Rules, 2025 are a separate instrument, cited by their own name.
- **`ConsentRecord.events` is not touched.** It is the legal consent ledger with a documented charter (`ConsentRecord.js:3-13`), a three-value status enum, and 23 tests asserting on it - `test/auth.test.js:252` and `:359` byte-compare `JSON.stringify` of it. No task may change what `persistPIIwithconsent` or `withdrawConsent` write to it or return.
- **The trail holds no PII and no free text.** Reference ids, closed enums, content hashes and one host-supplied opaque actor id. `Grievance.description`, `RightsRequest.details` and `ConsentManagerRequest.message` are never copied - that prose survives erasure by documented decision (`erasure.js:21-29`), so putting it in a second collection that also survives erasure would surface PII on a record the system reports as `pii: null`.
- **There is no contact-hash field on `TrailEntry`, and no task may add one.** A row carrying `lookupHash` beside `principalId` rebuilds the email-to-person index erasure exists to destroy; a hash on a lookup that matched nobody creates a permanent identifier for a person who is not a data principal at all. See spec section 5.
- **`principalId` is never read from `req.body` or `req.query` on `createRouter`.** Identity there comes only from `resolvePrincipal(req)`. The back-office router's `POST /principals/trail` is a named carve-out, argued in spec section 8.4; it is the only one, and it is gated by operator auth plus a fail-closed access record.
- **Every value that reaches a Mongoose query filter is validated as a primitive first**, in `src/utils/validate.js`. `sanitizeFilter` is set on the library's own connection and is defence in depth, not the control.
- **The library's own queries cannot use operator filters.** Verified against the installed mongoose 8.24.2: `{at: {$gte: d}}` CastErrors, and so do the query-builder forms `.where("at").gt(d)` and `.gt("at", d)`. Only `mongoose.trusted()` and `aggregate()` escape it, and neither is used anywhere in `src/` today. Write plain equality filters with `.sort()` and `.limit()`.
- **Transactions are unavailable.** `scripts/test-setup.js` starts a standalone `mongod`; verified: "Transaction numbers are only allowed on a replica set member or mongos". Order writes so a partial write is legible instead.
- **Any error a caller should see must be `AppError(msg, <500)`.** Anything else becomes an opaque 500 (`errors.js:1-5`, `router.js:641-651`).
- **New config that must be present belongs in `assertConfigured()`** as a plain `Error`, thrown at boot - not a runtime `AppError`. "Failing to boot is loud, immediate, and fixed by one env var; the alternative fails silently, in front of the data principal" (`catalog.js:39-51`).
- **Catalog readers are functions, never snapshots.** Call `getCatalog()` / `getValidConsentTypes()` / `getCatalogEntry()`; never destructure `CONSENT_CATALOG`.
- **Services take `{ models }` and never import a model.** A new model needs a file exporting `{ schema, build }` plus one hand-added line in `src/models/index.js:19-26`, and must not touch the global mongoose registry - `test/connection.test.js:62-63` asserts it stays clean.
- **Test commands:** `npm test` runs the whole suite. To run one file, invoke it directly: `node --test --test-global-setup=scripts/test-setup.js test/trail.test.js`. **Never `npm test -- test/<file>`** - npm appends the argument and produces a broken two-path form. Every task that changes behaviour ships tests in the same commit.
- **Commit style:** conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`). Message bodies end with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- **Working directory:** all paths below are relative to `data-fiduciary-toolkit/` unless prefixed with `repo-root:`.
- **The PR references issue #4 and does not close it.** Use `Refs #4`, never `Closes #4` - the reviewer closes it.

---

## File Structure

**New files:**

| Path | Responsibility |
| --- | --- |
| `src/models/TrailEntry.js` | The append-only activity trail row. Holds only what is destroyed or never written elsewhere. |
| `src/services/consentTrail.js` | `recordTrail` (fail-open) and `recordTrailStrict` (fail-closed) writers, plus `getConsentTrail` and `findConsentTrailByContact` reads and the `COVERAGE_FROM` constant. |
| `src/http/shared.js` | `wrap`, `errorMapper` and `makeCheckOrigin`, extracted from `router.js` so both routers share one copy of a security check rather than each carrying its own. |
| `src/http/backOfficeRouter.js` | `createBackOfficeRouter` - the fiduciary-facing surface. Deliberately a separate factory so a people-search cannot be mounted on the principal-facing router by a misconfigured `app.use`. |
| `test/trail.test.js` | Model, writer and read tests, including the twelve-act timeline and the PII property scan. |
| `test/backoffice.test.js` | The back-office router: fail-closed auth, the access record, no-disclosure-without-a-record, and injection. |

**Modified:** `src/models/index.js`, `src/utils/validate.js`, `src/services/persistPIIwithconsent.js`, `src/services/withdrawConsent.js`, `src/services/requestLifecycle.js`, `src/services/complaintToTheBoard.js`, `src/utils/principalId.js`, `src/http/router.js`, `src/index.js`, `src/services/erasure.js` (comment only), `README.md`, `test/validate.test.js`.

---

## Task Dependency Order

Task number order, with one thing to watch: **Task 7 must land before Task 8**, because the back-office router imports `src/http/shared.js` and that file does not exist until Task 7 extracts it.

```
1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9
```

| Task | Deliverable | Depends on |
| --- | --- | --- |
| 1 | `TrailEntry` model, registry line, `assertOpaqueRef` | - |
| 2 | The writers: `recordTrail`, `recordTrailStrict`, `COVERAGE_FROM` | 1 |
| 3 | Instrument the consent write path | 2 |
| 4 | Instrument withdrawal, lifecycle, escalation, contact correction | 2 |
| 5 | The read: `getConsentTrail`, `findConsentTrailByContact` | 3, 4 |
| 6 | `GET /consent/trail` and the `assertOwnContact` refusal | 5 |
| 7 | Extract `src/http/shared.js` - pure refactor, suite stays green | - |
| 8 | `createBackOfficeRouter` | 5, 7 |
| 9 | `src/index.js` exports and every documentation edit | 8 |

Task 5 depends on 3 and 4 only for its tests: the twelve-act timeline needs entries those tasks write. The read code itself depends on nothing but Task 1's schema.

---

### Task 1: The TrailEntry model, the registry line, and `assertOpaqueRef`

**Files:**
- Modify: `src/utils/validate.js:3-35`
- Modify: `test/validate.test.js:32` (append two tests)
- Create: `src/models/TrailEntry.js`
- Modify: `src/models/index.js:6-25` (two hand-added lines)
- Test: `test/trail.test.js` (new file)

**Implements:** Spec section 5 (Data model - `trailEntrySchema`, `actorSchema`, `assertOpaqueRef`, the index policy, the "no contact-hash field, at all" invariant), section 6's eleven-kind vocabulary and three-value outcome enum, and residual 4 (the regex bounds shape, not meaning).

**Interfaces:**
- Consumes: `AppError` from `src/utils/errors.js` - `new AppError(message, status = 400)`, sets `err.status`. `buildModels(connection)` from `src/models/index.js`. `withDb(fn)` from `test/helpers/db.js`.
- Produces:
  - `assertOpaqueRef(value, field)` exported from `src/utils/validate.js` - returns `value`, or throws `AppError(msg, 400)`. Task 2 uses it to guard `actor.ref`; Task 8 uses it to guard `caseRef`.
  - `src/models/TrailEntry.js` exporting `{ schema: trailEntrySchema, build: (connection) => connection.model("TrailEntry", trailEntrySchema) }`.
  - `models.TrailEntry` on the registry `buildModels(connection)` returns. Every later task reaches the collection only through this - no task requires the model file directly.
  - The stored document shape every later task writes and reads:
    `{ principalId?, at, kind, outcome, reasonCode?, actor: { role, ref?, channel }, refId?, receiptId?, consentTypes?, fromStatus?, toStatus?, count?, caseRef? }`

Background you need before starting: every service in this repo takes `{ models }` and never imports a model file. `connect()` (`src/db/connection.js`) sets `sanitizeFilter` on the connection, so the library's own queries cannot use operator filters - `{at:{$gte:d}}` CastErrors. Do not write one anywhere in this task. Tests use `node:test` + `node:assert/strict` with no `describe`/`it`, and the whole per-test lifecycle is the `withDb` helper.

---

- [ ] **Step 1: Write the failing `assertOpaqueRef` tests**

Append these two tests to the end of `test/validate.test.js` (the file is 32 lines and holds four tests today), and add `assertOpaqueRef` to the destructured require on line 3 so it reads:

```js
const { assertPrincipalId, assertNonEmptyString, assertStringArray, assertOpaqueRef } = require("../src/utils/validate");
```

```js
test("assertOpaqueRef accepts the staff and ticket references a host actually holds", () => {
  const good = [
    "emp-10432", // a staff id
    "3f2504e0-4f89-11d3-9a0c-0305e82c3301", // a UUID
    "asha.nair", // an LDAP uid
    "INC-0042199", // a ticket reference
    "SUPPORT:2026-0912", // a namespaced ticket reference
    "a".repeat(64), // the longest value the shape allows
  ];
  for (const value of good) {
    assert.equal(assertOpaqueRef(value, "actorRef"), value, `expected ${value} to be accepted`);
  }
});

test("assertOpaqueRef refuses contact details and free text - it is a positive shape, not a blocklist", () => {
  const bad = [
    "asha@example.com", // an email
    "+919876543210", // a phone number
    "+91 98765-43210", // a phone number with punctuation
    "asha nair", // a space, and therefore any sentence
    "", // empty
    "   ", // whitespace only
    "a".repeat(65), // one character over the 64-character ceiling
    "-leading", // the first character must be alphanumeric
    42,
    null,
    undefined,
    { $ne: null }, // an operator object, per this file's existing discipline
  ];
  for (const value of bad) {
    assert.throws(
      () => assertOpaqueRef(value, "actorRef"),
      (err) => err.status === 400,
      `expected rejection for ${JSON.stringify(value)}`
    );
  }
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/validate.test.js`

Expected: FAIL, `ℹ pass 4` / `ℹ fail 2`. Both new tests fail with:

```
TypeError: assertOpaqueRef is not a function
```

and the second one reports it inside the assertion wrapper as `AssertionError [ERR_ASSERTION]: expected rejection for "asha@example.com"` with `actual: TypeError: assertOpaqueRef is not a function`.

- [ ] **Step 3: Add `OPAQUE_REF_RE` and `assertOpaqueRef` to `src/utils/validate.js`**

Three edits to that file. First, immediately after `const PRINCIPAL_ID_RE = /^[a-f0-9]{64}$/;` on line 3, add a blank line and:

```js
// A host-supplied reference to one of the host's own records - a staff id in
// actor.ref, a ticket id in caseRef. Positive shape, deliberately not a
// blocklist: it admits a staff id, a UUID, an LDAP uid and a ticket
// reference, and admits no address, no phone number with punctuation and no
// space, so free text and contact details cannot arrive by accident.
const OPAQUE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
```

Second, insert the function immediately above the existing `function assertStringArray(value, field) {`:

```js
/**
 * Guards actor.ref and caseRef before either is stored on a trail entry or
 * used in a query filter.
 *
 * The shape is positive because this file's only existing discipline is a
 * positive regex (PRINCIPAL_ID_RE above). An earlier draft rejected any value
 * containing "@", which stops an email and nothing else - a staff member's
 * name or a phone number passed it unharmed.
 *
 * It bounds the shape, not the meaning. "johnsmith" still passes, so a host
 * that wires its SSO subject straight through can still put personal data on
 * a collection nothing deletes from. The README states that as a residual
 * rather than implying otherwise.
 */
function assertOpaqueRef(value, field) {
  if (typeof value !== "string" || !OPAQUE_REF_RE.test(value)) {
    throw new AppError(
      `${field} must be 1-64 characters of letters, digits, dot, underscore, colon or hyphen, starting with a letter or digit`,
      400
    );
  }
  return value;
}
```

Third, replace the last line of the file:

```js
module.exports = { assertPrincipalId, assertNonEmptyString, assertStringArray, assertOpaqueRef };
```

Note the regex arithmetic: one leading `[A-Za-z0-9]` plus `{0,63}` is a 64-character ceiling, which is why `"a".repeat(64)` passes and `"a".repeat(65)` does not.

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/validate.test.js`

Expected: PASS, `ℹ pass 6` / `ℹ fail 0`.

- [ ] **Step 5: Commit the validator**

Nothing calls `assertOpaqueRef` yet, so this cannot move any other test. Commit it on its own so the model work below has a clean base.

```bash
git add src/utils/validate.js test/validate.test.js
git commit -m "feat(validate): add assertOpaqueRef for host-supplied opaque references"
```

- [ ] **Step 6: Write the failing model tests**

Create `test/trail.test.js` with exactly this content. The preamble ordering is load-bearing in this suite: `node:test`, `node:assert/strict`, `mongoose` and `./helpers/db` first, then the env assignment, then any `require("../src/...")`.

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
const { buildModels } = require("../src/models");

const PID = "a".repeat(64);

// ---------------------------------------------------------------------------
// The TrailEntry schema (spec section 5)
// ---------------------------------------------------------------------------

test("a trail entry needs only kind, outcome and actor, and stamps `at` itself", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const entry = await models.TrailEntry.create({
      principalId: PID,
      kind: "age_gate_refused",
      outcome: "refused",
      reasonCode: "parental_consent_required",
      actor: { role: "unattributed", channel: "library" },
    });

    assert.ok(entry.at instanceof Date, "`at` defaults to now, so no writer can forget to timestamp a row");
    assert.equal(entry.actor.role, "unattributed");
    assert.equal(entry.actor.channel, "library");
    assert.equal(entry.actor.ref, undefined, "ref is set only for an operator");
  });
});

test("a fully-populated trail entry round-trips every field the spec defines", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const at = new Date("2026-09-04T10:00:00.000Z");
    await models.TrailEntry.create({
      principalId: PID,
      at,
      kind: "request_status_changed",
      outcome: "recorded",
      actor: { role: "operator", ref: "emp-10432", channel: "api" },
      refId: "RQ-ABC123",
      receiptId: "RC-DEF456",
      consentTypes: ["marketing"],
      fromStatus: "received",
      toStatus: "in_progress",
      count: 1,
      caseRef: "INC-0042199",
    });

    const raw = await models.TrailEntry.findOne({ principalId: PID }).lean();
    assert.deepEqual(raw.at, at, "an explicit `at` must be stored verbatim - the default must not overwrite it");
    assert.equal(raw.kind, "request_status_changed");
    assert.equal(raw.outcome, "recorded");
    assert.deepEqual(raw.actor, { role: "operator", ref: "emp-10432", channel: "api" });
    assert.equal(raw.refId, "RQ-ABC123");
    assert.equal(raw.receiptId, "RC-DEF456");
    assert.deepEqual(raw.consentTypes, ["marketing"]);
    assert.equal(raw.fromStatus, "received", "the prior status is the fact requestLifecycle destroys in place");
    assert.equal(raw.toStatus, "in_progress");
    assert.equal(raw.count, 1);
    assert.equal(raw.caseRef, "INC-0042199", "the ticket reference says WHY an access happened, not only by whom");
  });
});

test("the schema refuses a kind, an outcome, an actor role or a missing actor", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const base = { principalId: PID, outcome: "refused", actor: { role: "system", channel: "library" } };

    await assert.rejects(
      () => models.TrailEntry.create({ ...base, kind: "consent_maybe" }),
      (err) => err.name === "ValidationError" && /kind/.test(err.message),
      "the vocabulary is closed - eleven kinds, each because something is otherwise destroyed"
    );
    await assert.rejects(
      () => models.TrailEntry.create({ ...base, kind: "consent_refused", outcome: "sort_of" }),
      (err) => err.name === "ValidationError" && /outcome/.test(err.message),
      "outcome is what stops a refusal from ever reading as a state change"
    );
    await assert.rejects(
      () => models.TrailEntry.create({ principalId: PID, kind: "consent_refused", outcome: "refused" }),
      (err) => err.name === "ValidationError" && /actor/.test(err.message),
      "every row names who acted, even when the honest answer is `unattributed`"
    );
    await assert.rejects(
      () => models.TrailEntry.create({ ...base, kind: "consent_refused", actor: { role: "root", channel: "api" } }),
      (err) => err.name === "ValidationError" && /actor\.role/.test(err.message),
      "role is a closed set - a host cannot invent one"
    );
  });
});

test("consentTypes is a list, so one row can name every purpose a single call refused", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    // Pinned deliberately: a scalar String path rejects an array with
    // "Cast to string failed ... (type Array)", and section 6 collapses a
    // multi-purpose refusal into ONE row rather than one row per purpose.
    await models.TrailEntry.create({
      principalId: PID,
      kind: "consent_refused",
      outcome: "refused",
      reasonCode: "prohibited_for_child",
      actor: { role: "principal", channel: "html" },
      consentTypes: ["marketing", "analytics"],
      count: 2,
    });

    const raw = await models.TrailEntry.findOne({ principalId: PID }).lean();
    assert.deepEqual(raw.consentTypes, ["marketing", "analytics"]);
    assert.equal(raw.count, 2, "count is what makes a collapsed row honest about how many purposes it covers");
  });
});

test("a row with no subject stores principalId ABSENT, never null", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await models.TrailEntry.create({
      kind: "operator_lookup",
      outcome: "recorded",
      reasonCode: "no_match",
      actor: { role: "operator", ref: "emp-10432", channel: "api" },
      caseRef: "INC-0042199",
    });

    const raw = await models.TrailEntry.findOne({ kind: "operator_lookup" }).lean();
    assert.equal(
      Object.hasOwn(raw, "principalId"),
      false,
      "a lookup that matched nobody has no subject at all - a stored null would be a subject-shaped hole later code could read as one"
    );
    assert.equal(raw.caseRef, "INC-0042199");
  });
});

test("buildModels exposes TrailEntry on the given connection and leaves the global registry clean", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    assert.ok(models.TrailEntry, "a service reaches this model only through the registry - it never requires the file");
    assert.equal(models.TrailEntry.db, conn, "the model must be bound to the caller's connection, not a global one");
    assert.ok(!mongoose.models.TrailEntry, "global mongoose registry must stay clean");
  });
});
```

- [ ] **Step 7: Run the test and watch it fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trail.test.js`

Expected: FAIL, `ℹ pass 0` / `ℹ fail 6`. The first five fail with:

```
TypeError: Cannot read properties of undefined (reading 'create')
```

because `models.TrailEntry` does not exist yet. The sixth fails on `assert.ok(models.TrailEntry, ...)` with that assertion's own message.

- [ ] **Step 8: Create `src/models/TrailEntry.js`**

The comment block is not decoration - it is why this collection exists rather than a second copy of the ledger, and it is written at the density `ConsentRecord.js` and `Principal.js` use. Keep it.

```js
const { Schema } = require("mongoose");

/**
 * One entry in a data principal's audit trail.
 *
 * NOT named AuditEvent: ConsentRecord.js already says of the ledger "this is
 * the audit trail DPDP expects a fiduciary to be able to produce", and a
 * second collection claiming that word would contradict a comment that ships
 * today. A trail ENTRY is a part of the trail; the trail itself is the merged
 * read across this collection and four primary ones.
 *
 * The partition rule this schema exists to serve: a row is written here only
 * for a fact that is destroyed, or never written, anywhere else. Anything a
 * read can recover from a primary collection - a grant, a withdrawal, a
 * grievance being filed, an erasure - is derived at read time from its own
 * observed timestamp and is never copied here. That is what makes
 * double-reporting impossible by construction instead of by a dedup pass.
 *
 * It holds no free text and no direct PII, and it survives erasure as
 * pseudonymous evidence exactly as ConsentRecord does. There is deliberately
 * no contact-hash field of any kind: a row carrying both a contact hash and a
 * principalId would rebuild the email-to-person index erasure exists to
 * destroy, and on a lookup that matched nobody it would mint a permanent
 * contact-derived identifier for someone who is not a data principal of this
 * fiduciary at all. An earlier draft closed the first hazard with a schema
 * validator enforcing mutual exclusion; that does not hold, because updateOne
 * does not run document validators and a later $set would co-store both
 * silently. A field that does not exist cannot be set.
 */

// role: `unattributed` is NOT a synonym for `system`. It means the library
// genuinely does not know who acted - a direct service call from host code -
// and claiming "system" would be a claim it cannot back.
//
// ref: set only for an operator. Host-supplied and opaque, guarded by
// assertOpaqueRef in utils/validate.js before it ever reaches this schema.
// Indexed because detecting insider enumeration is a question of per-operator
// volume, and that index is the whole answer to it.
const actorSchema = new Schema(
  {
    role: { type: String, enum: ["principal", "operator", "system", "unattributed"], required: true },
    ref: { type: String, index: true },
    channel: { type: String, enum: ["html", "api", "library"], required: true },
  },
  { _id: false }
);

// Eleven kinds. Every one exists because something is otherwise destroyed -
// there is no kind here whose fact could be read back off a primary
// collection instead.
const KINDS = [
  "consent_not_applied",
  "consent_refused",
  "withdrawal_not_applied",
  "age_gate_refused",
  "request_status_changed",
  "escalation_refused",
  "contact_corrected",
  "contact_mismatch_refused",
  "withdrawal_hook_not_fired",
  "operator_lookup",
  "operator_trail_read",
];

const REASON_CODES = [
  "regrant_not_requested",
  // No task in this plan emits this one. It is the vocabulary for a future
  // caller that wants to record a submission which asked for the state a
  // purpose is already in - today `decide()` returns null for that and the
  // act is indistinguishable from no submission at all.
  "already_in_state",
  "prohibited_for_child",
  // Written by withdrawal_not_applied only (Task 4). The spec's kind table also
  // pairs it with consent_refused, but that pair is deliberately never written:
  // persistPIIwithconsent.js:83-84 throws AppError 400 on an unknown type before
  // any principal is resolved and before any write, so there is no subject to
  // file the row under and no act to record beyond the 400 itself.
  "unknown_consent_type",
  "record_erased",
  "not_withdrawable",
  "not_granted",
  "parental_consent_required",
  "already_resolved",
  "already_escalated",
  "sla_not_lapsed",
  "not_own_contact",
  "no_match",
];

const trailEntrySchema = new Schema({
  // Absent - not null - on the two kinds that have no subject: an age-gate
  // refusal is thrown before findOrCreatePrincipal runs, and a back-office
  // lookup that matched nobody has no principal to file under. A stored null
  // would be a subject-shaped hole a later read could mistake for one.
  principalId: { type: String, index: true },
  at: { type: Date, required: true, default: Date.now },
  kind: { type: String, enum: KINDS, required: true },
  // recorded  - the act took effect
  // refused   - the library declined it and said so
  // no_change - the caller got a 2xx and nothing happened
  //
  // Required, because it is the single field that stops a refusal from ever
  // being read back as a state change.
  outcome: { type: String, enum: ["recorded", "refused", "no_change"], required: true },
  reasonCode: { type: String, enum: REASON_CODES },
  // Required on every row, including the ones whose honest answer is
  // `unattributed`. A trail entry that does not say who acted is not evidence.
  actor: { type: actorSchema, required: true },
  // Reference ids only, never free text. All are random and carry no PII.
  refId: { type: String }, // RQ- / GR- / CM-
  receiptId: { type: String }, // RC-
  // A LIST, because one call refusing three purposes writes one row naming
  // three rather than three rows. Verified - a scalar String path rejects an
  // array with "Cast to string failed ... (type Array)".
  //
  // Every element is validated against getValidConsentTypes() BY THE WRITER
  // and dropped when it does not match. A withdrawal naming an unknown purpose
  // carries caller-supplied text verbatim, and assertStringArray applies no
  // content check, so an email typed into consentTypes would otherwise reach a
  // collection that survives erasure.
  consentTypes: { type: [String], default: undefined },
  // The transition requestLifecycle overwrites in place. updatedAt holds only
  // the last change, so a status that moved received -> in_progress -> closed
  // has its middle transition destroyed unless it is stored here.
  fromStatus: { type: String },
  toStatus: { type: String },
  // Collapsed refusals: one row per (kind, reasonCode) per call. Without it a
  // submission naming 200 consent types would write 200 rows.
  count: { type: Number },
  // The adopter's own ticket reference for a back-office access, so the record
  // says WHY someone was looked up and not only by whom. Host-supplied and
  // opaque; carried only on operator_lookup and operator_trail_read, never
  // rendered back to a data principal. Guarded by assertOpaqueRef.
  caseRef: { type: String },
});

// No compound index, no unique index, no schema.index() call. The repo has
// none today, and under the partition rule the per-principal volume is single
// digits - a compound index would be the first deviation, bought with nothing.
// Ordering is (at desc, _id desc); within one millisecond, insertion order by
// ObjectId is honest and adequate.

module.exports = {
  schema: trailEntrySchema,
  build: (connection) => connection.model("TrailEntry", trailEntrySchema),
};
```

Two mongoose 8 semantics this file depends on, both worth understanding before you move on:

1. `principalId` carries no `default`, so a document created without it has the path genuinely absent from the stored BSON, not set to `null`. `Object.hasOwn(raw, "principalId")` is `false` on the lean document. Adding `default: null` here would break the fifth test and, worse, would put a subject-shaped hole on a row that has no subject.
2. `consentTypes: { type: [String], default: undefined }` is what keeps an unset array absent. Mongoose's default for an array path is `[]`, which would write an empty array onto every row that names no purpose. The `[String]` (rather than `String`) is the IMPL2 fix: a scalar `String` path rejects an array outright.
3. `reasonCode`'s `enum` does not fire for `undefined`, so `request_status_changed` and `contact_corrected` - the two kinds with no reason code - validate cleanly without one.

- [ ] **Step 9: Register the model in `src/models/index.js`**

Two lines, both hand-added. After line 6 (`const NoticeVersion = require("./NoticeVersion");`):

```js
const TrailEntry = require("./TrailEntry");
```

and inside the `models` object literal, after `NoticeVersion: NoticeVersion.build(connection),`:

```js
    TrailEntry: TrailEntry.build(connection),
```

Change nothing else in that file. `buildModels` already caches the registry on `connection.$dpdpModels`, so a second call with the same connection returns the same `TrailEntry` object rather than re-registering the model name (which mongoose throws on).

- [ ] **Step 10: Run the model test and watch it pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trail.test.js`

Expected: PASS, `ℹ pass 6` / `ℹ fail 0`.

- [ ] **Step 11: Run the whole suite**

Run: `npm test`

Expected: `ℹ pass 168` / `ℹ fail 0`. `npm test` reports 160 before this task; the two `assertOpaqueRef` tests and the six trail tests take it to 168. Trust `npm test`'s own total, not a per-file count: verified during execution, `npm test` reports two MORE than the sum of the per-file runs, so a count derived by summing files is 2 low. No existing test needs updating. In particular:

- `test/connection.test.js:62-63` asserts `!mongoose.models.ConsentRecord` - adding a model to the registry does not touch the global mongoose registry, because every model is built with `connection.model(...)`, never `mongoose.model(...)`.
- `test/children.test.js:83` and `:113` assert `ConsentRecord.countDocuments() === 0`. Those count a different collection, and nothing in this task writes any document at runtime - `trailentries` is created lazily on the first insert, which no shipped code performs until Task 2.
- The 23 ledger assertions in `test/consent.test.js` are untouched: `ConsentRecord.events` is not modified by this task.

- [ ] **Step 12: Commit**

```bash
git add src/models/TrailEntry.js src/models/index.js test/trail.test.js
git commit -m "feat(models): add the TrailEntry collection for facts nothing else records"
```

---

### Task 2: The trail writer - `recordTrail` and `recordTrailStrict`

**Files:**
- Create: `src/services/consentTrail.js`
- Modify: `test/trail.test.js:7` (add one `require` to the preamble Task 1 wrote)
- Test: `test/trail.test.js` (appended below Task 1's schema tests, which end at line 145)

**Implements:** spec section 5 (the `consentTypes` catalog guard, `assertOpaqueRef` on `caseRef` and `actor.ref`, `principalId` absent rather than null), section 6 (collapsing - one row carrying `count` and a type list), section 8.2 (the failure policy, both halves), and the `coverageFrom` module constant argued in sections 6 and 8.1.

**Interfaces:**
- Consumes: `models.TrailEntry` from Task 1's `buildModels(connection)` registry; `assertOpaqueRef(value, field)` from `src/utils/validate.js` (throws `AppError(msg, 400)`, returns `value`); `getValidConsentTypes()` from `src/config/catalog.js` (returns `string[]`, read live - never snapshotted); `AppError(message, status)` from `src/utils/errors.js`.
- Produces:
  ```js
  const COVERAGE_FROM = "2026-09-04";
  const UNATTRIBUTED = { role: "unattributed", channel: "library" };
  async function recordTrail(models, entry)        // -> Promise<void>, NEVER throws
  async function recordTrailStrict(models, entry)  // -> Promise<void>, throws AppError(..., 503)
  // module.exports = { COVERAGE_FROM, UNATTRIBUTED, recordTrail, recordTrailStrict }
  ```
  `entry` shape (all optional except `kind` and `outcome`; `actor` is required by the schema Task 1 wrote, and is optional *here* only because this module defaults it to `UNATTRIBUTED` - a caller writing to `models.TrailEntry` by any other route has no such default and must supply one): `{ principalId, kind, outcome, reasonCode, actor, refId, receiptId, consentTypes, fromStatus, toStatus, count, caseRef }`. Task 5 appends `getConsentTrail` and `findConsentTrailByContact` to this same file and this same `module.exports`, keeping both constants above.

- [ ] **Step 1: Wire the new service into the test file's preamble**

`test/trail.test.js` already exists from Task 1. Its line 7 is `const { buildModels } = require("../src/models");`. Add one line directly beneath it, keeping it below the `process.env.PRINCIPAL_ID_SECRET` assignment on line 6 by convention rather than by need: `consentTrail` pulls in `src/config/catalog`, which at module load captures `FIDUCIARY_NAME`, `FIDUCIARY_DPO_NAME`, `FIDUCIARY_DPO_EMAIL`, `GRIEVANCE_SLA_DAYS` and `RIGHTS_SLA_DAYS` into its `FIDUCIARY` object (`src/config/catalog.js:1-13`). Nothing in this file reads any of those. `PRINCIPAL_ID_SECRET` is checked by `assertConfigured()` (`src/config/catalog.js:53`), which only the router factories call (`src/http/router.js:106`, inside `createRouter`), so no require in this test file can trip on it. The house rule is simply that every `require("../src/...")` sits below the env block:

```js
const { buildModels } = require("../src/models");
const { recordTrail, recordTrailStrict, COVERAGE_FROM } = require("../src/services/consentTrail");
```

- [ ] **Step 2: Write the failing tests for `recordTrail`**

Append to the end of `test/trail.test.js` (below Task 1's last test, which closes at line 145):

```js

// ---------------------------------------------------------------------------
// The trail writer (spec sections 5, 6 and 8.2)
// ---------------------------------------------------------------------------

test("recordTrail writes one row and defaults the actor to unattributed", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await recordTrail(models, {
      principalId: PID,
      kind: "consent_not_applied",
      outcome: "no_change",
      reasonCode: "regrant_not_requested",
      receiptId: "RC-ABC123",
      count: 1,
    });

    const rows = await models.TrailEntry.find({ principalId: PID }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "consent_not_applied");
    assert.equal(rows[0].outcome, "no_change");
    assert.equal(rows[0].reasonCode, "regrant_not_requested");
    assert.equal(rows[0].receiptId, "RC-ABC123");
    assert.equal(rows[0].count, 1);
    assert.ok(rows[0].at instanceof Date);
    assert.deepEqual(
      rows[0].actor,
      { role: "unattributed", channel: "library" },
      "a caller that names no actor gets `unattributed` - the library does not know who acted, and `system` would be a claim it cannot back"
    );
  });
});

test("COVERAGE_FROM is a plain date string, so an empty trail can say when recording began", () => {
  assert.match(COVERAGE_FROM, /^\d{4}-\d{2}-\d{2}$/);
});

test("recordTrail keeps a catalog-valid consent type and drops everything else", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await recordTrail(models, {
      principalId: PID,
      kind: "withdrawal_not_applied",
      outcome: "refused",
      reasonCode: "unknown_consent_type",
      // withdrawConsent.js:45-48 pushes caller-supplied text verbatim and
      // assertStringArray applies no content check, so an email typed into
      // consentTypes reaches this writer.
      consentTypes: ["marketing", "asha@example.com"],
      count: 2,
    });

    const rows = await models.TrailEntry.find({}).lean();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].consentTypes, ["marketing"], "a catalog-valid purpose survives");
    assert.doesNotMatch(
      JSON.stringify(rows),
      /asha@example\.com/,
      "the trail survives erasure, so caller-supplied text must never reach any field of it"
    );
    assert.equal(rows[0].count, 2, "count still reports what the call actually covered");
  });
});

test("recordTrail omits consentTypes entirely when nothing survives the catalog filter", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await recordTrail(models, {
      principalId: PID,
      kind: "withdrawal_not_applied",
      outcome: "refused",
      reasonCode: "unknown_consent_type",
      consentTypes: ["asha@example.com"],
      count: 1,
    });

    const raw = await models.TrailEntry.findOne({ principalId: PID }).lean();
    assert.equal(
      Object.hasOwn(raw, "consentTypes"),
      false,
      "an empty array would read as `the call named no purposes`, which is false - it named one this writer refused to store"
    );
    assert.equal(raw.count, 1, "the row is still written: something was refused and that fact survives nowhere else");
  });
});

test("recordTrail refuses a caseRef and an actor.ref that are not opaque references", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const savedError = console.error;
    console.error = () => {};
    try {
      await recordTrail(models, {
        kind: "operator_lookup",
        outcome: "recorded",
        reasonCode: "no_match",
        actor: { role: "operator", ref: "emp-10432", channel: "api" },
        caseRef: "asha@example.com",
      });
      await recordTrail(models, {
        kind: "operator_lookup",
        outcome: "recorded",
        reasonCode: "no_match",
        actor: { role: "operator", ref: "asha nair", channel: "api" },
        caseRef: "INC-0042199",
      });
    } finally {
      console.error = savedError;
    }

    assert.equal(
      await models.TrailEntry.countDocuments({}),
      0,
      "a row is dropped rather than written with contact details or free text in it"
    );
  });
});

test("a failed trail write never reaches the caller, and the log names err.name and err.code but never err.message", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const savedCreate = models.TrailEntry.create;
    const savedError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    // The patch lives on a model bound to this test's throwaway connection,
    // so it cannot leak into another test.
    const boom = Object.assign(new Error('E11000 duplicate key error: { caseRef: "INC-0042199" }'), {
      name: "MongoServerError",
      code: 11000,
    });
    models.TrailEntry.create = () => Promise.reject(boom);
    try {
      await recordTrail(models, {
        principalId: PID,
        kind: "age_gate_refused",
        outcome: "refused",
        reasonCode: "parental_consent_required",
      });
    } finally {
      models.TrailEntry.create = savedCreate;
      console.error = savedError;
    }

    assert.equal(logged.length, 1, "a lost row must still be visible to whoever runs the deployment");
    const line = JSON.stringify(logged[0]);
    assert.match(line, /MongoServerError/, "err.name says what class of failure it was");
    assert.match(line, /11000/, "err.code says which one");
    assert.doesNotMatch(
      line,
      /INC-0042199/,
      "err.message quotes the offending value back, which is how a caller-supplied value reaches a log - the same discipline as the router's error mapper"
    );
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trail.test.js`
Expected: FAIL. The whole file fails to load, before any test runs:

```
Error: Cannot find module '../src/services/consentTrail'
Require stack:
- <repo>/data-fiduciary-toolkit/test/trail.test.js
...
✖ test/trail.test.js
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

- [ ] **Step 4: Create `src/services/consentTrail.js` with the fail-open writer**

Create the file exactly as below. `recordTrailStrict` is added in Step 6 - leave it out for now so its test can be watched failing.

```js
const { getValidConsentTypes } = require("../config/catalog");
const { assertOpaqueRef } = require("../utils/validate");

// The date this feature shipped. The trail is not retroactive and no backfill
// is possible or permitted, so a read returns this verbatim: a trail with
// nothing in it says "we were not recording before this date" rather than
// implying nothing happened. A module constant, not a stored marker row -
// a marker row cannot be written against a schema whose `actor` and `outcome`
// are both required, and under the fail-open rule below that failure would
// have been silent.
const COVERAGE_FROM = "2026-09-04";

// The honest default. `unattributed` is NOT a synonym for `system`: it means
// the library genuinely does not know who acted, and claiming otherwise would
// be a claim it cannot back. Task 1's `role` enum still admits "system" for a
// host that has a real automated actor to name, but this module deliberately
// exports no constant for it: nothing in the library acts as `system`, and a
// ready-made SYSTEM sitting beside UNATTRIBUTED invites precisely the swap
// this comment exists to prevent.
const UNATTRIBUTED = { role: "unattributed", channel: "library" };

/**
 * Logs a lost trail write with err.name and err.code and NOTHING else.
 *
 * err.message quotes the offending value back - mongoose's cast and duplicate
 * key messages both do - so logging it is how a caller-supplied email reaches
 * a log file. The router's error mapper already holds this line for the same
 * reason (router.js, the CastError branch), and test/auth.test.js pins it.
 */
function logTrailFailure(err) {
  console.error("[dpdp] trail write failed", { name: err && err.name, code: err && err.code });
}

/**
 * Builds the document from a caller-supplied entry.
 *
 * Throws AppError(..., 400) for a caseRef or actor.ref that is not an opaque
 * reference. recordTrail swallows that; recordTrailStrict lets it out, because
 * a malformed reference is the caller's mistake and not an outage.
 */
function buildDoc(entry) {
  const source = entry.actor || UNATTRIBUTED;
  const actor = { role: source.role, channel: source.channel };
  if (source.ref !== undefined) actor.ref = assertOpaqueRef(source.ref, "actor.ref");

  // Every element is checked against the live catalog and dropped when it does
  // not match. withdrawConsent pushes caller-supplied text verbatim and
  // assertStringArray applies no content check, so without this an email typed
  // into consentTypes would reach a collection that survives erasure.
  const types = Array.isArray(entry.consentTypes)
    ? entry.consentTypes.filter((t) => getValidConsentTypes().includes(t))
    : [];

  const doc = {
    // undefined values are not stored, so a row with no subject - an age-gate
    // refusal thrown before any principal exists, or a lookup that matched
    // nobody - has the field ABSENT rather than null.
    principalId: entry.principalId,
    kind: entry.kind,
    outcome: entry.outcome,
    reasonCode: entry.reasonCode,
    actor,
    refId: entry.refId,
    receiptId: entry.receiptId,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    count: entry.count,
  };
  // Omitted rather than stored as []: an empty array would read as "the call
  // named no purposes", which is false - it named some this writer refused.
  if (types.length) doc.consentTypes = types;
  if (entry.caseRef !== undefined) doc.caseRef = assertOpaqueRef(entry.caseRef, "caseRef");
  return doc;
}

/**
 * Records one trail entry. FAIL-OPEN: this never throws.
 *
 * The trail must never take down consent capture, a withdrawal, or the refusal
 * message a data principal needs to read - turning a 422 into a 500 would
 * leave a minor with no explanation. The precedent is onGrievanceFiled, whose
 * throws deliberately do not fail the request. The cost is stated rather than
 * hidden: the trail is evidence of what was recorded, not proof that nothing
 * else happened.
 */
async function recordTrail(models, entry) {
  try {
    await models.TrailEntry.create(buildDoc(entry));
  } catch (err) {
    logTrailFailure(err);
  }
}

module.exports = { COVERAGE_FROM, UNATTRIBUTED, recordTrail };
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trail.test.js`
Expected: PASS - `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0` (Task 1's six schema tests plus the six added in Step 2).

- [ ] **Step 6: Write the failing tests for `recordTrailStrict`**

Append to the end of `test/trail.test.js`:

```js

test("recordTrailStrict turns the same failure into a 503, so a disclosure without a record cannot happen", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const savedCreate = models.TrailEntry.create;
    const savedError = console.error;
    console.error = () => {};
    models.TrailEntry.create = () => Promise.reject(Object.assign(new Error("no primary"), { name: "MongoServerError", code: 189 }));
    try {
      await assert.rejects(
        () =>
          recordTrailStrict(models, {
            principalId: PID,
            kind: "operator_trail_read",
            outcome: "recorded",
            actor: { role: "operator", ref: "emp-10432", channel: "api" },
            caseRef: "INC-0042199",
          }),
        (err) => err.status === 503,
        "no record, no disclosure - an unaudited people-search is worse than no people-search"
      );
    } finally {
      models.TrailEntry.create = savedCreate;
      console.error = savedError;
    }
  });
});

test("recordTrailStrict rejects a bad caseRef as a 400, not a 503 - that is the caller's mistake, not an outage", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () =>
        recordTrailStrict(models, {
          kind: "operator_lookup",
          outcome: "recorded",
          reasonCode: "no_match",
          actor: { role: "operator", ref: "emp-10432", channel: "api" },
          caseRef: "ticket for asha@example.com",
        }),
      (err) => err.status === 400,
      "a 503 would tell an operator the database is down when their own payload is the problem"
    );
    assert.equal(await models.TrailEntry.countDocuments({}), 0);
  });
});

test("recordTrailStrict writes the access record, and a lookup that matched nobody stores no subject", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await recordTrailStrict(models, {
      kind: "operator_lookup",
      outcome: "recorded",
      reasonCode: "no_match",
      actor: { role: "operator", ref: "emp-10432", channel: "api" },
      caseRef: "INC-0042199",
    });

    const raw = await models.TrailEntry.findOne({ kind: "operator_lookup" }).lean();
    assert.deepEqual(raw.actor, { role: "operator", ref: "emp-10432", channel: "api" });
    assert.equal(raw.caseRef, "INC-0042199");
    assert.equal(
      Object.hasOwn(raw, "principalId"),
      false,
      "a miss must not manufacture a subject - there is no principal to file it under"
    );
  });
});
```

- [ ] **Step 7: Run the tests and watch the three new ones fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trail.test.js`
Expected: FAIL - `ℹ pass 12`, `ℹ fail 3`, each of the three reporting:

```
✖ recordTrailStrict turns the same failure into a 503, so a disclosure without a record cannot happen
  TypeError: recordTrailStrict is not a function
```

- [ ] **Step 8: Add `recordTrailStrict` and the `AppError` import**

Add `AppError` to the requires at the top of `src/services/consentTrail.js`, so the first three lines read:

```js
const { getValidConsentTypes } = require("../config/catalog");
const { assertOpaqueRef } = require("../utils/validate");
const { AppError } = require("../utils/errors");
```

Then replace the final `module.exports` line with:

```js
/**
 * Records one trail entry. FAIL-CLOSED: throws AppError(..., 503) if the write
 * fails. Back-office disclosure paths only.
 *
 * No record, no disclosure. An unaudited people-search over a fiduciary's data
 * principals is worse than no people-search at all, so if the access record
 * cannot be written the disclosure does not happen: 503, and no data. The
 * precedent is the other half of the same pair as recordTrail's: onWithdrawal
 * throws DO fail the request.
 *
 * A malformed caseRef or actor.ref still surfaces as the 400 assertOpaqueRef
 * throws - that is the caller's payload, not an outage, and answering 503
 * would send an operator to look for a database that is fine.
 */
async function recordTrailStrict(models, entry) {
  const doc = buildDoc(entry);
  try {
    await models.TrailEntry.create(doc);
  } catch (err) {
    logTrailFailure(err);
    throw new AppError("The access record could not be written, so this request was not completed", 503);
  }
}

module.exports = { COVERAGE_FROM, UNATTRIBUTED, recordTrail, recordTrailStrict };
```

Note that `buildDoc(entry)` is called *outside* the try, deliberately: a validation `AppError(..., 400)` must reach the caller as a 400, and only a write failure becomes the 503.

- [ ] **Step 9: Run the tests and watch them pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trail.test.js`
Expected: PASS - `ℹ tests 15`, `ℹ pass 15`, `ℹ fail 0`.

- [ ] **Step 10: Run the whole suite**

Run: `npm test`
Expected: `ℹ pass 177`, `ℹ fail 0` - 168 after Task 1, plus the nine this task adds. No existing test needs updating: this task adds a new file that nothing else requires yet - no service calls `recordTrail` until Task 3 - so the `trailentries` collection is still written only by `test/trail.test.js` itself. In particular the `countDocuments` guards in `test/children.test.js:83` and `:113` count `ConsentRecord`, not this collection, and are untouched.

- [ ] **Step 11: Commit**

```bash
git add src/services/consentTrail.js test/trail.test.js
git commit -m "feat(trail): add the fail-open and fail-closed trail writers"
```

---

### Task 3: Instrument the consent write path

**Files:**
- Modify: `src/services/persistPIIwithconsent.js:1-5` (add the `recordTrail` require), `:47-70` (JSDoc + the optional `actor` parameter), `:129-131` (the age-gate 422), `:179-207` (`decideFor` gains a third array), `:234`, `:259` (destructure it), `:271` (three writes before the return)
- Modify: `src/http/router.js:1-25` (add the `recordTrail` require), `:68` (insert the `principalActor` helper), `:322-324` (POST `/consent` passes `actor`), `:354-356` (the erased-record 409), `:360-371` (PUT `/consent` passes `actor`)
- Test: `test/trailconsent.test.js` (create)

**Implements:** Spec section 6 - the five kinds the consent write path is the only writer of: `age_gate_refused`/`parental_consent_required`, `consent_refused`/`prohibited_for_child`, `consent_not_applied`/`regrant_not_requested`, `consent_refused`/`record_erased`, `withdrawal_hook_not_fired`. Spec section 8.2's fail-open rule, proved end to end. Spec section 12, residual 7 (`PUT /consent` withdraws by omission and no hook fires).

**Interfaces:**
- Consumes, from `src/services/consentTrail.js` (Task 2): `async function recordTrail(models, entry)` -> `Promise<void>`, fail-open, never throws; and the constant `const UNATTRIBUTED = { role: "unattributed", channel: "library" };`. Both must be on that module's `module.exports` - Step 1 verifies it before anything else.
- Consumes, from `src/models/index.js` (Task 1): `models.TrailEntry`.
- Produces: `persistPIIwithconsent({ models, pii, consentTypes, regrant, notice, parentalConsent, principalId, actor })` - `actor` is new, optional, and defaults to `UNATTRIBUTED`. **No existing parameter changes, and the returned object `{ docRef, receiptId, principalId, created, events, state, refusedForChild }` gains no key.** Later tasks rely on that returned shape being untouched.
- Produces, in `src/http/router.js`, two module-scope names every later router task reuses **by name**:
  ```js
  const { recordTrail } = require("../services/consentTrail");
  const principalActor = (req) => ({ role: "principal", channel: wantsHtml(req) ? "html" : "api" });
  ```
  `principalActor` is the single spelling of the principal actor shape in this file. The task that instruments `assertOwnContact`'s 403 (`contact_mismatch_refused`, the `assertOwnContact(principal, readPii(req.body));` call in `PUT /consent`) and the task that extracts `src/http/shared.js` both call `principalActor(req)` and both reuse this require - neither re-inlines the `{ role: "principal", channel: wantsHtml(req) ? "html" : "api" }` literal, and neither adds a second require of the same module. Two spellings of one actor shape in one file is exactly the drift this helper exists to prevent.

**Scope boundary, stated so two tasks do not write the same row twice.** This task instruments the erased-record 409 **only** at `router.js:354-356`, on `PUT /consent`. The matching guard inside `updatePrincipalContact` (`src/utils/principalId.js:203-205`) is a contact-correction refusal, not a consent refusal, and belongs to the contact-correction task. Do not touch `principalId.js` here.

---

- [ ] **Step 1: Confirm the two symbols Task 2 exports**

`recordTrail` fails open by contract, so if `UNATTRIBUTED` were missing the default actor would be `undefined`, every trail write would fail schema validation (`actor` is `required: true`), and the failure would be swallowed silently. Check it loudly instead of discovering an empty collection later.

Run:

```bash
node -e "const t=require('./src/services/consentTrail');const missing=['recordTrail','UNATTRIBUTED'].filter(k=>t[k]===undefined);if(missing.length)throw new Error('src/services/consentTrail.js does not export: '+missing.join(', '));console.log('ok:',Object.keys(t).join(', '))"
```

Expected: `ok: COVERAGE_FROM, UNATTRIBUTED, recordTrail, recordTrailStrict` (order may differ) - that is Task 2's entire export surface, and nothing more should be there yet, because Task 5 is what later appends `getConsentTrail` and `findConsentTrailByContact` to this same module. If it throws, stop and add the missing export to `src/services/consentTrail.js` - it is Task 2's file and the frozen contract names both symbols.

---

- [ ] **Step 2: Write the failing tests for the four service-level kinds**

Create `test/trailconsent.test.js`. The `express` / `createRouter` / `erasePrincipalPII` requires are used by the test added in Step 9; they are in the preamble now so that step is a pure append.

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
const { erasePrincipalPII } = require("../src/services/erasure");
const { buildNotice } = require("../src/config/notice");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };

// A dob 14 years back, computed rather than hardcoded, so this file does not
// quietly stop testing a minor as the calendar moves.
function minorDob() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 14);
  return d.toISOString().slice(0, 10);
}

// Server-side only, and never wired to a route - see the isVerifiedParentalConsent
// docstring. It exists here so the age gate lets a child through and the NEXT
// refusal, the prohibited-purpose one, is the thing under test.
const PARENT = {
  name: "Guardian",
  email: "guardian@example.com",
  relationship: "mother",
  verifiedAt: new Date("2026-01-01"),
};

// ---------------------------------------------------------------------------
// age_gate_refused - thrown before any write, so nothing else records it
// ---------------------------------------------------------------------------

test("a minor refused at the age gate on SIGNUP is recorded with no principalId - the gate throws before findOrCreatePrincipal, so inventing a subject would be manufacturing evidence", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () =>
        persistPIIwithconsent({
          models,
          pii: { name: "Child", email: "child@example.com", phone: "1", dob: minorDob() },
          consentTypes: ["marketing"],
        }),
      (e) => e.status === 422
    );

    const rows = await models.TrailEntry.find({ kind: "age_gate_refused" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].reasonCode, "parental_consent_required");
    assert.equal(rows[0].principalId, undefined,
      "absent, not null - there is no principal, and a subject-shaped hole is worse than no field");
    assert.equal(rows[0].actor.role, "unattributed",
      "a direct service call is genuinely unattributed - `system` would be a claim the library cannot back");
    assert.equal(rows[0].actor.channel, "library");
    assert.ok(rows[0].at instanceof Date);

    assert.equal(await models.Principal.countDocuments(), 0,
      "the trail write must not have created the Principal the gate exists to prevent");
    assert.equal(await models.ConsentRecord.countDocuments(), 0);
  });
});

test("a minor refused at the age gate on the AUTHENTICATED branch IS filed under their principalId - the principal was loaded before the gate ran", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const adult = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    // A dob correction that reveals the account holder is in fact a child.
    // On this branch the principal is resolved BEFORE the gate, because the
    // stored record is where a registered minor's parental consent lives.
    await assert.rejects(
      () =>
        persistPIIwithconsent({
          models,
          principalId: adult.principalId,
          pii: { ...PII, dob: minorDob() },
          consentTypes: ["marketing"],
        }),
      (e) => e.status === 422
    );

    const rows = await models.TrailEntry.find({ kind: "age_gate_refused" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].principalId, adult.principalId);
    assert.equal(rows[0].reasonCode, "parental_consent_required");
  });
});

// ---------------------------------------------------------------------------
// consent_refused / prohibited_for_child - returned to the caller, persisted
// nowhere
// ---------------------------------------------------------------------------

test("every purpose prohibited for a child collapses into ONE refusal row carrying the count and the list - a submission naming 200 types must not write 200 rows", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const r = await persistPIIwithconsent({
      models,
      pii: { name: "Child", email: "child2@example.com", phone: "2", dob: minorDob() },
      consentTypes: ["marketing", "analytics", "underwriting"],
      parentalConsent: PARENT,
    });
    assert.deepEqual([...r.refusedForChild].sort(), ["analytics", "marketing"],
      "setup check - both prohibited purposes must actually have been refused");

    const rows = await models.TrailEntry.find({ kind: "consent_refused" });
    assert.equal(rows.length, 1, "one call refusing two purposes writes one row, not two");
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].reasonCode, "prohibited_for_child");
    assert.equal(rows[0].count, 2);
    assert.deepEqual([...rows[0].consentTypes].sort(), ["analytics", "marketing"]);
    assert.equal(rows[0].principalId, r.principalId);
    assert.equal(rows[0].receiptId, r.receiptId,
      "the refusal is part of a submission, and the receiptId is what ties it to one");
  });
});

// ---------------------------------------------------------------------------
// consent_not_applied / regrant_not_requested - the 200 with a receipt that
// names no event
// ---------------------------------------------------------------------------

test("a re-grant submitted without regrant:true is recorded as a no_change - the caller gets a 200 and a receipt naming no event, and nothing else says they asked", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const a = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await withdrawConsent({ models, principalId: a.principalId, consentTypes: ["marketing"] });

    const again = await persistPIIwithconsent({
      models,
      principalId: a.principalId,
      pii: PII,
      consentTypes: ["marketing"],
    });
    assert.equal(again.events.length, 0,
      "setup check - the silent no-op is the thing under test, so there must be no event");

    const rows = await models.TrailEntry.find({ kind: "consent_not_applied" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "no_change");
    assert.equal(rows[0].reasonCode, "regrant_not_requested");
    assert.equal(rows[0].count, 1);
    assert.deepEqual([...rows[0].consentTypes], ["marketing"]);
    assert.equal(rows[0].principalId, a.principalId);
    assert.equal(rows[0].receiptId, again.receiptId);

    // The inverse, so the row cannot be produced by any re-grant at all.
    const granted = await persistPIIwithconsent({
      models,
      principalId: a.principalId,
      pii: PII,
      consentTypes: ["marketing"],
      regrant: true,
    });
    assert.equal(granted.events.length, 1);
    assert.equal(granted.events[0].status, "granted");
    assert.equal((await models.TrailEntry.find({ kind: "consent_not_applied" })).length, 1,
      "an honoured re-grant is a real ledger event, so it is derived at read time and writes no row");
  });
});

// ---------------------------------------------------------------------------
// withdrawal_hook_not_fired - the withdrawal is in the ledger and is derived;
// that the host was never told is not
// ---------------------------------------------------------------------------

test("a purpose withdrawn by omission records that no cease-processing hook fired - the withdrawal itself is derived from the ledger, but a possibly undischarged Section 6(6) duty is not", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const a = await persistPIIwithconsent({
      models,
      pii: PII,
      consentTypes: ["marketing", "underwriting"],
    });
    const b = await persistPIIwithconsent({
      models,
      principalId: a.principalId,
      pii: PII,
      consentTypes: ["underwriting"],
    });
    assert.deepEqual(b.events.map((e) => `${e.type}:${e.status}`), ["marketing:withdrawn"],
      "setup check - omitting marketing must actually have withdrawn it");

    const rows = await models.TrailEntry.find({ kind: "withdrawal_hook_not_fired" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "recorded",
      "nothing was refused here - the withdrawal took effect, the notification did not happen");
    assert.equal(rows[0].reasonCode, undefined, "this kind has no reason code");
    assert.deepEqual([...rows[0].consentTypes], ["marketing"]);
    assert.equal(rows[0].count, 1);
    assert.equal(rows[0].principalId, a.principalId);
    assert.equal(rows[0].receiptId, b.receiptId);
  });
});

// ---------------------------------------------------------------------------
// The regression guard. This is the test that protects the 23 tests in
// consent.test.js, the JSON.stringify byte-compares in auth.test.js, and the
// per-event noticeVersion assertions in notice.test.js.
// ---------------------------------------------------------------------------

test("instrumenting the write path changes neither the ledger nor the returned object - a plain adult grant is identical to what it was before", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const notice = buildNotice({ language: "en" });
    const r = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"], notice });

    // The returned key set, exactly. `suppressed` is computed inside decideFor
    // and must never leak out of it: this is an exported function and a new
    // key on it is a silent API change.
    assert.deepEqual(Object.keys(r).sort(),
      ["created", "docRef", "events", "principalId", "receiptId", "refusedForChild", "state"]);
    assert.equal(r.created, true);
    assert.deepEqual(r.refusedForChild, []);
    assert.equal(r.events.length, 5);

    const record = await models.ConsentRecord.findOne({ principalId: r.principalId });

    // Per-event key set - an added ledger field fails here.
    for (const e of record.events) {
      assert.deepEqual(Object.keys(e.toObject()).sort(),
        ["basis", "lawfulBasisKind", "noticeVersion", "receiptId", "status", "timestamp", "type"]);
      assert.equal(e.receiptId, r.receiptId);
      assert.ok(e.timestamp instanceof Date);
    }

    // Per-event values, byte-compared. Rebuilt by explicit destructuring so
    // the key order is this test's, not mongoose's, and the two random fields
    // above are already asserted separately.
    const shape = ({ type, status, basis, lawfulBasisKind, noticeVersion }) =>
      ({ type, status, basis, lawfulBasisKind, noticeVersion });
    const B = "Your consent";
    const PMLA =
      "Obligation under law to disclose information to the State - reporting under the Prevention of Money-Laundering Act, 2002";
    assert.equal(
      JSON.stringify(record.events.map((e) => shape(e.toObject()))),
      JSON.stringify([
        { type: "kyc_reporting", status: "granted", basis: PMLA, lawfulBasisKind: "legitimate_use", noticeVersion: notice.version },
        { type: "identity_verification", status: "denied", basis: B, lawfulBasisKind: "consent", noticeVersion: notice.version },
        { type: "underwriting", status: "denied", basis: B, lawfulBasisKind: "consent", noticeVersion: notice.version },
        { type: "marketing", status: "granted", basis: B, lawfulBasisKind: "consent", noticeVersion: notice.version },
        { type: "analytics", status: "denied", basis: B, lawfulBasisKind: "consent", noticeVersion: notice.version },
      ])
    );

    assert.equal(await models.TrailEntry.countDocuments(), 0,
      "an adult granting consent destroys nothing, so under the partition rule it writes no trail row at all");
  });
});
```

---

- [ ] **Step 3: Run the tests and watch them fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trailconsent.test.js`

Expected: the first five tests FAIL, each on a count of zero rows:

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

0 !== 1
```

The sixth test - `instrumenting the write path changes neither the ledger nor the returned object` - is expected to **PASS** on this run. It is the control: a regression guard that failed before the change would be pinning the wrong behaviour.

---

- [ ] **Step 4: Add the trail require and the optional `actor` parameter**

In `src/services/persistPIIwithconsent.js`, add a sixth require after line 5:

```js
const { recordTrail, UNATTRIBUTED } = require("./consentTrail");
```

Then extend the JSDoc and the signature. Insert this `@param` block immediately before the existing `@returns` line (`:68`):

```js
 * @param {object}   [input.actor] - who is acting, for the AUDIT TRAIL ONLY. Defaults
 *   to UNATTRIBUTED, which is not a synonym for "system": a direct service call
 *   genuinely does not tell this library who is behind it, and claiming otherwise
 *   would be a claim it cannot back. Nothing about the consent decision, the
 *   ledger, or the returned object depends on this value.
```

and replace line 70 with:

```js
async function persistPIIwithconsent({ models, pii, consentTypes, regrant = false, notice, parentalConsent, principalId, actor = UNATTRIBUTED } = {}) {
```

---

- [ ] **Step 5: Record the age-gate refusal before the 422 is thrown**

Replace `src/services/persistPIIwithconsent.js:129-131` with:

```js
  if (isMinor && !isVerifiedParentalConsent(effectiveParentalConsent)) {
    // Written BEFORE the throw, because the throw IS the record: this 422
    // leaves no Principal and no ConsentRecord behind by design, so without
    // this row nothing anywhere says a child was turned away.
    //
    // principalId is present only on the AUTHENTICATED branch, where the
    // principal was loaded above. On the SIGNUP branch the gate deliberately
    // runs before findOrCreatePrincipal, so there is no subject at all and the
    // row is written with principalId absent - `principal` is the only honest
    // source for it, since the parameter can be any falsy value the caller
    // passed and "" would store a subject-shaped hole.
    await recordTrail(models, {
      principalId: principal ? principal.principalId : undefined,
      kind: "age_gate_refused",
      outcome: "refused",
      reasonCode: "parental_consent_required",
      actor,
    });
    throw new AppError("Verifiable parental consent is required before processing a child's personal data", 422);
  }
```

---

- [ ] **Step 6: Have `decideFor` report the silent no-op, leaving `decide` untouched**

`decide` is a pure function that 23 tests in `test/consent.test.js` pin, and its return type is "the target status, or null". It does not change. `decideFor` is local to this call and already loops over the same catalog, so it is where the third list belongs.

Replace `src/services/persistPIIwithconsent.js:179-207` with:

```js
  const decideFor = (state) => {
    const events = [];
    const refused = [];
    const suppressed = [];
    for (const entry of getCatalog()) {
      // Parental consent unlocks nothing here: behavioural advertising and
      // tracking aimed at a child are refused outright, not merely
      // un-consented, and no event is written for them at all.
      if (isMinor && entry.prohibitedForChildren) {
        refused.push(entry.type);
        continue;
      }
      const current = state[entry.type] ? state[entry.type].status : undefined;
      const target = decide({ entry, current, chosen, consentSubmitted, regrant });
      // The one silent no-op in the state table: a re-grant of a WITHDRAWN
      // purpose submitted without regrant: true. decide() returns null for it
      // (see the `current === "withdrawn"` line in decide below), the caller
      // gets a 200 and a receipt naming no event, and nothing else records
      // that they asked at all. The condition is restated here rather than
      // reported by decide(), because decide() is pure, its return type is a
      // status or null, and 23 tests pin it.
      //
      // `!target` confirms decide() really returned null rather than a status
      // that happens to equal `current`. The lawfulBasis check keeps this in
      // exact step with decide's own early return for legitimate_use.
      if (
        !target &&
        entry.lawfulBasis.kind === "consent" &&
        current === "withdrawn" &&
        chosen.includes(entry.type) &&
        !regrant
      ) {
        suppressed.push(entry.type);
      }
      if (!target || target === current) continue;
      events.push({
        type: entry.type,
        status: target,
        basis: entry.lawfulBasis.description,
        lawfulBasisKind: entry.lawfulBasis.kind,
        receiptId,
        timestamp: now,
        // The notice IN FORCE WHEN THIS EVENT WAS WRITTEN, not the record's
        // most recent one - so an old event stays evidenced even after a
        // later submission's notice overwrites lastNotice below.
        noticeVersion: notice ? notice.version : undefined,
      });
    }
    return { events, refused, suppressed };
  };
```

---

- [ ] **Step 7: Destructure `suppressed` at both `decideFor` call sites**

Two edits. `src/services/persistPIIwithconsent.js:234`:

```js
  let { events: newEvents, refused: refusedForChild, suppressed } = decideFor(record.currentState());
```

and `:259`, inside the duplicate-key recovery:

```js
    ({ events: newEvents, refused: refusedForChild, suppressed } = decideFor(record.currentState()));
```

Both call sites must be updated. The recovery recomputes against the winning document, so after it runs `suppressed` describes the state that actually won - which is exactly what Step 8 records.

---

- [ ] **Step 8: Write the three post-save rows, once, before the return**

Insert this immediately after the `try/catch` block closes at `:270` and before the `return {` at `:272`:

```js
  // Instrumentation. Everything above is unchanged and nothing above depends
  // on any of it.
  //
  // It runs AFTER the save for two reasons. A submission that failed to save
  // must leave no trail row claiming it happened; and the duplicate-key
  // recovery above recomputes all three lists against the WINNING document,
  // so by here they are already the truthful ones. Recording inside decideFor,
  // or before the try, would double-write every row on the recovery path.

  if (refusedForChild.length) {
    await recordTrail(models, {
      principalId,
      kind: "consent_refused",
      outcome: "refused",
      reasonCode: "prohibited_for_child",
      actor,
      // ONE row naming N purposes, never N rows. An authenticated principal
      // can otherwise force roughly 17,000 inserts from one 100kb request.
      consentTypes: refusedForChild,
      count: refusedForChild.length,
      receiptId,
    });
  }

  if (suppressed.length) {
    await recordTrail(models, {
      principalId,
      kind: "consent_not_applied",
      outcome: "no_change",
      reasonCode: "regrant_not_requested",
      actor,
      consentTypes: suppressed,
      count: suppressed.length,
      receiptId,
    });
  }

  // decide() returns "withdrawn" for exactly one reason: a purpose the caller
  // OMITTED from a submission that carried a consent decision. That withdrawal
  // is in the ledger, so it is derived at read time and is never copied here.
  // What is recorded nowhere at all is that the host was not told: this
  // function has no onWithdrawal parameter and the router passes none, so the
  // cease-processing pipeline never runs. It is the fact a fiduciary most
  // needs, because it names a Section 6(6) duty that may have gone
  // undischarged - and recording that the hook did not fire is not the same as
  // firing it. See the README's residuals.
  const withdrawnByOmission = newEvents.filter((e) => e.status === "withdrawn").map((e) => e.type);
  if (withdrawnByOmission.length) {
    await recordTrail(models, {
      principalId,
      kind: "withdrawal_hook_not_fired",
      outcome: "recorded",
      actor,
      consentTypes: withdrawnByOmission,
      count: withdrawnByOmission.length,
      receiptId,
    });
  }

```

---

- [ ] **Step 9: Run the tests and watch them pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trailconsent.test.js`

Expected: PASS - all six tests.

---

- [ ] **Step 10: Commit the service half**

```bash
git add src/services/persistPIIwithconsent.js test/trailconsent.test.js
git commit -m "feat(consent): record the four facts the consent write path destroys"
```

---

- [ ] **Step 11: Write the failing test for the erased-record refusal**

Append to `test/trailconsent.test.js`:

```js
// ---------------------------------------------------------------------------
// consent_refused / record_erased - PUT /consent, thrown before any write
// ---------------------------------------------------------------------------

test("a consent update refused because the record is erased leaves a refusal row - erasure is terminal, so this is the last thing that will ever happen on the record and nothing else writes it down", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await erasePrincipalPII({ models, principalId });

    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ consentTypes: ["analytics"] }),
      });
      assert.equal(res.status, 409, "setup check - the erased guard must actually have refused");
    } finally {
      await new Promise((r) => server.close(r));
    }

    const rows = await models.TrailEntry.find({ kind: "consent_refused", reasonCode: "record_erased" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].principalId, principalId);
    assert.equal(rows[0].actor.role, "principal");
    assert.equal(rows[0].actor.channel, "api",
      "identity comes from the session, and the channel is what an API client asked for");
  });
});

test("the channel a refusal arrived on is recorded, so a browser form and an API client are told apart", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const app = express();
    // Signup is deliberately unauthenticated, so no resolvePrincipal is needed
    // to reach POST /consent.
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
        body: new URLSearchParams({
          name: "Child",
          email: "form-child@example.com",
          dob: minorDob(),
          consentSubmitted: "1",
        }),
      });
      assert.equal(res.status, 422, "setup check - the age gate must actually have refused");
    } finally {
      await new Promise((r) => server.close(r));
    }

    const rows = await models.TrailEntry.find({ kind: "age_gate_refused" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor.role, "principal");
    assert.equal(rows[0].actor.channel, "html");
    assert.equal(rows[0].principalId, undefined,
      "signup still has no subject, however the refusal arrived");
  });
});
```

---

- [ ] **Step 12: Run the tests and watch the two new ones fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trailconsent.test.js`

Expected: the six earlier tests PASS; the two new ones FAIL.

The erased-record test fails at the row count:

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

0 !== 1
```

The channel test fails at the actor, because the service is still defaulting to `UNATTRIBUTED`:

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

'unattributed' !== 'principal'
```

---

- [ ] **Step 13: Add the trail require and the actor helper to the router**

In `src/http/router.js`, add a require after line 13 (`const consentManagerRequest = ...` / `const { listConsentManagerRequests } = consentManagerRequest;`), keeping it with the other service requires:

```js
const { recordTrail } = require("../services/consentTrail");
```

Then insert this helper at module scope, immediately after `isTrue` closes at line 67 and before the `wrap` comment at line 69:

```js
/**
 * Who a principal-facing trail row is attributed to. Identity itself still
 * comes only from resolvePrincipal - this says nothing about WHO, only that
 * the actor is the data principal and which surface they reached us on. The
 * channel matters because an HTML refusal and an API refusal are different
 * failures to answer for: one was read by a person on a page.
 */
const principalActor = (req) => ({ role: "principal", channel: wantsHtml(req) ? "html" : "api" });
```

---

- [ ] **Step 14: Record the erased-record refusal and attribute both consent writes**

Three edits in `src/http/router.js`.

Replace the POST `/consent` service call at `:322-324`:

```js
      const result = await persistPIIwithconsent({
        models, pii, consentTypes: readConsentTypes(req.body), notice, actor: principalActor(req),
      });
```

Replace the erased guard at `:354-356`:

```js
      if (principal.erasedAt) {
        // Recorded before the throw. Erasure is terminal, so this refusal is
        // the last thing that will ever happen on this record, and it is
        // thrown before any write - nothing else keeps it.
        await recordTrail(models, {
          principalId: req.principalId,
          kind: "consent_refused",
          outcome: "refused",
          reasonCode: "record_erased",
          actor: principalActor(req),
        });
        throw new AppError("This data principal's record has been erased and cannot be updated", 409);
      }
```

And add one line to the PUT `/consent` service call, after `notice,` at `:370`:

```js
        notice,
        actor: principalActor(req),
      });
```

---

- [ ] **Step 15: Run the tests and watch them pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trailconsent.test.js`

Expected: PASS - all eight tests.

---

- [ ] **Step 16: Prove the fail-open rule end to end**

The trail must never take down consent capture or the refusal message a principal needs to read. Turning this 422 into a 500 would leave a child with no explanation, which is the exact class of defect the audit remediation already fixed. Append to `test/trailconsent.test.js`:

```js
// ---------------------------------------------------------------------------
// The failure policy (section 8.2): instrumentation writes fail OPEN
// ---------------------------------------------------------------------------

test("a trail write that fails does not fail the act it is instrumenting - the minor still gets the 422 that explains why", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    // Any property lookup on TrailEntry throws, so recordTrail fails however
    // it chose to write - create, save, insertMany. That is deliberate: this
    // asserts the CONTRACT ("never throws") rather than one implementation of
    // it, which also means recordTrail's whole body has to sit inside its
    // try/catch, not just the await.
    const broken = {
      ...models,
      TrailEntry: new Proxy({}, { get() { throw new Error("trail collection is down"); } }),
    };

    await assert.rejects(
      () =>
        persistPIIwithconsent({
          models: broken,
          pii: { name: "Child", email: "failopen@example.com", phone: "9", dob: minorDob() },
          consentTypes: ["marketing"],
        }),
      (e) => e.status === 422 && /parental consent/i.test(e.message)
    );

    assert.equal(await models.TrailEntry.countDocuments(), 0,
      "the write really did fail - otherwise this test passes vacuously");
  });
});

test("a trail write that fails does not fail a SUCCESSFUL consent submission either - the receipt is still returned in full", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const a = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "underwriting"] });

    const broken = {
      ...models,
      TrailEntry: new Proxy({}, { get() { throw new Error("trail collection is down"); } }),
    };
    // Omitting marketing withdraws it, which is the path that writes a
    // withdrawal_hook_not_fired row after the save.
    const b = await persistPIIwithconsent({
      models: broken,
      principalId: a.principalId,
      pii: PII,
      consentTypes: ["underwriting"],
    });

    assert.deepEqual(b.events.map((e) => `${e.type}:${e.status}`), ["marketing:withdrawn"],
      "the ledger append must have happened and been reported, trail or no trail");
    assert.ok(b.receiptId);
    const record = await models.ConsentRecord.findOne({ principalId: a.principalId });
    assert.equal(record.events.filter((e) => e.status === "withdrawn").length, 1);
    assert.equal(await models.TrailEntry.countDocuments(), 0);
  });
});
```

Run: `node --test --test-global-setup=scripts/test-setup.js test/trailconsent.test.js`

Expected: PASS - all ten tests. `recordTrail` logs `err.name` and `err.code` to stderr on each swallowed failure, so two log lines during this file are expected output, not a failure. If either test FAILS with a rejection that is not the 422, the defect is in Task 2's `recordTrail` - its entire body must be inside the try/catch, including the `models.TrailEntry` lookup.

---

- [ ] **Step 17: Pin the two exclusions that are security decisions, not omissions**

Spec section 7 cuts two sites from the trail, and both cuts are load-bearing. Nothing else in the plan holds them, so a later contributor "completing the coverage" would reintroduce two attack primitives and every existing test would still pass. Spec section 10 case 5 asks for exactly these two assertions.

Both tests spin a server the way `test/http.test.js` does - `express()`, `app.use(basePath, createRouter({ db: conn, resolvePrincipal }))`, `app.listen(0)`, read the port off `server.address()`, and close it in a `finally` - which is also the pattern Step 11 already uses in this file.

Append to `test/trailconsent.test.js`:

```js
// ---------------------------------------------------------------------------
// The exclusions (section 7). These are not gaps - each one is a write an
// attacker would otherwise control, and a test is the only thing that keeps
// them cut.
// ---------------------------------------------------------------------------

test("GET /consent/new grows the trail by exactly zero - it is the one deliberately unauthenticated, checkOrigin-exempt page, so a row here would make a cross-site <img> a database write", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const app = express();
    // No session: this page is reachable with no principal at all, which is
    // the whole reason instrumenting it is unsafe.
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      for (let i = 0; i < 20; i += 1) {
        const res = await fetch(`http://localhost:${port}/dpdp/consent/new`, {
          headers: { Accept: "text/html" },
        });
        assert.equal(res.status, 200,
          "setup check - the page must actually render, or this test passes by never reaching the route");
        const html = await res.text();
        assert.match(html, /<form/, "setup check - the notice and consent form is what was served");
      }
    } finally {
      await new Promise((r) => server.close(r));
    }

    assert.equal(await models.TrailEntry.countDocuments({}), 0,
      "twenty renders, zero rows - checkOrigin exempts GET, so any row written here is one an attacker appends from an <img> tag on a site they control, at whatever rate they like");
  });
});

test("twenty duplicate-signup 409s grow the victim's trail by exactly zero - recording the signup 409 would hand an unauthenticated stranger who knows an email an unthrottled append primitive against that person's own evidence", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);

    // The victim, with one genuine row already on their trail, so "unchanged"
    // below is a real comparison and not 0 === 0. Omitting marketing from the
    // second submission withdraws it, which writes withdrawal_hook_not_fired.
    const victim = await persistPIIwithconsent({
      models,
      pii: PII,
      consentTypes: ["marketing", "underwriting"],
    });
    await persistPIIwithconsent({
      models,
      principalId: victim.principalId,
      pii: PII,
      consentTypes: ["underwriting"],
    });
    const before = await models.TrailEntry.countDocuments({ principalId: victim.principalId });
    assert.equal(before, 1, "setup check - the victim must have something buriable on their trail");

    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      for (let i = 0; i < 20; i += 1) {
        // Only the email is needed to reach the existence check - the attacker
        // is a stranger who knows an address, and nothing more.
        const res = await fetch(`http://localhost:${port}/dpdp/consent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ name: "Not Asha", email: PII.email, phone: "1", dob: "1990-04-01", consentTypes: ["marketing"] }),
        });
        assert.equal(res.status, 409,
          "setup check - the existence check must refuse before any write, or this test is measuring the wrong route");
      }
    } finally {
      await new Promise((r) => server.close(r));
    }

    assert.equal(await models.TrailEntry.countDocuments({ principalId: victim.principalId }), before,
      "reads are newest-first and bounded, so twenty appends a stranger controls are an evidence-burial primitive, not an audit trail");
    assert.equal(await models.TrailEntry.countDocuments({}), before,
      "and not filed against some other subject either - the refusal is recorded nowhere at all");

    const stored = await models.Principal.findOne({ principalId: victim.principalId });
    assert.equal(stored.pii.name, PII.name,
      "the existence check also still runs before any write, so twenty attempts overwrote nothing - this is the C1 attack the route's own comment describes");
  });
});
```

Run: `node --test --test-global-setup=scripts/test-setup.js test/trailconsent.test.js`

Expected: PASS - all twelve tests. If either of these two ever fails, the failure is not a broken test: something has started instrumenting a site spec section 7 deliberately cut, and the fix is to remove that instrumentation, not to update the assertion.

---

- [ ] **Step 18: Run the whole suite**

Run: `npm test`

Expected: `ℹ pass 189`, `ℹ fail 0` - the 177 tests standing after Task 2 all still pass, unchanged, plus the 12 this task adds. Nothing in `test/consent.test.js`, `test/auth.test.js`, `test/notice.test.js`, `test/http.test.js`, `test/erasure.test.js` or `test/injection.test.js` needs updating: every write this task adds goes to `trailentries`, and the ledger, `currentState()`, `getConsentState`'s projection and the returned object are all untouched. `test/children.test.js:82` and `:112` assert `Principal.countDocuments() === 0`, and `:83` and `:113` assert `ConsentRecord.countDocuments() === 0`, after a rejected minor - and all four still hold - the age-gate row is in a third collection those assertions do not look at.

If `test/consent.test.js` moves, the regression test in Step 2 has already told you which of the ledger or the return value changed - fix that, do not update those tests.

---

- [ ] **Step 19: Commit**

```bash
git add src/http/router.js test/trailconsent.test.js
git commit -m "feat(http): record the erased-record consent refusal and attribute consent writes to their channel"
```

---

### Task 4: Instrument withdrawal, lifecycle, escalation and contact correction

**Files:**
- Modify: `src/services/withdrawConsent.js:1-96` (whole file - requires, JSDoc, the loop, and a new block after the save)
- Modify: `src/services/requestLifecycle.js:1-59` (whole file - requires, `advance()`, all three wrappers)
- Modify: `src/services/complaintToTheBoard.js:1-4` (requires) and `:62-117` (`escalateToBoard` and its JSDoc)
- Modify: `src/utils/principalId.js:177-250` (`updatePrincipalContact` and its JSDoc)
- Test: `test/consent.test.js:467` (append 5 tests at end of file)
- Test: `test/lifecycle.test.js:140` (append 6 tests at end of file)
- Test: `test/principal.test.js:268` (append 3 tests at end of file)

No new test file. The reason is that this task's four instrumentation sites already have a home: withdrawal is `test/consent.test.js`, the lifecycle and escalation sites are `test/lifecycle.test.js`, and contact correction is `test/principal.test.js`. Appending there keeps each new test beside the behaviour it constrains and beside the existing tests it must not break.

For the record, the plan as a whole does deviate from the spec's test plan, which says "two new files ... plus additions to existing files": it creates four - `test/trail.test.js` (the trail service and its schema), `test/trailconsent.test.js` (the consent write path), `test/trailread.test.js` (the read) and `test/backoffice.test.js` (the back-office router). Those are four separate surfaces, not one, and folding them into two files would put unrelated fixtures in a shared preamble. That deviation is owned by the tasks that create those files; this task adds nothing to it.

**Implements:** Spec section 2 rows 1-3 (withdrawal refused / unknown / not granted), row 7 (update rejected on an erased record), row 8 (a rights request advancing `received -> in_progress -> closed`), row 9 (a grievance advancing, or an escalation refused), row 10 (a contact-detail correction). Spec section 4's "stored in the trail" table, rows 2, 3, 4, 5. Spec section 6 kinds `withdrawal_not_applied`, `request_status_changed`, `escalation_refused`, `contact_corrected`, and `consent_refused` with reason code `record_erased`. Spec section 8.2's fail-open instrumentation rule at four call sites. Spec section 6's collapsing rule and spec section 10 case 6, on the withdrawal path: one call naming 200 purposes writes one row, and the consent write path refuses such a submission before any row exists.

**Interfaces:**

- Consumes, from `src/services/consentTrail.js` (created by the trail-service task):
  - `async function recordTrail(models, entry) // -> Promise<void>` - fail-open, never throws, logs `err.name` and `err.code` only, and drops any element of `entry.consentTypes` that is not in `getValidConsentTypes()`.
  - `const UNATTRIBUTED = { role: "unattributed", channel: "library" };`
  - Both are named exports of that module. `require("./consentTrail")` from inside `src/services/`, `require("../services/consentTrail")` from `src/utils/`.
- Consumes, from `src/models/index.js` (model task): `models.TrailEntry`, a mongoose model on the caller's connection. `buildModels(conn)` returns it. This task never requires a model file directly.
- Consumes, already in the repo: `getValidConsentTypes()`, `getWithdrawableTypes()`, `getCatalogEntry(type)` from `src/config/catalog.js`; `AppError(msg, status)` from `src/utils/errors.js`; `assertPrincipalId`, `assertNonEmptyString`, `assertStringArray` from `src/utils/validate.js`; `lookupHash(value)` from `src/utils/principalId.js`.
- Produces - six exported functions each gain ONE optional property on their existing options object. No signature is broken and every existing caller keeps working:
  - `withdrawConsent({ models, principalId, consentTypes, onWithdrawal, actor })`
  - `advanceRightsRequest({ models, refId, status, resolution, actor })`
  - `advanceGrievance({ models, refId, status, resolution, actor })`
  - `advanceConsentManagerRequest({ models, refId, status, actor })`
  - `escalateToBoard({ models, refId, principalId, actor })`
  - `updatePrincipalContact({ models, principalId, pii, actor })`
- Produces - the `contact_corrected` marker vocabulary. That kind carries the changed contact fields in `toStatus`, as one of exactly three literals: `"email"`, `"phone"`, `"email+phone"`. It never carries the old or new value, nor a hash of either. The trail read passes `toStatus` through unchanged, so any renderer of the timeline gets these three strings and no others for this kind.

**Prerequisite:** the validate/model task and the `consentTrail.js` service task are both merged before this one starts. If `models.TrailEntry` is missing, the tests below fail with `TypeError: Cannot read properties of undefined (reading 'find')` rather than an assertion - that is the signal the model task is not in place.

---

- [ ] **Step 1: Write the failing tests for the three withdrawal branches**

Append verbatim to the end of `test/consent.test.js` (after line 467). The file's preamble already requires `buildModels`, `persistPIIwithconsent` and `withdrawConsent`, and already defines `PII` - do not add requires.

```js
// ---------------------------------------------------------------------------
// The withdrawal audit trail.
//
// withdrawConsent skips save() entirely when nothing changed, so a refused or
// no-op withdrawal leaves NO trace anywhere: not on the ledger, not on
// updatedAt, and not in the response once the person has closed the page.
// These rows are the only record that they asked.
// ---------------------------------------------------------------------------

test("a withdrawal naming unknown purposes writes ONE collapsed row, and never the caller's text", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    // "asha@example.com" as a purpose is not a contrivance: assertStringArray
    // applies no content check, so caller-supplied text reaches this branch
    // verbatim and must not survive into a collection that outlives erasure.
    await withdrawConsent({ models, principalId, consentTypes: ["asha@example.com", "not_a_purpose"] });

    const rows = await models.TrailEntry.find({ principalId, kind: "withdrawal_not_applied" }).lean();
    assert.equal(rows.length, 1, "two unknown purposes in one call collapse to one row, not two");
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].reasonCode, "unknown_consent_type");
    assert.equal(rows[0].count, 2, "count carries how many purposes were refused for this reason");
    assert.deepEqual(rows[0].consentTypes ?? [], [],
      "an unknown purpose is caller text, so the writer drops every element - the count survives, the strings do not");
    assert.equal(rows[0].actor.role, "unattributed",
      "a direct library call has no identity, and claiming 'system' would be a claim the library cannot back");
    assert.equal(rows[0].actor.channel, "library");
    assert.doesNotMatch(JSON.stringify(rows[0]), /asha@example\.com/i,
      "an email typed into consentTypes must appear nowhere in the trail");
  });
});

test("a withdrawal refused as non-withdrawable is recorded, even though the ledger save is skipped", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["kyc_reporting"] });
    const before = (await models.ConsentRecord.findOne({ principalId })).events.length;

    const r = await withdrawConsent({
      models,
      principalId,
      consentTypes: ["kyc_reporting"],
      actor: { role: "principal", channel: "api" },
    });
    assert.equal(r.withdrawn.length, 0,
      "setup check - this purpose must actually be refused, or the branch under test is never reached");

    const after = (await models.ConsentRecord.findOne({ principalId })).events.length;
    assert.equal(after, before, "the ledger is untouched, which is exactly why the trail row has to exist");

    const rows = await models.TrailEntry.find({ principalId, kind: "withdrawal_not_applied" }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].reasonCode, "not_withdrawable");
    assert.deepEqual(rows[0].consentTypes, ["kyc_reporting"],
      "a catalog purpose is not caller text, so the writer keeps it");
    assert.equal(rows[0].receiptId, r.receiptId, "the row cites the receipt the person was handed");
    assert.equal(rows[0].actor.role, "principal",
      "a supplied actor is carried through verbatim - the router is what knows who is acting");
    assert.equal(rows[0].actor.channel, "api");
    assert.equal(rows[0].actor.ref, undefined, "ref is set only for an operator");
  });
});

test("a withdrawal of something not currently granted is recorded as no_change, not as a refusal", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    const first = await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });
    assert.deepEqual(first.withdrawn, ["marketing"], "setup check - the first withdrawal must actually take effect");
    assert.equal(await models.TrailEntry.countDocuments({ principalId }), 0,
      "a withdrawal that took effect is in the ledger with a real timestamp, so the trail stores nothing for it");

    await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });

    const rows = await models.TrailEntry.find({ principalId, kind: "withdrawal_not_applied" }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "no_change",
      "the caller got a 2xx and nothing happened - that is not the same as being refused");
    assert.equal(rows[0].reasonCode, "not_granted");
    assert.deepEqual(rows[0].consentTypes, ["marketing"]);
    assert.equal(rows[0].count, 1);
  });
});
```

- [ ] **Step 2: Write the tests that pin the collapse bound**

Spec section 10 case 6 and spec section 6's collapsing rule: a call naming 200 purposes must not write 200 rows. Step 1's three tests pin the *shape* of a collapsed row at two purposes; these two pin the *bound*, which is the part that stops an authenticated principal turning one 100kb request into roughly 17,000 inserts. The second test records that the consent write path never even reaches the bound, so nobody later "fixes" it by adding a collapse there.

Append verbatim to `test/consent.test.js`, directly after the three tests added in Step 1. The preamble already requires everything used here.

```js
test("200 unknown purposes in one withdrawal write ONE row - the bound, not 200 inserts", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    // 200 DISTINCT strings, so withdrawConsent's own Set dedup does no work
    // here and the collapse under test is the only thing holding the count
    // down. None of them is in the catalog, so all 200 land on one reason.
    const many = Array.from({ length: 200 }, (_, i) => `not_a_purpose_${i}`);
    await withdrawConsent({ models, principalId, consentTypes: many });

    const rows = await models.TrailEntry.find({ principalId }).lean();
    assert.equal(rows.length, 1,
      "one row per (kind, reasonCode) per call, whatever the size of the payload");
    assert.equal(rows[0].kind, "withdrawal_not_applied");
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].reasonCode, "unknown_consent_type");
    assert.equal(rows[0].count, 200,
      "count is the only thing that scales with the payload, and it is a number not a list");
    assert.equal(Object.hasOwn(rows[0], "consentTypes"), false,
      "all 200 are non-catalog caller text, so the writer drops every one and the field is never set");
  });
});

test("a 200-type consent submission is refused before any row exists - the bound is unreachable there", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const many = Array.from({ length: 200 }, (_, i) => `not_a_purpose_${i}`);

    // persistPIIwithconsent.js:83-84 rejects the WHOLE submission the moment
    // any type is not in the catalog, and that check sits above the age gate
    // and above findOrCreatePrincipal.
    await assert.rejects(
      () => persistPIIwithconsent({ models, pii: PII, consentTypes: many }),
      (e) => e.status === 400 && /Unknown consent type/.test(e.message)
    );

    assert.equal(await models.TrailEntry.countDocuments({}), 0,
      "the throw is before any write, so this path cannot produce even one row - let alone 200");
    assert.equal(await models.Principal.countDocuments({}), 0,
      "and nothing else is written either, which is the existing guarantee this must not disturb");
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/consent.test.js`

Expected: FAIL. Of the five new tests, four fail and the 23 existing ones pass. The first failure is `AssertionError [ERR_ASSERTION]: two unknown purposes in one call collapse to one row, not two` with `actual: 0, expected: 1` - nothing writes to `trailentries` yet. The fifth new test, the 200-type consent submission, passes vacuously: the 400 at `persistPIIwithconsent.js:83-84` already ships, and `trailentries` is empty because nothing writes to it yet. It is the guard that keeps the bound honest once the other four are green.

- [ ] **Step 4: Instrument `withdrawConsent`**

Replace the whole of `src/services/withdrawConsent.js` with this. Three things change: the new require, `actor` on the options object, three per-reason collectors filled beside the existing `rejected`/`noChange` pushes, and one collapsed write block after the save.

```js
const { getCatalogEntry, getValidConsentTypes, getWithdrawableTypes, contactBlock } = require("../config/catalog");
const { assertPrincipalId, assertStringArray } = require("../utils/validate");
const { generateDocRef } = require("../utils/principalId");
const { AppError } = require("../utils/errors");
const { recordTrail, UNATTRIBUTED } = require("./consentTrail");

/**
 * Withdraws consent for one or more purposes. Append-only: never edits or
 * deletes history.
 *
 * Withdrawal triggers a duty to cease processing and erase - which this
 * library cannot perform on the integrator's behalf, since it does not know
 * where else the data went. So it reports what changed through onWithdrawal
 * and leaves the pipeline to the host. Logging the withdrawal without giving
 * the host a way to act on it would be worse than not logging it.
 *
 * @param {object}   input
 * @param {object}   input.models
 * @param {string}   input.principalId
 * @param {string[]} input.consentTypes   - purposes to withdraw
 * @param {Function} [input.onWithdrawal] - called once, only if something changed
 * @param {object}   [input.actor]        - who is acting, for the audit trail.
 *                                          Defaults to UNATTRIBUTED: a direct
 *                                          library call genuinely has no
 *                                          identity, and claiming "system"
 *                                          would be a claim this library
 *                                          cannot back.
 * @returns {Promise<{ docRef, receiptId, withdrawn, rejected, noChange, effectiveFrom, contact: { dpoName, dpoEmail } }>}
 *          effectiveFrom is null when withdrawn is empty.
 */
async function withdrawConsent({ models, principalId, consentTypes, onWithdrawal, actor = UNATTRIBUTED } = {}) {
  assertPrincipalId(principalId);
  // Deduplicated: a purpose named twice in one request is one decision, and
  // without this the second pass would read the same pre-loop state and append
  // a second identical event that the append-only ledger could never shed.
  const types = [...new Set(assertStringArray(consentTypes, "consentTypes"))];
  if (!types.length) throw new AppError("consentTypes must include at least one purpose to withdraw", 400);

  const record = await models.ConsentRecord.findOne({ principalId });
  if (!record) throw new AppError("No consent record found for this principal", 404);

  const now = new Date();
  const receiptId = generateDocRef("RC");
  const state = record.currentState();
  const withdrawn = [];
  const rejected = [];
  const noChange = [];
  // Collected per REASON, not per purpose. One call naming 200 purposes must
  // write one row per reason and not 200 rows - an authenticated principal
  // could otherwise force thousands of inserts from one request.
  const unknownTypes = [];
  const notWithdrawableTypes = [];
  const notGrantedTypes = [];

  for (const type of types) {
    // Unknown first: an unknown type has no catalog entry, so every branch
    // below that reads one must be unreachable for it.
    if (!getValidConsentTypes().includes(type)) {
      rejected.push({ type, reason: "Unknown consent type" });
      unknownTypes.push(type);
      continue;
    }
    const entry = getCatalogEntry(type);
    if (!getWithdrawableTypes().includes(type)) {
      rejected.push({
        type,
        reason: `This purpose rests on ${entry.lawfulBasis.clause} (${entry.lawfulBasis.description}), not on your consent, so it cannot be withdrawn`,
      });
      notWithdrawableTypes.push(type);
      continue;
    }
    const current = state[type] ? state[type].status : undefined;
    if (current !== "granted") {
      // Already withdrawn, declined, or never granted - nothing to revoke.
      noChange.push(type);
      notGrantedTypes.push(type);
      continue;
    }
    record.events.push({
      type,
      status: "withdrawn",
      basis: entry.lawfulBasis.description,
      lawfulBasisKind: entry.lawfulBasis.kind,
      receiptId,
      timestamp: now,
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

  // The trail write happens whether or not the save above ran - that is the
  // whole point. A refused or no-op withdrawal skips save() entirely, so these
  // rows are the only record anywhere that the person asked and was told no.
  //
  // AFTER the save, never before: a row must not claim a decision the ledger
  // write then failed to make. What did succeed is in the ledger with a real
  // timestamp and is derived at read time, so it is not repeated here.
  //
  // recordTrail is fail-open and never throws, so an unavailable trail cannot
  // turn a withdrawal into a 500.
  for (const group of [
    { types: unknownTypes, outcome: "refused", reasonCode: "unknown_consent_type" },
    { types: notWithdrawableTypes, outcome: "refused", reasonCode: "not_withdrawable" },
    { types: notGrantedTypes, outcome: "no_change", reasonCode: "not_granted" },
  ]) {
    if (!group.types.length) continue;
    await recordTrail(models, {
      principalId,
      kind: "withdrawal_not_applied",
      outcome: group.outcome,
      reasonCode: group.reasonCode,
      actor,
      receiptId,
      // recordTrail drops every element that is not in the live catalog, so
      // the unknown-type row keeps its count and loses its strings. An unknown
      // type is caller-supplied text that assertStringArray does not
      // content-check, so an email typed into consentTypes must never reach a
      // collection that survives erasure.
      consentTypes: group.types,
      count: group.types.length,
    });
  }

  return {
    docRef: record.docRef,
    receiptId,
    withdrawn,
    rejected,
    noChange,
    // null when nothing was withdrawn: reporting a moment for a revocation that
    // did not happen would have a host act on nothing.
    effectiveFrom: withdrawn.length ? now : null,
    contact: contactBlock(),
  };
}

module.exports = withdrawConsent;
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/consent.test.js`

Expected: PASS - 28 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/services/withdrawConsent.js test/consent.test.js
git commit -m "feat(withdraw): record refused and no-op withdrawals on the trail"
```

---

- [ ] **Step 7: Write the failing tests for status transitions**

Append verbatim to the end of `test/lifecycle.test.js` (after line 140). The preamble already requires `buildModels`, `advanceRightsRequest`, `advanceGrievance`, `advanceConsentManagerRequest` and defines `PID` - do not add requires.

```js
// ---------------------------------------------------------------------------
// The transition audit trail.
//
// row.status = status overwrites the prior value in place and updatedAt holds
// only the last change, so without these rows a request that moved
// received -> in_progress -> closed is indistinguishable afterwards from one
// that went straight to closed.
// ---------------------------------------------------------------------------

test("a two-step advance records BOTH hops with the from-status each one destroyed", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await models.RightsRequest.create({
      principalId: PID, refId: "RQ-TRAIL", right: "erasure", status: "received", slaDueAt: new Date(),
    });

    await advanceRightsRequest({ models, refId: "RQ-TRAIL", status: "in_progress" });
    await advanceRightsRequest({ models, refId: "RQ-TRAIL", status: "closed", resolution: "PII erased" });

    const row = await models.RightsRequest.findOne({ refId: "RQ-TRAIL" });
    assert.equal(row.status, "closed");
    assert.equal(row.toObject().fromStatus, undefined,
      "premise of this test - nothing on the request itself remembers where it came from");

    const rows = await models.TrailEntry.find({ principalId: PID, kind: "request_status_changed" }).lean();
    assert.equal(rows.length, 2, "one row per hop - the middle transition is what updatedAt cannot reconstruct");

    // Matched by destination rather than by order, so the assertion does not
    // depend on two writes landing in different milliseconds.
    const toInProgress = rows.find((r) => r.toStatus === "in_progress");
    const toClosed = rows.find((r) => r.toStatus === "closed");
    assert.ok(toInProgress && toClosed, "both hops must be present");
    assert.equal(toInProgress.fromStatus, "received");
    assert.equal(toClosed.fromStatus, "in_progress",
      "captured before row.status = status overwrote it - that overwrite is the entire reason this kind exists");

    for (const r of [toInProgress, toClosed]) {
      assert.equal(r.outcome, "recorded");
      assert.equal(r.principalId, PID, "the row files under the subject, taken from the request itself");
      assert.equal(r.refId, "RQ-TRAIL", "the row cites the reference the person holds");
      assert.equal(r.reasonCode, undefined, "a transition that happened has no reason code");
      assert.equal(r.actor.role, "unattributed");
      assert.equal(r.actor.channel, "library");
    }
  });
});

test("every advance* wrapper threads models through - grievance and consent-manager hops are recorded too", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({
      principalId: PID, refId: "GR-TRAIL", subject: "s", description: "d", addressedTo: "DPO", status: "open", slaDueAt: past,
    });
    await models.ConsentManagerRequest.create({
      principalId: PID, refId: "CM-TRAIL", message: "connect me", status: "received",
    });

    await advanceGrievance({ models, refId: "GR-TRAIL", status: "in_progress" });
    await advanceConsentManagerRequest({ models, refId: "CM-TRAIL", status: "connected" });

    const rows = await models.TrailEntry.find({ principalId: PID, kind: "request_status_changed" }).lean();
    assert.equal(rows.length, 2, "a wrapper that forgot to pass models would silently record nothing");
    const byRef = Object.fromEntries(rows.map((r) => [r.refId, r]));
    assert.equal(byRef["GR-TRAIL"].fromStatus, "open");
    assert.equal(byRef["GR-TRAIL"].toStatus, "in_progress");
    assert.equal(byRef["CM-TRAIL"].fromStatus, "received");
    assert.equal(byRef["CM-TRAIL"].toStatus, "connected");
  });
});

test("an illegal transition records nothing - a stored transition is only ever one that happened", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await models.RightsRequest.create({
      principalId: PID, refId: "RQ-NOPE", right: "access", status: "closed", slaDueAt: new Date(),
    });

    await assert.rejects(
      () => advanceRightsRequest({ models, refId: "RQ-NOPE", status: "in_progress" }),
      (e) => e.status === 409
    );

    assert.equal(await models.TrailEntry.countDocuments({ principalId: PID }), 0,
      "the transition did not happen, so nothing may record that it did");
  });
});
```

- [ ] **Step 8: Run the test and watch it fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/lifecycle.test.js`

Expected: FAIL. The 8 existing tests pass; the first two new ones fail with `AssertionError [ERR_ASSERTION]: one row per hop - the middle transition is what updatedAt cannot reconstruct` (`actual: 0, expected: 2`) and `AssertionError [ERR_ASSERTION]: a wrapper that forgot to pass models would silently record nothing` (`actual: 0, expected: 2`). The third new test passes vacuously - it is the guard that keeps the other two honest once they are green.

- [ ] **Step 9: Thread `models` through `advance()` and record the transition**

Replace the whole of `src/services/requestLifecycle.js` with this. `advance()` gains `models` and `actor`; all three wrappers already receive `models` and now pass it on.

```js
const { assertNonEmptyString } = require("../utils/validate");
const { AppError } = require("../utils/errors");
const { recordTrail, UNATTRIBUTED } = require("./consentTrail");

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

/**
 * `models` is the registry, threaded in from the wrappers purely so the
 * transition can be recorded - `model` (singular) stays what it always was,
 * the one collection being advanced. `kind` is the human label used in the
 * error messages ("rights request"); the trail's own kind is the literal
 * "request_status_changed" below, and the two are not related.
 */
async function advance({ models, model, map, kind, refId, status, resolution, extraFields = {}, actor = UNATTRIBUTED }) {
  assertNonEmptyString(refId, "refId", 64);
  assertNonEmptyString(status, "status", 32);
  const row = await model.findOne({ refId });
  if (!row) throw new AppError(`No ${kind} found with that reference`, 404);
  assertTransition(map, row.status, status, kind);

  // Captured BEFORE the assignment below. `row.status = status` overwrites the
  // prior value in place, and nothing else on the document remembers it -
  // updatedAt holds only the moment of the LAST change - so a request that
  // moved received -> in_progress -> closed becomes indistinguishable from one
  // that went straight to closed. That destruction is the whole reason this
  // transition is stored rather than derived at read time.
  const fromStatus = row.status;

  row.status = status;
  if (resolution !== undefined) row.resolution = resolution;
  Object.assign(row, extraFields);
  row.updatedAt = new Date();
  await row.save();

  // After the save, and only on a transition that actually happened: an
  // illegal one throws above and writes nothing, so no row can claim a change
  // the document did not make. recordTrail is fail-open and never throws, so
  // an unavailable trail cannot fail a transition that already persisted.
  await recordTrail(models, {
    principalId: row.principalId,
    kind: "request_status_changed",
    outcome: "recorded",
    actor,
    refId: row.refId,
    fromStatus,
    toStatus: status,
  });

  return row.toObject();
}

const advanceRightsRequest = ({ models, refId, status, resolution, actor }) =>
  advance({ models, model: models.RightsRequest, map: RIGHTS_TRANSITIONS, kind: "rights request", refId, status, resolution, actor });

const advanceGrievance = ({ models, refId, status, resolution, actor }) =>
  advance({ models, model: models.Grievance, map: GRIEVANCE_TRANSITIONS, kind: "grievance", refId, status, resolution, actor });

const advanceConsentManagerRequest = ({ models, refId, status, actor }) =>
  advance({ models, model: models.ConsentManagerRequest, map: CM_TRANSITIONS, kind: "consent manager request", refId, status, actor });

module.exports = { advanceRightsRequest, advanceGrievance, advanceConsentManagerRequest, RIGHTS_TRANSITIONS, GRIEVANCE_TRANSITIONS, CM_TRANSITIONS };
```

- [ ] **Step 10: Run the test and watch it pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/lifecycle.test.js`

Expected: PASS - 11 tests, 0 failures.

- [ ] **Step 11: Commit**

```bash
git add src/services/requestLifecycle.js test/lifecycle.test.js
git commit -m "feat(lifecycle): record the status transition that overwrites its own history"
```

---

- [ ] **Step 12: Write the failing tests for the three escalation refusals**

Append verbatim to the end of `test/lifecycle.test.js` (after the tests added in Step 7). `escalateToBoard` is already required by the file's preamble.

```js
// ---------------------------------------------------------------------------
// Refused escalations. Nothing is written when one is refused - the grievance
// is not saved and the 409 is the only output - so a fiduciary asked why a
// person never reached the Board would otherwise have nothing to answer with.
// ---------------------------------------------------------------------------

test("an escalation refused because the grievance is resolved is recorded", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({
      principalId: PID, refId: "GR-RES", subject: "s", description: "d", addressedTo: "DPO",
      status: "resolved", slaDueAt: past,
    });

    await assert.rejects(
      () => escalateToBoard({ models, refId: "GR-RES", principalId: PID }),
      (e) => e.status === 409
    );

    const rows = await models.TrailEntry.find({ principalId: PID, kind: "escalation_refused" }).lean();
    assert.equal(rows.length, 1, "a refused escalation writes nothing anywhere else, so this row is the only record");
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].reasonCode, "already_resolved");
    assert.equal(rows[0].refId, "GR-RES");
    assert.equal(rows[0].actor.role, "unattributed");
  });
});

test("a second escalation is refused as already_escalated, and the first one stores nothing", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({
      principalId: PID, refId: "GR-TWICE", subject: "s", description: "d", addressedTo: "DPO",
      status: "open", slaDueAt: past,
    });

    await escalateToBoard({ models, refId: "GR-TWICE", principalId: PID });
    assert.equal(await models.TrailEntry.countDocuments({ principalId: PID }), 0,
      "an escalation that took effect stamps escalatedAt, so it is derived at read time and stored nowhere");

    await assert.rejects(
      () => escalateToBoard({ models, refId: "GR-TWICE", principalId: PID }),
      (e) => e.status === 409
    );

    const rows = await models.TrailEntry.find({ principalId: PID, kind: "escalation_refused" }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reasonCode, "already_escalated");
    assert.equal(rows[0].outcome, "refused");
  });
});

test("an escalation refused because the SLA has not lapsed is recorded, with a supplied actor carried through", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const future = new Date(Date.now() + 86400000);
    await models.Grievance.create({
      principalId: PID, refId: "GR-EARLY", subject: "s", description: "d", addressedTo: "DPO",
      status: "open", slaDueAt: future,
    });

    await assert.rejects(
      () => escalateToBoard({
        models, refId: "GR-EARLY", principalId: PID,
        actor: { role: "principal", channel: "html" },
      }),
      (e) => e.status === 409
    );

    const rows = await models.TrailEntry.find({ principalId: PID, kind: "escalation_refused" }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reasonCode, "sla_not_lapsed");
    assert.equal(rows[0].actor.role, "principal");
    assert.equal(rows[0].actor.channel, "html");
    assert.doesNotMatch(JSON.stringify(rows[0]), /lapsed yet|not yet lapsed|Grievance Officer/i,
      "the row carries a reason code and a reference, never the sentence the person was shown");
  });
});
```

- [ ] **Step 13: Run the test and watch it fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/lifecycle.test.js`

Expected: FAIL. The 11 tests from Step 10 still pass; the three new ones fail, the first with `AssertionError [ERR_ASSERTION]: a refused escalation writes nothing anywhere else, so this row is the only record` (`actual: 0, expected: 1`).

- [ ] **Step 14: Instrument `escalateToBoard`**

Add the require to the top of `src/services/complaintToTheBoard.js`, immediately after the existing four requires (so line 5 becomes):

```js
const { recordTrail, UNATTRIBUTED } = require("./consentTrail");
```

Then replace the `escalateToBoard` JSDoc and function (`src/services/complaintToTheBoard.js:62-117`) with this. Every existing comment is kept verbatim - only the `actor` parameter and the three `recordTrail` calls are new.

```js
/**
 * Escalates an existing grievance to the Data Protection Board. Only
 * meaningful once the SLA has lapsed without resolution - enforced here
 * rather than left to the caller.
 *
 * principalId is required and is folded into the lookup itself, not checked
 * afterwards - see getGrievance below for why a 403 here would turn this
 * endpoint into an existence oracle for other principals' GR- references.
 * The router takes principalId from resolvePrincipal, never from the
 * request.
 *
 * @param {object} input
 * @param {object} input.models      - model registry, must include Grievance
 * @param {string} input.refId       - the GR- reference returned when it was filed
 * @param {string} input.principalId - the owner, from resolvePrincipal
 * @param {object} [input.actor]     - who is acting, for the audit trail.
 *                                     Defaults to UNATTRIBUTED - a direct
 *                                     library call has no identity to claim.
 * @returns {Promise<{ refId: string, status: string, escalatedAt: Date }>}
 */
async function escalateToBoard({ models, refId, principalId, actor = UNATTRIBUTED } = {}) {
  assertNonEmptyString(refId, "refId", 64);
  // principalId is now required. Without it this took any refId and never
  // consulted the grievance's owner, so anyone holding or guessing a GR-
  // reference could escalate someone else's complaint (M8).
  assertPrincipalId(principalId);

  // principalId is part of the filter itself, not checked after the fact -
  // a refId belonging to another principal simply does not match and comes
  // back as the same 404 as a refId that does not exist at all. A 403 here
  // would confirm the refId is real, letting anyone who has seen or guessed
  // a GR- reference distinguish "exists, not yours" from "does not exist" -
  // exactly the existence oracle getGrievance was written to avoid.
  const grievance = await models.Grievance.findOne({ refId, principalId });
  // No trail row on the 404: it is the same answer for a reference that does
  // not exist and for one that belongs to somebody else, and recording it
  // would let a stranger guessing GR- references append rows to a trail.
  if (!grievance) throw new AppError("No grievance found with that reference", 404);

  // Each refusal below is recorded BEFORE its throw. A refused escalation
  // saves nothing - the grievance is untouched and the error is the only
  // output - so without these rows there is no record anywhere that a data
  // principal tried to reach the Board and was stopped. recordTrail never
  // throws, so the refusal the person needs to read is unaffected either way.
  if (grievance.status === "resolved") {
    await recordTrail(models, {
      principalId,
      kind: "escalation_refused",
      outcome: "refused",
      reasonCode: "already_resolved",
      actor,
      refId: grievance.refId,
    });
    throw new AppError("This grievance is already marked resolved", 409);
  }
  // Null-safe: a document could reach "escalated" by a route this plan does
  // not control (a direct database edit, or a future caller), so escalatedAt
  // is not guaranteed to be set even though escalateToBoard itself always
  // sets it before status.
  if (grievance.status === "escalated") {
    await recordTrail(models, {
      principalId,
      kind: "escalation_refused",
      outcome: "refused",
      reasonCode: "already_escalated",
      actor,
      refId: grievance.refId,
    });
    const when = grievance.escalatedAt ? grievance.escalatedAt.toISOString() : "earlier";
    throw new AppError(`This grievance was already escalated on ${when}`, 409);
  }
  if (new Date() < grievance.slaDueAt) {
    await recordTrail(models, {
      principalId,
      kind: "escalation_refused",
      outcome: "refused",
      reasonCode: "sla_not_lapsed",
      actor,
      refId: grievance.refId,
    });
    throw new AppError(
      `The Grievance Officer's SLA hasn't lapsed yet (due ${grievance.slaDueAt.toISOString()})`,
      409
    );
  }

  // Nothing is recorded on the way through: an escalation that takes effect
  // stamps escalatedAt, which the trail read derives from the grievance
  // itself. Storing it as well would double-report it.
  grievance.status = "escalated";
  grievance.escalatedToBoard = true;
  grievance.escalatedAt = new Date();
  grievance.updatedAt = grievance.escalatedAt;
  await grievance.save();

  return { refId: grievance.refId, status: grievance.status, escalatedAt: grievance.escalatedAt };
}
```

- [ ] **Step 15: Run the test and watch it pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/lifecycle.test.js`

Expected: PASS - 14 tests, 0 failures.

- [ ] **Step 16: Commit**

```bash
git add src/services/complaintToTheBoard.js test/lifecycle.test.js
git commit -m "feat(grievance): record refused escalations"
```

---

- [ ] **Step 17: Write the failing tests for contact correction**

Append verbatim to the end of `test/principal.test.js` (after line 268). The preamble already requires `buildModels`, `lookupHash`, `findOrCreatePrincipal`, `updatePrincipalContact` and `erasePrincipalPII` - do not add requires.

```js
// ---------------------------------------------------------------------------
// The contact-correction audit trail.
//
// A correction overwrites the old emailHash in place and destroys it. The row
// records WHICH field moved and nothing else: the old value, the new value and
// the hash of either are all personal data on a record that outlives erasure.
// ---------------------------------------------------------------------------

test("a contact correction records which field changed, and neither the old nor the new value", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal } = await findOrCreatePrincipal({ models, pii: { name: "Asha", email: "asha@example.com" } });
    const id = principal.principalId;
    const oldHash = principal.emailHash;
    assert.ok(oldHash, "setup check - there must be an email hash on file for the correction to destroy");

    await updatePrincipalContact({ models, principalId: id, pii: { email: "asha.new@example.com" } });

    const rows = await models.TrailEntry.find({ principalId: id, kind: "contact_corrected" }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "recorded");
    assert.equal(rows[0].toStatus, "email", "the marker names the field that changed, from a fixed vocabulary");
    assert.equal(rows[0].count, 1);
    assert.equal(rows[0].actor.role, "unattributed");

    const stored = JSON.stringify(rows[0]);
    assert.doesNotMatch(stored, /asha/i, "neither the old nor the new address may appear - both are personal data");
    assert.doesNotMatch(stored, new RegExp(oldHash),
      "copying the overwritten hash here would rebuild the email-to-person index erasure exists to destroy");
    assert.doesNotMatch(stored, new RegExp(lookupHash("asha.new@example.com")),
      "the new hash is on the Principal document already - the trail stores only what is destroyed");
  });
});

test("a correction moving both contact details writes one row naming both, and a name-only edit writes none", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal } = await findOrCreatePrincipal({
      models, pii: { name: "Asha", email: "asha@example.com", phone: "9876543210" },
    });
    const id = principal.principalId;

    await updatePrincipalContact({
      models, principalId: id, pii: { email: "asha.new@example.com", phone: "9000000000" },
    });

    let rows = await models.TrailEntry.find({ principalId: id, kind: "contact_corrected" }).lean();
    assert.equal(rows.length, 1, "one row per call, never one per field");
    assert.equal(rows[0].toStatus, "email+phone", "the marker is built in a fixed order, so it is stable to compare");
    assert.equal(rows[0].count, 2);

    await updatePrincipalContact({ models, principalId: id, pii: { name: "Asha Rao" } });
    await updatePrincipalContact({ models, principalId: id, pii: { phone: "9000000000" } });

    rows = await models.TrailEntry.find({ principalId: id, kind: "contact_corrected" }).lean();
    assert.equal(rows.length, 1,
      "a name change destroys no lookup hash and resubmitting the same number changes nothing - neither is a correction");
  });
});

test("an update refused because the record is erased is recorded - the 409 is that branch's only other output", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal } = await findOrCreatePrincipal({ models, pii: { name: "Asha", email: "asha@example.com" } });
    const id = principal.principalId;
    await erasePrincipalPII({ models, principalId: id });

    await assert.rejects(
      () => updatePrincipalContact({ models, principalId: id, pii: { email: "asha.new@example.com" } }),
      (e) => e.status === 409,
      "setup check - erasure is terminal, and this must still be the refusal"
    );

    const rows = await models.TrailEntry.find({ principalId: id }).lean();
    assert.equal(rows.length, 1, "erasure itself writes nothing to the trail, so this is the only row");
    assert.equal(rows[0].kind, "consent_refused");
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].reasonCode, "record_erased");
    assert.equal(rows[0].toStatus, undefined, "nothing changed, so there is no changed-field marker");
    assert.doesNotMatch(JSON.stringify(rows[0]), /asha/i,
      "the refused address must not be written onto a record that has already been erased");
  });
});
```

- [ ] **Step 18: Run the test and watch it fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/principal.test.js`

Expected: FAIL. The 14 existing tests pass; the three new ones fail, the first with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 0 !== 1` on `assert.equal(rows.length, 1)`.

- [ ] **Step 19: Instrument `updatePrincipalContact`**

Replace `src/utils/principalId.js:177-250` (the JSDoc and the function) with this. Every existing comment is kept verbatim. Three things are new: the lazy require, the `changed` collector around the two hash writes, and the two `recordTrail` calls.

```js
/**
 * AUTHENTICATED contact correction. Identity comes from principalId - which the
 * router takes from resolvePrincipal, never from the payload - so correcting an
 * email cannot be used to reach another person's record.
 *
 * This is the path that satisfies the Section 12 right to correction without
 * orphaning the consent history, and it is deliberately separate from signup:
 * inferring "same person" from a shared phone number would merge two members of
 * a household who share a handset.
 *
 * @param {object} input
 * @param {object} input.models
 * @param {string} input.principalId
 * @param {object} input.pii
 * @param {object} [input.actor] - who is acting, for the audit trail. Defaults
 *                                 to UNATTRIBUTED, which is not a synonym for
 *                                 "system": it means the library genuinely does
 *                                 not know.
 */
async function updatePrincipalContact({ models, principalId, pii, actor }) {
  // Required lazily, INSIDE the function, on purpose: services/consentTrail.js
  // requires THIS module for findConsentTrailByContact, so a top-level require
  // here would be circular and would leave whichever of the two loaded second
  // destructuring a half-built exports object. config/catalog.js requires
  // config/notice.js the same way and for the same reason. It is also why the
  // default sits here rather than in the parameter list - UNATTRIBUTED is not
  // in scope until this line has run.
  const { recordTrail, UNATTRIBUTED } = require("../services/consentTrail");
  const who = actor || UNATTRIBUTED;

  assertPrincipalId(principalId);
  if (!pii || typeof pii !== "object") throw new AppError("pii is required", 400);

  // See the matching call in findOrCreatePrincipal: the unique index on
  // emailHash is only an effective backstop once mongoose has finished
  // building it, and init() is a memoized no-op after the first call.
  await models.Principal.init();

  const principal = await models.Principal.findOne({ principalId });
  if (!principal) throw new AppError("No principal found for that id", 404);

  // Erasure is terminal. Without this, an authenticated caller - or anyone
  // holding a session issued before the erasure - can write PII straight back
  // onto an erased record, leaving a document that claims erasedAt while
  // holding live PII. That is the worst possible artefact to hand a regulator.
  if (principal.erasedAt) {
    // Recorded, then refused. This branch saves nothing and the 409 is its
    // only other output, so without this row an attempt to write PII back onto
    // an erased record leaves no trace at all. Never the value that was
    // refused: it is exactly the personal data the erasure destroyed.
    await recordTrail(models, {
      principalId,
      kind: "consent_refused",
      outcome: "refused",
      reasonCode: "record_erased",
      actor: who,
    });
    throw new AppError("This data principal's record has been erased and cannot be updated", 409);
  }

  // Which CONTACT fields actually move. Field names only - never a value and
  // never a hash of one. The old emailHash is what this write destroys, so
  // copying it into a collection that survives erasure would rebuild the
  // email-to-person index erasure exists to destroy.
  const changed = [];

  // Email uniqueness only. phoneHash is deliberately non-unique because a
  // household shares a handset, so a phone clash is NOT an error - and checking
  // it would 409 a beneficiary merely for resubmitting their own unchanged
  // phone number, locking the stated audience out of the Section 12 correction
  // right entirely.
  if (pii.phone) {
    const phoneHash = lookupHash(pii.phone);
    // Resubmitting the same number overwrites the hash with itself and destroys
    // nothing, so it is not a correction and is not recorded as one.
    if (principal.phoneHash !== phoneHash) changed.push("phone");
    principal.phoneHash = phoneHash;
  }

  if (pii.email) {
    const hash = lookupHash(pii.email);
    // Resubmitting your own unchanged email is never a clash.
    if (principal.emailHash !== hash) {
      // NO query operator here, deliberately. connect() sets sanitizeFilter on
      // every connection this library opens, which rewrites { $ne: x } into
      // { $eq: { $ne: x } } - and casting that object onto a String path
      // throws CastError. So the previous { principalId: { $ne: principalId } }
      // filter made EVERY real email correction throw, which the router's
      // error mapper reported as "400 Invalid value for: principalId", naming
      // a field the caller never supplied, and the documented 409-on-clash
      // guarantee below never executed at all. emailHash is unique, so at most
      // one document can match; comparing the id in JavaScript needs no
      // operator and cannot be rewritten out from under us.
      const clash = await models.Principal.findOne({ emailHash: hash });
      if (clash && clash.principalId !== principalId) {
        throw new AppError("That email is already registered to another data principal", 409);
      }
      principal.emailHash = hash;
      changed.push("email");
    }
  }

  principal.pii = { ...(principal.pii ? principal.pii.toObject() : {}), ...pii };
  principal.updatedAt = new Date();
  try {
    await principal.save();
  } catch (err) {
    // Backstop for the same check-then-act race as findOrCreatePrincipal: two
    // concurrent corrections claiming the same new email can both pass the
    // findOne check above before either has written.
    if (err && err.code === 11000) {
      throw new AppError("That email is already registered to another data principal", 409);
    }
    throw err;
  }

  // After the save, and only when a contact hash actually moved. A name-only
  // correction is not recorded here: this kind exists because the OLD HASH is
  // overwritten and destroyed, and a name change destroys nothing the trail is
  // charged with keeping.
  if (changed.length) {
    await recordTrail(models, {
      principalId,
      kind: "contact_corrected",
      outcome: "recorded",
      actor: who,
      // The marker, built from a fixed vocabulary in a fixed order so that it
      // is enum-ish rather than caller-shaped: "email", "phone" or
      // "email+phone". It says WHICH detail was corrected and nothing whatever
      // about its value.
      toStatus: ["email", "phone"].filter((f) => changed.includes(f)).join("+"),
      count: changed.length,
    });
  }
  return principal;
}
```

- [ ] **Step 20: Run the test and watch it pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/principal.test.js`

Expected: PASS - 17 tests, 0 failures.

- [ ] **Step 21: Run the whole suite**

Run: `npm test`

Expected: every existing test still passes. No existing test needs updating, and the reasons are worth checking if one does fail:

- Every row this task writes goes to `trailentries`. No existing test reads that collection, and the `countDocuments` guards that could have caught a stray write are all scoped to another model - `children.test.js:82,:112` count `Principal` and `children.test.js:83,:113` count `ConsentRecord`; `auth.test.js:226,:313` count `Principal` and `auth.test.js:229,:314` count `ConsentRecord`.
- `test/injection.test.js` passes operator objects as `principalId`; `assertPrincipalId` still throws before any trail write, so its "the victim's ledger stays at exactly one granted event" assertion is untouched.
- `test/lifecycle.test.js`'s original 8 tests call the `advance*` wrappers with `{ models, ... }` already, so threading `models` into `advance()` changes nothing for them.
- `test/principal.test.js`'s racing-corrections test still sees exactly one 409 and one success: the new `recordTrail` call sits after `save()` and cannot change which write wins.
- `test/index.test.js` checks that named exports are present, not that the list is exact, and this task adds no export.

If the suite fails with `TypeError: Cannot read properties of undefined (reading 'create')` inside `recordTrail`, `models.TrailEntry` is not registered - the model task's line in `src/models/index.js` is missing.

- [ ] **Step 22: Commit**

```bash
git add src/utils/principalId.js test/principal.test.js
git commit -m "feat(principal): record contact corrections and updates refused on erased records"
```

---

### Task 5: The trail read - `getConsentTrail` and `findConsentTrailByContact`

**Files:**
- Modify: `src/services/consentTrail.js` (Task 2 created it; this task appends a section and rewrites the final `module.exports` line)
- Test: `test/trailread.test.js` (new)

**Implements:** Design section 8.1 (the trail read - timeline element shape, derived `kind` vocabulary, ordering and its tiebreak, `limit`/`truncated`/`totalEntries`), section 8.3 (the unmounted `findConsentTrailByContact`), section 4 (the partition rule, as an executable property), section 8.5's withholding rule (`includeOperatorRefs`), and test-plan cases 1, 2, 3 and 10.

**Interfaces:**
- Consumes, from Task 1: `models.TrailEntry`, registered in `src/models/index.js` and reachable only through the registry. Its paths are `principalId, at, kind, outcome, reasonCode, actor: { role, ref, channel }, refId, receiptId, consentTypes, fromStatus, toStatus, count, caseRef`.
- Consumes, from Task 2, which ends `src/services/consentTrail.js` with `module.exports = { COVERAGE_FROM, UNATTRIBUTED, recordTrail, recordTrailStrict };`. This task uses `const COVERAGE_FROM = "2026-09-04";` and `async function recordTrail(models, entry)` directly, and every one of the other two names must SURVIVE the two `module.exports` rewrites below. `UNATTRIBUTED = { role: "unattributed", channel: "library" }` is the default actor of every service Tasks 3 and 4 instrument: drop it and `entry.actor || UNATTRIBUTED` is `undefined`, `buildDoc` throws a TypeError that `recordTrail`'s fail-open catch swallows, and every library-initiated row silently stops being written.
- Consumes, from Task 4 - the twelve-act timeline provokes its instrumentation rather than simulating it, so this task runs after it: `withdrawConsent({ models, principalId, consentTypes, actor })`, which writes one `withdrawal_not_applied` / `not_withdrawable` row carrying `receiptId`, `consentTypes` and `count`; and `advanceGrievance({ models, refId, status, actor })`, which writes one `request_status_changed` row carrying `refId`, `fromStatus` and `toStatus`.
- Consumes, unchanged from the repo: `assertPrincipalId(value, field = "principalId")` and `assertOpaqueRef(value, field)` (`src/utils/validate.js`), `AppError(message, status)` (`src/utils/errors.js`), `findPrincipalByContact({ models, email, phone })` (`src/utils/principalId.js:158`), `lookupHash(value)` (same file), `getValidConsentTypes()` (`src/config/catalog.js`), `exerciseRight({ models, principalId, right, details })` (`src/services/dataPrincipalRights.js`) and `consentManagerRequest({ models, principalId, message })` (`src/services/consentManagerRequest.js`) - the last two are read-side fixtures only, and neither is instrumented by any task.
- Produces, for Task 6 (the principal-facing `GET /consent/trail`) and Task 8 (the back-office router):
  - `async function getConsentTrail({ models, principalId, limit = 500, includeOperatorRefs = false })` -> `Promise<{ principalId, docRef, coverageFrom, timeline, truncated, totalEntries }>`; throws `AppError(..., 400)` on a bad `principalId` or `limit`, `AppError(..., 404)` when the principal is unknown.
  - `async function findConsentTrailByContact({ models, email, phone })` -> the same object, or `null`; propagates `findPrincipalByContact`'s `AppError(..., 409)` on an ambiguous phone number.
  - Neither name is added to the package's public surface here. **Task 9 solely owns `src/index.js` and `test/index.test.js`**, and it is the task that requires and exports `getConsentTrail` and `findConsentTrailByContact` (alongside `createBackOfficeRouter`). This task must not touch either file: a second `const { getConsentTrail, findConsentTrailByContact } = require("./services/consentTrail");` in the same module scope is a hard `SyntaxError: Identifier 'getConsentTrail' has already been declared`, and `require("../src/index")` then fails for the whole suite.

---

- [ ] **Step 1: Write the failing tests**

A new file rather than a section appended to Task 1's `test/trail.test.js`: the read tests need ten more requires than the schema tests do - every act below goes through the service a host would call - and one task should not have to rewrite another task's module header.

Create `test/trailread.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
const { buildModels } = require("../src/models");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const withdrawConsent = require("../src/services/withdrawConsent");
const { advanceGrievance } = require("../src/services/requestLifecycle");
const { complaintToTheBoard, escalateToBoard } = require("../src/services/complaintToTheBoard");
const { exerciseRight } = require("../src/services/dataPrincipalRights");
const consentManagerRequest = require("../src/services/consentManagerRequest");
const { erasePrincipalPII } = require("../src/services/erasure");
const { lookupHash } = require("../src/utils/principalId");
const { assertOpaqueRef } = require("../src/utils/validate");
const { getValidConsentTypes } = require("../src/config/catalog");
const {
  COVERAGE_FROM,
  recordTrail,
  getConsentTrail,
  findConsentTrailByContact,
} = require("../src/services/consentTrail");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };
const BHIM = { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" };

// Guarantees two acts land in different milliseconds, so an ordering
// assertion is deterministic rather than a race against the clock. Same
// helper, same reason, as test/consent.test.js:24.
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// The actor a router builds for a signed-in data principal, and the one the
// back office builds. `ref` is the field includeOperatorRefs gates.
const PRINCIPAL_API = { role: "principal", channel: "api" };
const OPERATOR = { role: "operator", ref: "emp-10432", channel: "api" };
// Every derived entry carries this one, because no primary collection stores
// an actor at all.
const DERIVED = { role: "principal", channel: "library" };

// ---------------------------------------------------------------------------
// The twelve-act timeline. This is the feature's executable documentation:
// the element shape, both sources, the derived vocabulary, the descending
// order and the identical-timestamp tiebreak, all pinned in one deepEqual.
// ---------------------------------------------------------------------------

/**
 * The twelve acts, played through the real services.
 *
 * A helper rather than a body inlined in one test, because three tests need
 * this exact history: the timeline that reads it back, the property scan that
 * walks every string it produced, and the erasure scan that proves what those
 * rows do NOT contain.
 *
 * Every act goes through the service a host would call - including the three
 * that produce STORED rows. Writing those three with recordTrail directly
 * would have tested the reader while bypassing the writer: an instrumentation
 * site deleted from withdrawConsent or requestLifecycle would leave this test
 * green, which is the opposite of what "the feature's executable
 * documentation" is for.
 */
async function playTwelveActs(models) {
  // Act 1 - signup. persistPIIwithconsent.js:146 stamps every event of one
  // submission with the same `now`, so this single act produces five ledger
  // events sharing one millisecond.
  const signup = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
  const { principalId } = signup;
  await tick();

  // Act 2 - a consent update granting one further purpose.
  const update = await persistPIIwithconsent({
    models, principalId, pii: PII, consentTypes: ["marketing", "underwriting"],
  });
  await tick();

  // Act 3 - a withdrawal the library refused, provoked rather than
  // simulated. kyc_reporting rests on Section 7(d), not on consent, so
  // withdrawConsent skips save() entirely (withdrawConsent.js:50-56 and :75)
  // and nothing survives the call but the row it writes.
  const refusal = await withdrawConsent({
    models, principalId, consentTypes: ["kyc_reporting"], actor: PRINCIPAL_API,
  });
  assert.equal(
    refusal.withdrawn.length,
    0,
    "setup check - kyc_reporting must actually be refused, or act 3 writes no row and all three tests weaken silently"
  );
  await tick();

  // Act 4 - a grievance.
  const grievance = await complaintToTheBoard({
    models, principalId, subject: "No answer", description: "I asked twice and heard nothing.",
  });
  await tick();

  // Act 5 - the Grievance Officer picks it up. requestLifecycle overwrites
  // status in place, so "open" exists nowhere else once this returns.
  await advanceGrievance({ models, refId: grievance.refId, status: "in_progress", actor: OPERATOR });
  await tick();

  // Act 6 - escalation, once the SLA has lapsed.
  const filed = await models.Grievance.findOne({ refId: grievance.refId });
  filed.slaDueAt = new Date(Date.now() - 1000);
  await filed.save();
  const escalation = await escalateToBoard({ models, refId: grievance.refId, principalId });
  await tick();

  // Act 7 - and finally resolved.
  await advanceGrievance({ models, refId: grievance.refId, status: "resolved", actor: OPERATOR });
  await tick();

  // Act 8 - erasure. The PII goes; the pseudonymous evidence stays.
  const erasure = await erasePrincipalPII({ models, principalId });

  return { principalId, signup, update, refusal, grievance, filed, escalation, erasure };
}

test("the twelve-act timeline reads back exactly, newest first, in one shape", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId, signup, update, refusal, grievance, filed, escalation, erasure } =
      await playTwelveActs(models);
    assert.equal(update.events.length, 1, "setup check - act 2 must append exactly one ledger event");

    // The moments are read back from the primary collections rather than
    // guessed. The trail reports observed timestamps and never invents one,
    // so a test that invented them would not be testing the same thing.
    const record = await models.ConsentRecord.findOne({ principalId }).lean();
    const signupAt = record.events[0].timestamp;
    const updateAt = record.events[5].timestamp;
    const stored = await models.TrailEntry.find({ principalId }).sort({ _id: 1 }).lean();
    assert.equal(stored.length, 3, "setup check - acts 3, 5 and 7 are the only stored rows");
    const [refusalAt, pickedUpAt, resolvedAt] = stored.map((row) => row.at);

    const trail = await getConsentTrail({ models, principalId });

    assert.deepEqual(
      trail.timeline,
      [
        { at: erasure.erasedAt, kind: "principal_erased", source: "derived", outcome: "recorded", actor: DERIVED },
        {
          at: resolvedAt, kind: "request_status_changed", source: "stored", outcome: "recorded",
          actor: { role: "operator", channel: "api" }, refId: grievance.refId,
          fromStatus: "escalated", toStatus: "resolved",
        },
        {
          at: escalation.escalatedAt, kind: "grievance_escalated", source: "derived",
          outcome: "recorded", actor: DERIVED, refId: grievance.refId,
        },
        {
          at: pickedUpAt, kind: "request_status_changed", source: "stored", outcome: "recorded",
          actor: { role: "operator", channel: "api" }, refId: grievance.refId,
          fromStatus: "open", toStatus: "in_progress",
        },
        {
          at: filed.createdAt, kind: "grievance_filed", source: "derived",
          outcome: "recorded", actor: DERIVED, refId: grievance.refId,
        },
        {
          at: refusalAt, kind: "withdrawal_not_applied", source: "stored", outcome: "refused",
          actor: { role: "principal", channel: "api" }, reasonCode: "not_withdrawable",
          // The receipt withdrawConsent handed the person for the call it
          // then refused - the row cites what they were given.
          receiptId: refusal.receiptId,
          consentTypes: ["kyc_reporting"], count: 1,
        },
        {
          at: updateAt, kind: "consent_granted", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: update.receiptId, consentTypes: ["underwriting"],
        },
        // The five decisions of one submission, at one millisecond, in
        // reverse array position - the tiebreak doing the only job it has.
        {
          at: signupAt, kind: "consent_denied", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: signup.receiptId, consentTypes: ["analytics"],
        },
        {
          at: signupAt, kind: "consent_granted", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: signup.receiptId, consentTypes: ["marketing"],
        },
        {
          at: signupAt, kind: "consent_denied", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: signup.receiptId, consentTypes: ["underwriting"],
        },
        {
          at: signupAt, kind: "consent_denied", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: signup.receiptId, consentTypes: ["identity_verification"],
        },
        {
          at: signupAt, kind: "consent_granted", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: signup.receiptId, consentTypes: ["kyc_reporting"],
        },
      ],
      "the whole timeline, one shape for both sources, newest first - a consumer must never have to branch on where an entry came from"
    );

    assert.equal(trail.principalId, principalId);
    assert.equal(trail.docRef, record.docRef);
    assert.equal(trail.coverageFrom, COVERAGE_FROM, "a trail must be able to say when we started recording, or an empty one implies nothing happened");
    assert.equal(trail.totalEntries, 12, "twelve MERGED entries - a count of stored rows alone would have said three");
    assert.equal(trail.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// The same twelve acts, scanned (design section 10, cases 2 and 3): what the
// stored rows are allowed to contain, and what they must not contain after an
// erasure. A spot check against one hardcoded literal proves only that ONE
// address did not leak; these two walk everything that is actually there.
// ---------------------------------------------------------------------------

test("every string on every trail row matches a known-safe shape, and the scan is not vacuous", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await playTwelveActs(models);

    // Read off the schema rather than restated here, so the allow-list cannot
    // drift from the vocabulary the collection actually enforces.
    const kinds = models.TrailEntry.schema.path("kind").enumValues;
    const outcomes = models.TrailEntry.schema.path("outcome").enumValues;
    const reasonCodes = models.TrailEntry.schema.path("reasonCode").enumValues;
    const roles = models.TrailEntry.schema.path("actor").schema.path("role").enumValues;
    const channels = models.TrailEntry.schema.path("actor").schema.path("channel").enumValues;
    // fromStatus and toStatus are unenumerated on TrailEntry, because they
    // hold values belonging to three other schemas. Every one of those is a
    // closed enum this library controls, and none of them is caller text.
    const statuses = new Set([
      ...models.RightsRequest.schema.path("status").enumValues,
      ...models.Grievance.schema.path("status").enumValues,
      ...models.ConsentManagerRequest.schema.path("status").enumValues,
      // contact_corrected puts WHICH fields changed in toStatus, as one of
      // exactly these three - never the old or new value, nor a hash of one.
      "email", "phone", "email+phone",
    ]);
    const isOpaqueRef = (value) => {
      try {
        assertOpaqueRef(value, "value");
        return true;
      } catch {
        return false;
      }
    };

    // Named shapes rather than one combined regex, so a failure names the
    // string that is unaccounted for and a reviewer can read what is
    // permitted. The opaque reference is scoped to the only two fields that
    // may carry one: it is much the loosest shape here - assertOpaqueRef
    // bounds shape and not meaning - so admitting it at every path would let
    // this scan pass on almost anything.
    const shapes = [
      ["a 64-hex principalId", (v) => /^[a-f0-9]{64}$/.test(v)],
      ["a 24-hex ObjectId", (v) => /^[a-f0-9]{24}$/.test(v)],
      ["an ISO-8601 instant", (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)],
      ["a generated reference", (v) => /^(RC|RQ|GR|CM)-[0-9A-F]{16}$/.test(v)],
      ["a trail kind", (v) => kinds.includes(v)],
      ["an outcome", (v) => outcomes.includes(v)],
      ["a reason code", (v) => reasonCodes.includes(v)],
      ["an actor role", (v) => roles.includes(v)],
      ["an actor channel", (v) => channels.includes(v)],
      ["a request status", (v) => statuses.has(v)],
      ["a catalog consent type", (v) => getValidConsentTypes().includes(v)],
      ["an opaque operator reference", (v, path) => /(^|\.)(ref|caseRef)$/.test(path) && isOpaqueRef(v)],
    ];

    // The JSON rendering rather than the lean documents themselves: it turns
    // each ObjectId into its hex string and each Date into an ISO string,
    // which is the form anything downstream sees, and leaves a tree of plain
    // values to walk.
    const rows = JSON.parse(JSON.stringify(await models.TrailEntry.find({}).lean()));
    const seen = [];
    const walk = (value, path) => {
      if (typeof value === "string") return void seen.push([path, value]);
      if (Array.isArray(value)) return void value.forEach((item, i) => walk(item, `${path}[${i}]`));
      if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
      }
    };
    walk(rows, "$");

    for (const [path, value] of seen) {
      assert.ok(
        shapes.some(([, matches]) => matches(value, path)),
        `unaccounted-for string at ${path}: ${JSON.stringify(value)} - this collection survives erasure, so every string on it must be a value this library generated or an enum it controls`
      );
    }

    // The non-vacuity inverse. A walker that descended into nothing, or an
    // empty collection, satisfies the loop above by finding no strings at all
    // - which is exactly the way a property scan silently stops testing.
    assert.ok(seen.length > 0, "the scan must actually have walked strings, or it proves nothing");
    const values = seen.map(([, value]) => value);
    assert.ok(values.includes(principalId), "it reached leaf values, not just the top level of each document");
    assert.ok(
      values.includes("withdrawal_not_applied") && values.includes("request_status_changed"),
      "and it covered all three rows the twelve acts produced"
    );
  });
});

test("after erasure the trail keeps every row and holds neither contact hash - pseudonymous evidence, not a second index of the person", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await playTwelveActs(models);

    const principal = await models.Principal.findOne({ principalId }).lean();
    assert.ok(principal.erasedAt, "setup check - the twelve acts end in an erasure");
    assert.equal(principal.emailHash, undefined, "setup check - erasure destroyed the very hashes this test scans for");

    assert.notEqual(
      await models.TrailEntry.countDocuments({}),
      0,
      "the trail survives erasure - a collection emptied by it would satisfy the two assertions below while proving nothing"
    );

    // EVERY collection, not just the trail. The spec's wording is "appears in
    // zero documents anywhere in the database", and scoping the scan to
    // TrailEntry would let a future task reintroduce the hash on some other
    // record and still pass. Iterating the registry also means a model added
    // later is covered the day it is registered, with no edit here.
    for (const [name, Model] of Object.entries(models)) {
      const rendered = JSON.stringify(await Model.find({}).lean());
      assert.equal(
        rendered.includes(lookupHash(PII.email)),
        false,
        `the email lookup hash appears in ZERO ${name} documents - a record carrying both it and a principalId would rebuild the contact-to-person index that erasure exists to destroy`
      );
      assert.equal(
        rendered.includes(lookupHash(PII.phone)),
        false,
        `and neither does the phone hash, in ${name} - the trail schema has no contact-hash field at all, and this is what keeps that true end to end`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The partition rule (design section 4), as an executable property
// ---------------------------------------------------------------------------

test("a principal with no stored entries still gets their derived ledger - an empty trailentries collection is not an empty trail", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId, receiptId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    assert.equal(await models.TrailEntry.countDocuments({}), 0, "setup check - nothing has written a stored row");

    const trail = await getConsentTrail({ models, principalId });
    assert.equal(trail.totalEntries, 5, "five catalog decisions, every one of them derived from the ledger");
    assert.ok(trail.timeline.every((e) => e.source === "derived"));
    assert.ok(trail.timeline.every((e) => e.receiptId === receiptId), "each derived consent entry carries the receipt of the submission that wrote it");
    assert.deepEqual(
      trail.timeline.map((e) => e.consentTypes[0]),
      ["analytics", "marketing", "underwriting", "identity_verification", "kyc_reporting"],
      "one submission, one timestamp - so the order is array position descending"
    );
    assert.equal(trail.coverageFrom, COVERAGE_FROM);
  });
});

test("a successful withdrawal appears once, derived - the partition rule makes double-reporting impossible by construction", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await tick();
    const result = await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });
    assert.deepEqual(result.withdrawn, ["marketing"], "setup check - the withdrawal must actually have taken effect");

    const trail = await getConsentTrail({ models, principalId });
    const withdrawals = trail.timeline.filter((e) => e.kind === "consent_withdrawn");
    assert.equal(withdrawals.length, 1, "the ledger observed it, so it is derived and never also stored - this is what deletes the 120-line dedup pass an earlier design needed");
    assert.equal(withdrawals[0].source, "derived");
    assert.deepEqual(withdrawals[0].consentTypes, ["marketing"]);
    assert.equal(trail.totalEntries, 6, "five signup decisions plus one withdrawal, not seven");
  });
});

test("a rights request and a consent-manager request appear on the filer's own trail, each at the moment its own collection observed", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await tick();
    const right = await exerciseRight({
      models, principalId, right: "correction", details: "My address is out of date",
    });
    await tick();
    const cm = await consentManagerRequest({
      models, principalId, message: "Please connect me to a Consent Manager",
    });

    const trail = await getConsentTrail({ models, principalId });
    const filed = trail.timeline.find((e) => e.kind === "rights_request_filed");
    const asked = trail.timeline.find((e) => e.kind === "consent_manager_requested");
    assert.ok(
      filed && asked,
      "both derived kinds must appear - these are the only two branches of the read that nothing else exercises, so a typo in either kind string ships undetected"
    );

    const rightsRow = await models.RightsRequest.findOne({ refId: right.refId }).lean();
    const cmRow = await models.ConsentManagerRequest.findOne({ refId: cm.refId }).lean();

    assert.equal(filed.source, "derived");
    assert.equal(filed.outcome, "recorded");
    assert.deepEqual(filed.actor, DERIVED);
    assert.equal(filed.refId, right.refId, "the entry cites the reference the person holds, so they can match it to their own request");
    assert.deepEqual(filed.at, rightsRow.createdAt, "createdAt, not updatedAt - the entry reports when it was FILED, and a later status change must not move it");

    assert.equal(asked.source, "derived");
    assert.equal(asked.outcome, "recorded");
    assert.deepEqual(asked.actor, DERIVED);
    assert.equal(asked.refId, cm.refId);
    assert.deepEqual(asked.at, cmRow.createdAt);

    assert.equal(
      await models.TrailEntry.countDocuments({}),
      0,
      "neither act stores a row - both are read straight off the collection that already observed them, which is the partition rule again"
    );
    assert.equal(trail.totalEntries, 7, "five signup decisions plus the two filings");
    assert.equal(trail.timeline[0].kind, "consent_manager_requested", "newest first, and that request is the most recent act");
    assert.doesNotMatch(
      JSON.stringify(trail),
      /My address is out of date/,
      "the derived entry projects the reference and nothing else - the free text a person typed stays in the collection they typed it into"
    );
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("at one identical instant a stored entry sorts ahead of every derived one, and ledger events fall in reverse array position", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const record = await models.ConsentRecord.findOne({ principalId }).lean();
    const at = record.events[0].timestamp;

    // Created directly rather than through recordTrail: this row needs the
    // LEDGER's exact millisecond, and recordTrail deliberately stamps its own.
    await models.TrailEntry.create({
      principalId,
      at,
      kind: "consent_refused",
      outcome: "refused",
      reasonCode: "prohibited_for_child",
      actor: { role: "principal", channel: "html" },
      consentTypes: ["analytics"],
      count: 1,
    });

    const trail = await getConsentTrail({ models, principalId });
    assert.ok(
      trail.timeline.every((e) => e.at.getTime() === at.getTime()),
      "setup check - all six entries really do share one millisecond, or this test proves nothing"
    );
    assert.deepEqual(
      trail.timeline.map((e) => `${e.source}:${e.kind}:${e.consentTypes[0]}`),
      [
        "stored:consent_refused:analytics",
        "derived:consent_denied:analytics",
        "derived:consent_granted:marketing",
        "derived:consent_denied:underwriting",
        "derived:consent_denied:identity_verification",
        "derived:consent_granted:kyc_reporting",
      ],
      "consentEventSchema is {_id:false}, so ledger events have no id to fall back on - without the tiebreak this order is whatever the sort happened to do"
    );
  });
});

// ---------------------------------------------------------------------------
// Bounding: limit, truncated and totalEntries count MERGED entries
// ---------------------------------------------------------------------------

test("limit, truncated and totalEntries count merged entries, not stored rows", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await tick();
    await recordTrail(models, {
      principalId, kind: "consent_refused", outcome: "refused",
      reasonCode: "record_erased", actor: PRINCIPAL_API,
    });

    const full = await getConsentTrail({ models, principalId });
    assert.equal(full.totalEntries, 6);
    assert.equal(full.truncated, false);

    const cut = await getConsentTrail({ models, principalId, limit: 2 });
    assert.equal(cut.timeline.length, 2);
    assert.equal(cut.totalEntries, 6, "totalEntries is the full merged count, so a cut caller knows by how much they were cut");
    assert.equal(cut.truncated, true, "truncated says plainly that the caller has not seen everything");
    assert.equal(cut.timeline[0].kind, "consent_refused", "a cut keeps the NEWEST entries - the oldest are the ones a caller can afford to lose");
    assert.equal(cut.timeline[0].source, "stored", "one stored row against five derived - a limit applied per source would have returned six");

    await assert.rejects(
      () => getConsentTrail({ models, principalId, limit: "2" }),
      (err) => err.status === 400,
      "limit is caller-supplied, so it is bounded by shape like every other input here"
    );
    await assert.rejects(
      () => getConsentTrail({ models, principalId, limit: 0 }),
      (err) => err.status === 400
    );
  });
});

// ---------------------------------------------------------------------------
// Erasure, and the operator-reference gate (design sections 8.5 and 9)
// ---------------------------------------------------------------------------

test("an erased principal still has a trail, and it names the erasure", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await tick();
    await recordTrail(models, {
      principalId, kind: "contact_corrected", outcome: "recorded", actor: PRINCIPAL_API,
    });
    await tick();
    const { erasedAt } = await erasePrincipalPII({ models, principalId });

    const trail = await getConsentTrail({ models, principalId });
    assert.equal(trail.timeline[0].kind, "principal_erased");
    assert.deepEqual(
      trail.timeline[0].at,
      erasedAt,
      "derived from Principal.erasedAt - erasePrincipalPII writes nothing to the trail and edits nothing in it"
    );
    assert.equal(trail.totalEntries, 7, "the trail survives erasure as pseudonymous evidence, exactly as the consent ledger does");
    assert.ok(trail.timeline.some((e) => e.kind === "contact_corrected"), "the stored half survives too");

    const rendered = JSON.stringify(trail);
    assert.doesNotMatch(rendered, /asha@example\.com/i, "no contact detail reaches the trail, before erasure or after");
    assert.doesNotMatch(rendered, /Asha/, "and no name either");
  });
});

test("includeOperatorRefs withholds actor.ref and caseRef from the data principal and gives them to the back office", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await tick();
    await recordTrail(models, {
      principalId, kind: "operator_trail_read", outcome: "recorded",
      actor: OPERATOR, caseRef: "INC-0042199",
    });

    const mine = await getConsentTrail({ models, principalId });
    const seen = mine.timeline[0];
    assert.equal(
      seen.kind,
      "operator_trail_read",
      "a data principal exercising Section 11 sees THAT someone read their record - this is the headline of the feature, not the back office"
    );
    assert.deepEqual(seen.actor, { role: "operator", channel: "api" });
    assert.equal(Object.hasOwn(seen.actor, "ref"), false, "WHICH operator is the adopter's own staff member's personal data, and not this principal's business");
    assert.equal(Object.hasOwn(seen, "caseRef"), false, "the ticket reference is never rendered back to a data principal");

    const backOffice = await getConsentTrail({ models, principalId, includeOperatorRefs: true });
    assert.deepEqual(backOffice.timeline[0].actor, { role: "operator", ref: "emp-10432", channel: "api" });
    assert.equal(
      backOffice.timeline[0].caseRef,
      "INC-0042199",
      "who and why together is what makes the access record accountability rather than a counter"
    );
  });
});

// ---------------------------------------------------------------------------
// Scoping and injection
// ---------------------------------------------------------------------------

test("an unknown principalId is 404 and an operator object is 400 - neither reaches a query filter", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    await assert.rejects(
      () => getConsentTrail({ models, principalId: "f".repeat(64) }),
      (err) => err.status === 404,
      "the same 404 whether the id belongs to nobody or to somebody else - a 403 would confirm the record exists"
    );
    for (const hostile of [{ $ne: null }, { $gt: "" }, { $regex: "." }]) {
      await assert.rejects(
        () => getConsentTrail({ models, principalId: hostile }),
        (err) => err.status === 400,
        "mongoose does not strip query operators during casting, so the shape check is the actual control"
      );
    }
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trailread.test.js`

Expected: FAIL. Every test errors with `TypeError: getConsentTrail is not a function` - the name destructured at the top of the file is `undefined` because `src/services/consentTrail.js` exports only `COVERAGE_FROM`, `UNATTRIBUTED`, `recordTrail` and `recordTrailStrict` so far.

- [ ] **Step 3: Add the read section's requires, constants and helpers**

At the very top of `src/services/consentTrail.js`, in the existing require block Task 2 wrote, make sure these three lines are present. `AppError` is already there (`recordTrailStrict` throws it); add the other two.

```js
const { AppError } = require("../utils/errors");
const { assertPrincipalId } = require("../utils/validate");
const { findPrincipalByContact } = require("../utils/principalId");
```

Then append this block to the end of the file, above the final `module.exports` line:

```js
// ---------------------------------------------------------------------------
// The trail read (design section 8.1)
// ---------------------------------------------------------------------------

// The caller's window onto the merge. `limit` is caller-supplied, so it is
// bounded by shape like every other input in this library.
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

// How many rows the read loads from ONE source before it stops. `limit`
// bounds what the caller sees; this bounds what the read has to hold in order
// to count the merge honestly. It sits well above MAX_LIMIT, and under the
// partition rule - the trail stores only what nothing else records - a
// principal's stored entries are single digits, so nothing this library
// writes comes near it.
const MAX_SCAN = 5000;

/**
 * The actor on every derived entry, because none of the five primary
 * collections records one: ConsentRecord.events, RightsRequest, Grievance,
 * ConsentManagerRequest and Principal.erasedAt each store what happened and
 * not who did it.
 *
 * Read as a claim about a person it would be wrong on at least one kind -
 * principal_erased is a fiduciary-side act, since erasePrincipalPII is
 * exported and deliberately unmounted (src/index.js:35-37). What it means is
 * "this came out of the principal's own record, and nothing observed who
 * acted". The entries that genuinely name an actor are the stored ones, which
 * is the whole reason design section 4 puts `actor` in the stored half.
 *
 * Frozen because one object is shared by every derived entry of every read.
 */
const DERIVED_ACTOR = Object.freeze({ role: "principal", channel: "library" });

/** ConsentRecord.events[].status -> the derived kind. The enum is closed to these three. */
const LEDGER_KIND = {
  granted: "consent_granted",
  denied: "consent_denied",
  withdrawn: "consent_withdrawn",
};

/**
 * Drops undefined-valued keys.
 *
 * The timeline element has twelve fields and most are undefined on most
 * entries. Keeping them as present-but-undefined keys would make the object a
 * direct library caller sees differ from the one an HTTP caller sees -
 * JSON.stringify drops undefined - so a deepEqual written against one would
 * not hold against the other. Dropping them here makes the two identical. A
 * consumer still never branches on source: entry.refId reads as undefined
 * either way.
 */
function compact(entry) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * `limit` bounds a slice rather than a query, but it is validated before use
 * for the same reason everything else here is: there is no honest way to
 * report `truncated` for a limit that is not a number, and an unbounded read
 * is the one read in the toolkit whose size a data principal can grow.
 */
function assertLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new AppError(`limit must be an integer between 1 and ${MAX_LIMIT}`, 400);
  }
  return value;
}

/**
 * Ordering: `at` descending, then stored before derived at the same instant,
 * then insertion order descending - the stored row's _id, or the ledger
 * event's array position.
 *
 * The tiebreak is real rather than theoretical. persistPIIwithconsent.js:146
 * stamps every event of one submission with the same `now`, so a signup
 * deciding five purposes produces five entries with identical timestamps, and
 * consentEventSchema is declared {_id: false} (ConsentRecord.js:24) so they
 * have no id to fall back on.
 *
 * Every derived entry that is not a ledger event takes ordinal 0. Its source
 * document does have an _id, but two documents from different collections
 * stamped in the same millisecond have no meaningful order between them, and
 * inventing one would be a claim the data does not support.
 * Array.prototype.sort is stable, so anything all three rules leave equal
 * keeps the order collect() below pushed it in.
 */
function byRecency(a, b) {
  const byTime = b.at.getTime() - a.at.getTime();
  if (byTime !== 0) return byTime;
  if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
  if (a.ordinal === b.ordinal) return 0;
  return a.ordinal > b.ordinal ? -1 : 1;
}
```

- [ ] **Step 4: Add `getConsentTrail`**

Append below the helpers, still above `module.exports`:

```js
/**
 * A data principal's whole lineage: the stored trail entries merged with the
 * events design section 4 derives from the primary collections, newest first.
 *
 * Bounded, and deliberately WITHOUT a cursor. sanitizeFilter is set on this
 * library's connections (db/connection.js:29), which rewrites {at: {$lt: c}}
 * into {at: {$eq: {$lt: c}}} and CastErrors; the query-builder spellings
 * .where("at").lt(c) and .lt("at", c) are broken by it too. The only escapes
 * are mongoose.trusted() and aggregate(), and trusted() is a total bypass of
 * the connection's one structural injection guard. Under the partition rule a
 * normal principal has single-digit stored entries, so an explicit
 * `truncated` flag with a `totalEntries` count is honest and needs neither.
 *
 * Scoped by construction: principalId is in every filter, never checked after
 * the fact, and an id belonging to nobody and an id belonging to somebody
 * else produce the same 404 - the same reasoning as consentState.js:12-16.
 *
 * The element carries no noticeVersion. The notice in force for a given
 * consent event stays on getConsentState's ledger projection
 * (consentState.js:37), which is where a consumer resolves it; repeating it
 * here would make the derived half a different shape from the stored half,
 * and one shape for both is the property this read exists to provide.
 *
 * @param {object}  input
 * @param {object}  input.models
 * @param {string}  input.principalId
 * @param {number}  [input.limit=500]  - MERGED entries, not stored rows.
 * @param {boolean} [input.includeOperatorRefs=false] - include actor.ref and
 *   caseRef. False on the principal-facing read: that an operator read their
 *   record is exactly what a data principal is owed under Section 11, and
 *   which operator is the adopter's own staff member's personal data. True on
 *   the back-office read, where who and why is the point.
 * @returns {Promise<{ principalId, docRef, coverageFrom, timeline, truncated, totalEntries }>}
 */
async function getConsentTrail({ models, principalId, limit = DEFAULT_LIMIT, includeOperatorRefs = false }) {
  assertPrincipalId(principalId);
  const max = assertLimit(limit);

  // Plain equality filters, .sort() and .limit() only. sanitizeFilter makes
  // an operator filter CastError, so {at: {$gte: d}} is not available to this
  // library's own queries and no code here should grow one.
  const [record, principal, storedRows, rightsRequests, grievances, cmRequests] = await Promise.all([
    models.ConsentRecord.findOne({ principalId }).lean(),
    models.Principal.findOne({ principalId }).lean(),
    models.TrailEntry.find({ principalId }).sort({ at: -1, _id: -1 }).limit(MAX_SCAN).lean(),
    models.RightsRequest.find({ principalId }).sort({ createdAt: -1 }).limit(MAX_SCAN).lean(),
    models.Grievance.find({ principalId }).sort({ createdAt: -1 }).limit(MAX_SCAN).lean(),
    models.ConsentManagerRequest.find({ principalId }).sort({ createdAt: -1 }).limit(MAX_SCAN).lean(),
  ]);

  if (!record && !principal) throw new AppError("No record found for this principal", 404);

  const merged = [];
  const collect = (sourceRank, ordinal, entry) =>
    merged.push({ at: entry.at, sourceRank, ordinal, entry: compact(entry) });

  // The stored half: facts destroyed or never written anywhere else.
  for (const row of storedRows) {
    collect(0, String(row._id), {
      at: row.at,
      kind: row.kind,
      source: "stored",
      outcome: row.outcome,
      actor: includeOperatorRefs
        ? compact({ role: row.actor.role, ref: row.actor.ref, channel: row.actor.channel })
        : { role: row.actor.role, channel: row.actor.channel },
      reasonCode: row.reasonCode,
      refId: row.refId,
      receiptId: row.receiptId,
      consentTypes: row.consentTypes,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      count: row.count,
      caseRef: includeOperatorRefs ? row.caseRef : undefined,
    });
  }

  // The derived half. Never copied into the trail, always read from the
  // collection that already observed it.
  if (record) {
    record.events.forEach((event, index) => {
      collect(1, index, {
        at: event.timestamp,
        kind: LEDGER_KIND[event.status],
        source: "derived",
        outcome: "recorded",
        actor: DERIVED_ACTOR,
        receiptId: event.receiptId,
        // A one-element list, so the field means the same thing on a derived
        // entry as on a stored one that collapsed three refused purposes.
        consentTypes: [event.type],
      });
    });
  }

  for (const row of rightsRequests) {
    collect(1, 0, {
      at: row.createdAt,
      kind: "rights_request_filed",
      source: "derived",
      outcome: "recorded",
      actor: DERIVED_ACTOR,
      refId: row.refId,
    });
  }

  for (const row of grievances) {
    collect(1, 0, {
      at: row.createdAt,
      kind: "grievance_filed",
      source: "derived",
      outcome: "recorded",
      actor: DERIVED_ACTOR,
      refId: row.refId,
    });
    // Two entries from one document: filing and escalating are separate acts
    // with separate observed moments, and Grievance stores both.
    if (row.escalatedAt) {
      collect(1, 0, {
        at: row.escalatedAt,
        kind: "grievance_escalated",
        source: "derived",
        outcome: "recorded",
        actor: DERIVED_ACTOR,
        refId: row.refId,
      });
    }
  }

  for (const row of cmRequests) {
    collect(1, 0, {
      at: row.createdAt,
      kind: "consent_manager_requested",
      source: "derived",
      outcome: "recorded",
      actor: DERIVED_ACTOR,
      refId: row.refId,
    });
  }

  if (principal && principal.erasedAt) {
    collect(1, 0, {
      at: principal.erasedAt,
      kind: "principal_erased",
      source: "derived",
      outcome: "recorded",
      actor: DERIVED_ACTOR,
    });
  }

  merged.sort(byRecency);
  const totalEntries = merged.length;
  const timeline = merged.slice(0, max).map((row) => row.entry);

  return {
    principalId,
    // Null only if a principal exists with no consent record at all. The
    // trail read does not require a ledger to be able to answer.
    docRef: record ? record.docRef : null,
    // A module constant, returned verbatim. It exists so a trail with nothing
    // in it can say "we were not recording before this date" rather than
    // implying nothing happened. See design section 6 for why it is not a
    // stored marker row.
    coverageFrom: COVERAGE_FROM,
    timeline,
    truncated: totalEntries > timeline.length,
    totalEntries,
  };
}
```

- [ ] **Step 5: Export `getConsentTrail`**

Replace the final `module.exports` line of `src/services/consentTrail.js` (Task 2 wrote it as `module.exports = { COVERAGE_FROM, UNATTRIBUTED, recordTrail, recordTrailStrict };`) with:

```js
module.exports = { COVERAGE_FROM, UNATTRIBUTED, recordTrail, recordTrailStrict, getConsentTrail };
```

Add the one name, keep every existing one. `UNATTRIBUTED` is not spare: Tasks 3 and 4 destructure `{ recordTrail, UNATTRIBUTED }` in `persistPIIwithconsent.js`, `withdrawConsent.js`, `requestLifecycle.js`, `complaintToTheBoard.js` and (lazily) `principalId.js`, and use it as the default actor. Drop it and `actor` defaults to `undefined`, `buildDoc`'s `entry.actor || UNATTRIBUTED` is `undefined`, and `source.role` throws - which `recordTrail`'s fail-open catch swallows, so every library-initiated row silently stops being written and the failure surfaces only as other tasks' tests finding zero rows.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trailread.test.js`

Expected: PASS - 11 tests.

- [ ] **Step 7: Commit**

```bash
git add src/services/consentTrail.js test/trailread.test.js
git commit -m "feat(trail): merge stored entries with derived ledger events into one read"
```

- [ ] **Step 8: Write the failing tests for `findConsentTrailByContact`**

Append to `test/trailread.test.js`:

```js
// ---------------------------------------------------------------------------
// The unmounted lookup by contact detail (design section 8.3)
// ---------------------------------------------------------------------------

test("findConsentTrailByContact resolves an email to a whole trail, and answers null rather than throwing when nobody holds it", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const record = await models.ConsentRecord.findOne({ principalId }).lean();

    const trail = await findConsentTrailByContact({ models, email: "  ASHA@example.com " });
    assert.equal(trail.principalId, principalId, "lookupHash normalises case and surrounding whitespace, so a hand-typed address still matches");
    assert.equal(trail.docRef, record.docRef);
    assert.equal(trail.coverageFrom, COVERAGE_FROM);
    assert.equal(trail.totalEntries, 5, "the same object getConsentTrail returns - this function resolves an identity, it does not shape a different read");

    assert.equal(
      await findConsentTrailByContact({ models, email: "nobody@example.com" }),
      null,
      "null, not a 404 - a library caller asking whether an address is one of ours gets an answer, not an exception"
    );
    assert.equal(await findConsentTrailByContact({ models }), null, "no contact detail at all is a miss, not an error");
  });
});

test("findConsentTrailByContact keeps the 409 on an ambiguous phone - a household handset is not an identity", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const shared = "9876500000";
    await persistPIIwithconsent({ models, pii: { ...PII, phone: shared }, consentTypes: ["marketing"] });
    await persistPIIwithconsent({ models, pii: { ...BHIM, phone: shared }, consentTypes: ["marketing"] });

    await assert.rejects(
      () => findConsentTrailByContact({ models, phone: shared }),
      (err) => err.status === 409,
      "findPrincipalByContact refuses to guess which household member a number belongs to, and answering with an arbitrary one of their trails would disclose the wrong person's whole lineage"
    );
  });
});
```

- [ ] **Step 9: Run the tests and watch the new ones fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trailread.test.js`

Expected: FAIL - the two new tests error with `TypeError: findConsentTrailByContact is not a function`. The eleven from the first cycle still pass.

- [ ] **Step 10: Implement `findConsentTrailByContact` and export it**

Append to `src/services/consentTrail.js`, above `module.exports`:

```js
/**
 * The trail for whoever a contact detail belongs to - the "given a direct
 * PII" half of the issue this feature answers.
 *
 * Deliberately NOT mounted on createRouter, and not for the usual reason. The
 * principal-facing rule is that principalId is a credential, so it never
 * comes from a payload; the input here is a raw email or phone number, which
 * is worse. A route taking one would let anyone who knows an address read
 * that person's entire lineage, and nothing in this library can prove the
 * caller controls the mailbox. src/http/backOfficeRouter.js is the supported
 * transport, and it exists precisely so that reaching this data requires
 * operator authentication and leaves an access record behind.
 *
 * It keeps findPrincipalByContact's phone branch, including its refusal of a
 * number that matches more than one data principal (utils/principalId.js:158-175).
 * A direct library caller is already inside the host's trust boundary, so the
 * household-handset ambiguity is a question the host can answer and an HTTP
 * surface cannot - which is why the back-office route is email-only and this
 * function is not.
 *
 * Writes no access record. The fail-closed disclosure log needs an operator
 * to attribute a read to; a call from host code has none, and filing one
 * under `unattributed` would put a row in the accountability record that
 * answers nobody's question. A host that calls this instead of mounting the
 * router owes its own operator_trail_read row.
 *
 * Operator references are withheld, because this takes the principal-facing
 * default. A back office wanting actor.ref and caseRef calls getConsentTrail
 * with includeOperatorRefs: true itself.
 *
 * @returns {Promise<object|null>} the same shape getConsentTrail returns, or
 *   null when no principal holds that contact detail.
 */
async function findConsentTrailByContact({ models, email, phone }) {
  const principal = await findPrincipalByContact({ models, email, phone });
  if (!principal) return null;
  return getConsentTrail({ models, principalId: principal.principalId });
}
```

Then replace the final `module.exports` line - again adding one name and keeping every existing one, for the reason spelled out in Step 5 - with:

```js
module.exports = { COVERAGE_FROM, UNATTRIBUTED, recordTrail, recordTrailStrict, getConsentTrail, findConsentTrailByContact };
```

That is the final export list of this file. Nothing after this task removes a name from it.

- [ ] **Step 11: Run the tests and watch them pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/trailread.test.js`

Expected: PASS - 13 tests.

- [ ] **Step 12: Commit**

```bash
git add src/services/consentTrail.js test/trailread.test.js
git commit -m "feat(trail): resolve a verified contact detail to a whole trail"
```

---

### Task 6: The principal's own trail route, and recording the contact-mismatch refusal

**Files:**
- Modify: `src/http/router.js` - seven blocks. The line numbers below are for the file as it stands on `main`; Task 3 runs earlier and inserts roughly a dozen lines above every one of these sites, so locate each block by the anchor text quoted in its step rather than by number.
  - `:14-15` - add the `consentTrail` require
  - `:243-252` - the `noStore` docstring
  - `:259-279` - `assertOwnContact`
  - its call site, the line `assertOwnContact(principal, readPii(req.body));`
  - the route-registration site: the closing `);` of the `router.get("/consent", ...)` registration, the one immediately above the `// Data principal rights - Chapter III` banner
  - the `withdrawConsent({` call inside the `withdraw` handler
  - the `escalateToBoard({` call inside `router.post("/grievance/:refId/escalate", ...)`
- Test: `test/readpath.test.js` (append two tests at the end of the file)
- Test: `test/auth.test.js` (append four tests at the end of the file)

**Implements:** spec section 8.5 (the principal's own trail, `GET /consent/trail`, operator refs withheld); the `contact_mismatch_refused` / `not_own_contact` row from section 6's kind table and section 4's "Stored in the trail" table ("The `assertOwnContact` 403 - throw only"); and the attribution rule at the two remaining principal-facing router call sites Task 4 gave an `actor` parameter but no task wires - `withdrawConsent` and `escalateToBoard`.

**Interfaces:**
- Consumes (from Task 2, `src/services/consentTrail.js`):
  - `async function recordTrail(models, entry)` -> `Promise<void>`; fail-open, never throws
  - `const COVERAGE_FROM = "2026-09-04"` - returned as `coverageFrom`
- Consumes (from Task 5, appended to that same `src/services/consentTrail.js`):
  - `async function getConsentTrail({ models, principalId, limit = 500, includeOperatorRefs = false })` -> `Promise<{ principalId, docRef, coverageFrom, timeline, truncated, totalEntries }>`
- Consumes (from Task 3, at `src/http/router.js` module scope): `const principalActor = (req) => ({ role: "principal", channel: wantsHtml(req) ? "html" : "api" });` - every actor this task passes is built with it, and no site here re-inlines that object literal.
- Consumes (from Task 4, service signatures): `withdrawConsent({ models, principalId, consentTypes, onWithdrawal, actor })` and `escalateToBoard({ models, refId, principalId, actor })`. `actor` is optional on both and defaults to `UNATTRIBUTED`, which is exactly the wrong answer for a request that arrived with a session - hence Step 13.
- Consumes (from Task 1, tests only): `models.TrailEntry`, the model registered on `buildModels(conn)`
- Produces:
  - `GET /consent/trail` on `createRouter`'s router: `requireAuth`, `noStore`, `wrap`, 200 with the `getConsentTrail` object
  - `function ownContactMismatch(principal, pii)` -> `string[] | null` - module-private to `router.js`, replacing `assertOwnContact`. No later task consumes it.

---

- [ ] **Step 1: Write the failing test for `GET /consent/trail`**

Append to the END of `/Users/sandeep/Workspace/datsogood/dpdp-data-fiduciary-toolkit/data-fiduciary-toolkit/test/readpath.test.js`. `bootApp` is already defined in that file (around line 116) and function declarations hoist, so no new helper is needed. `recordTrail` and `getConsentTrail` are required inside the first test body, which is the idiom already used at `test/auth.test.js:79`.

```js
// ---------------------------------------------------------------------------
// GET /consent/trail - the Section 11 lineage view
// ---------------------------------------------------------------------------

test("GET /consent/trail returns the session principal's own lineage, uncacheable, with operator refs withheld", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { recordTrail, getConsentTrail } = require("../src/services/consentTrail");
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    // A back-office read of this principal's record, written BEFORE the
    // request. Without it this principal has only just signed up, the timeline
    // holds nothing but derived ledger entries, and NOTHING IN IT COULD CARRY
    // an actor.ref or a caseRef - so every withholding assertion below would
    // pass without the withholding ever running. This row is the only entry in
    // the fixture that has something to withhold.
    await recordTrail(models, {
      principalId,
      kind: "operator_trail_read",
      outcome: "recorded",
      actor: { role: "operator", ref: "emp-10432", channel: "api" },
      caseRef: "INC-0042199",
    });

    const asPrincipal = await bootApp(conn, principalId);
    try {
      const res = await asPrincipal.call("GET", "/consent/trail");
      assert.equal(res.status, 200);
      assert.equal(
        res.headers.get("cache-control"), "no-store",
        "the trail names every act taken about one person - a shared cache or CDN must never be told it may store it"
      );
      assert.equal(
        res.headers.get("vary"), "Cookie",
        "the URL carries no identifying component - only the session cookie distinguishes one principal's trail from another's"
      );

      const body = await res.json();
      assert.equal(body.principalId, principalId);
      assert.equal(
        body.coverageFrom, "2026-09-04",
        "a trail with nothing in it must say we were not recording before this date, never imply nothing happened"
      );
      assert.equal(body.truncated, false);
      assert.equal(typeof body.totalEntries, "number");
      assert.ok(Array.isArray(body.timeline));
      assert.ok(body.timeline.length > 0, "signing up is itself lineage - a fresh principal's trail is not empty");

      for (const entry of body.timeline) {
        assert.ok(entry.at, "every timeline entry carries an observed timestamp, stored or derived");
        assert.ok(entry.kind, "every timeline entry names what happened");
        assert.ok(
          entry.source === "stored" || entry.source === "derived",
          "a consumer must be able to tell a recorded fact from a derived one without branching on shape"
        );
        assert.ok(entry.actor && entry.actor.role && entry.actor.channel);
        assert.equal(
          entry.actor.ref, undefined,
          "a data principal may learn that a member of staff read their record, never which one - actor.ref is the adopter's own employee's personal data, held under a different basis"
        );
        assert.equal(
          entry.caseRef, undefined,
          "the adopter's own ticket reference is back-office data and is never rendered back to a data principal"
        );
      }

      // The row that makes the loop above mean something. It must be PRESENT -
      // withholding is not the same as hiding, and that a member of staff read
      // their record is precisely what a data principal is owed under Section
      // 11 - and it must arrive stripped.
      const looked = body.timeline.find((e) => e.kind === "operator_trail_read");
      assert.ok(
        looked,
        "the back-office access row is included, not filtered out - the headline of this feature is that a person can see they were looked at"
      );
      assert.equal(looked.source, "stored");
      assert.deepEqual(
        looked.actor, { role: "operator", channel: "api" },
        "role and channel survive, ref does not - the principal learns that staff read the record, never which member of staff"
      );
      assert.equal(Object.hasOwn(looked.actor, "ref"), false, "absent, not null - a null ref is still a field where an employee's id used to be");
      assert.equal(Object.hasOwn(looked, "caseRef"), false, "the ticket reference never leaves the back office");
    } finally {
      await asPrincipal.close();
    }

    // The inverse, so the two assertions above cannot pass because the read
    // simply never carried either field. The same row, read the way the back
    // office reads it, has both.
    const backOffice = await getConsentTrail({ models, principalId, includeOperatorRefs: true });
    const seen = backOffice.timeline.find((e) => e.kind === "operator_trail_read");
    assert.deepEqual(
      seen.actor, { role: "operator", ref: "emp-10432", channel: "api" },
      "includeOperatorRefs: true is the whole difference between the two reads - if this is stripped too, the route above is withholding nothing"
    );
    assert.equal(
      seen.caseRef, "INC-0042199",
      "who and why together is what makes an access record accountability rather than a counter"
    );
  });
});

test("GET /consent/trail is scoped to the session - a principalId in the query string is ignored", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId: a } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const { principalId: b } = await persistPIIwithconsent({
      models,
      pii: { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" },
      consentTypes: ["analytics"],
    });

    let bRefId;
    const asB = await bootApp(conn, b);
    try {
      const filed = await asB.call("POST", "/rights/exercise", { right: "access" });
      assert.equal(filed.status, 201);
      ({ refId: bRefId } = await filed.json());
    } finally {
      await asB.close();
    }

    const asA = await bootApp(conn, a);
    try {
      const res = await asA.call("GET", `/consent/trail?principalId=${b}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.principalId, a, "the query string must never override the authenticated session");
      assert.equal(
        body.timeline.some((e) => e.refId === bRefId), false,
        "another principal's rights request must not appear in this trail - the scope is req.principalId and nothing else"
      );
    } finally {
      await asA.close();
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/readpath.test.js`

Expected: FAIL. The path is unregistered, so Express falls through to its default 404 handler:

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

404 !== 200
```

- [ ] **Step 3: Add the `consentTrail` require to `router.js`**

At `src/http/router.js:14`, immediately after the `listConsentManagerRequests` line and before the `./forms` require.

Before:

```js
const consentManagerRequest = require("../services/consentManagerRequest");
const { listConsentManagerRequests } = consentManagerRequest;
const {
  escapeHtml,
```

After:

```js
const consentManagerRequest = require("../services/consentManagerRequest");
const { listConsentManagerRequests } = consentManagerRequest;
const { getConsentTrail, recordTrail } = require("../services/consentTrail");
const {
  escapeHtml,
```

If an earlier task already added `require("../services/consentTrail")` to this file, add only the missing name to that existing destructure rather than writing a second require line.

- [ ] **Step 4: Register `GET /consent/trail`**

Located by anchor, not by line number - Task 3 has already inserted above this point. Find the `router.get(` registration whose first argument is the literal `"/consent"`, the one whose handler body is

```js
      const result = await getConsentState({ models, principalId: req.principalId });
```

and insert directly after its closing `);`, so that the new block sits between that `);` and the

```js
  // ---------------------------------------------------------------------------
  // Data principal rights - Chapter III
```

banner that follows it.

Registration order is safe: every `/consent...` route in this file is a literal path and there is no `:param` sibling under `/consent`, so `GET /consent` cannot shadow `GET /consent/trail`. Do not add a `?limit=` query parameter - `getConsentTrail` defaults to 500 and nothing asked for a caller-tunable bound.

```js
  /**
   * The Section 11 lineage view, and the headline of the audit-trail feature.
   * Merges what the toolkit recorded about this principal with the events it
   * can derive from the primary collections, newest first. Scoped to
   * req.principalId only, so this can never read another principal's trail.
   *
   * includeOperatorRefs: false withholds actor.ref and caseRef. This read
   * deliberately DOES include the back-office access rows, so a data principal
   * can see that their record was looked at - but who looked is the adopter's
   * own employee's personal data, retained under the adopter's employment
   * basis, and the ticket reference is the adopter's internal case data.
   * Neither is the data principal's to receive.
   *
   * The read itself is not recorded. Logging a principal's own access would
   * make the right of access a write path and change its cost profile.
   */
  router.get(
    "/consent/trail",
    requireAuth,
    noStore,
    wrap(async (req, res) => {
      const result = await getConsentTrail({
        models,
        principalId: req.principalId,
        includeOperatorRefs: false,
      });
      res.status(200).json(result);
    })
  );
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/readpath.test.js`

Expected: PASS - 13 tests, including the two new ones.

- [ ] **Step 6: Write the failing test for the recorded contact-mismatch refusal**

Append to the END of `/Users/sandeep/Workspace/datsogood/dpdp-data-fiduciary-toolkit/data-fiduciary-toolkit/test/auth.test.js`. The `app` helper is defined at the top of that file and forwards every option to `createRouter`. `persistPIIwithconsent` is required inside the test body, which is the idiom already used at `test/auth.test.js:79`.

Both tests filter `TrailEntry` by `kind`, never by an empty filter, so they cannot be perturbed by rows other instrumentation tasks write on the same request.

```js
// ---------------------------------------------------------------------------
// The assertOwnContact 403, recorded
//
// The refusal used to be a throw and nothing else. It is the C1 attack made by
// someone who already has an account, and until now it left no trace anywhere.
// ---------------------------------------------------------------------------

test("a PUT /consent naming another principal's email is still refused 403, and the refusal is recorded", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
    const { principalId: asha } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const { principalId: bhim } = await persistPIIwithconsent({
      models,
      pii: { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" },
      consentTypes: ["analytics"],
    });

    const { call, close } = await app(conn, { resolvePrincipal: () => bhim });
    try {
      const attack = await call("PUT", "/consent", {
        pii: { name: "Bhim", email: "asha@example.com", phone: "9000000000", dob: "1985-02-02" },
        consentTypes: [],
      });
      assert.equal(
        attack.status, 403,
        "the mismatch check must stay synchronous - an unawaited async check returns a truthy promise that never throws, so the 403 would silently stop happening and the write would land on the victim"
      );
    } finally {
      await close();
    }

    const rows = await models.TrailEntry.find({ kind: "contact_mismatch_refused" }).lean();
    assert.equal(rows.length, 1, "one refused attempt, one row - the throw must not skip the write that precedes it");
    assert.equal(
      rows[0].principalId, bhim,
      "the row is filed against the account that made the attempt, never against the person it targeted - filing it under the victim would let an attacker append to someone else's trail"
    );
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].reasonCode, "not_own_contact");
    assert.equal(rows[0].actor.role, "principal");
    assert.equal(rows[0].actor.channel, "api");
    assert.equal(rows[0].count, 1, "exactly one contact field mismatched - the email");
    assert.equal(rows[0].actor.ref, undefined, "actor.ref is set only for an operator");
    assert.equal(
      JSON.stringify(rows[0]).includes("asha@example.com"), false,
      "the trail stores no contact detail, so a refusal can never become a record of which address was targeted"
    );

    const victim = await models.Principal.findOne({ principalId: asha }).lean();
    assert.equal(victim.pii.name, "Asha", "the victim's PII must be untouched");
  });
});

test("the contact-mismatch refusal records the channel the data principal was actually on", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
    await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const { principalId: bhim } = await persistPIIwithconsent({
      models,
      pii: { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" },
      consentTypes: ["analytics"],
    });

    const { call, close } = await app(conn, { resolvePrincipal: () => bhim });
    try {
      const attack = await call(
        "PUT",
        "/consent",
        {
          pii: { name: "Bhim", email: "asha@example.com", phone: "9000000000", dob: "1985-02-02" },
          consentTypes: [],
        },
        { Accept: "text/html" }
      );
      assert.equal(attack.status, 403);
      assert.match(attack.headers.get("content-type"), /text\/html/, "a browser is answered the reason as a page");
    } finally {
      await close();
    }

    const rows = await models.TrailEntry.find({ kind: "contact_mismatch_refused" }).lean();
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].actor.channel, "html",
      "the actor's channel is the one the request negotiated, so a form submission and an API call are distinguishable in the record"
    );
  });
});
```

- [ ] **Step 7: Run the test and watch it fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/auth.test.js`

Expected: FAIL on both new tests. The 403 still happens (the existing `assertOwnContact` throws), but nothing is written:

```
AssertionError [ERR_ASSERTION]: one refused attempt, one row - the throw must not skip the write that precedes it

0 !== 1
```

- [ ] **Step 8: Replace `assertOwnContact` with `ownContactMismatch`**

Replace `src/http/router.js:259-279` in full.

Before:

```js
  /**
   * Refuses contact details that are not the signed-in principal's own.
   *
   * persistPIIwithconsent resolves a principal through findOrCreatePrincipal,
   * i.e. by contact hash. Passing a caller-supplied email into it would let any
   * authenticated principal overwrite a DIFFERENT person's PII and ledger - C1
   * again, merely requiring an account. Comparing against the session
   * principal's own stored hash refuses that without a lookup, so it also adds
   * no way to probe which addresses are registered.
   */
  function assertOwnContact(principal, pii) {
    const mismatch =
      (pii.email && lookupHash(pii.email) !== principal.emailHash) ||
      (pii.phone && lookupHash(pii.phone) !== principal.phoneHash);
    if (mismatch) {
      throw new AppError(
        "The contact details supplied do not belong to the signed-in data principal. Use the correction route to change them.",
        403
      );
    }
  }
```

After:

```js
  /**
   * The contact fields supplied that are NOT the signed-in principal's own, or
   * null when everything matches.
   *
   * persistPIIwithconsent resolves a principal through findOrCreatePrincipal,
   * i.e. by contact hash. Passing a caller-supplied email into it would let any
   * authenticated principal overwrite a DIFFERENT person's PII and ledger - C1
   * again, merely requiring an account. Comparing against the session
   * principal's own stored hash refuses that without a lookup, so it also adds
   * no way to probe which addresses are registered.
   *
   * It returns rather than throwing, and is named for what it returns, because
   * the refusal now also writes a trail entry and that write is asynchronous.
   * Making an assert-named helper async would leave a synchronous call site
   * calling it without await, and a returned promise is truthy but never
   * throws: the 403 would silently stop happening, the write would land on the
   * victim, and the unhandled rejection would take the process down on every
   * mismatched request. Keeping the check synchronous and moving both the
   * write and the throw into the async handler makes that mistake unavailable.
   */
  function ownContactMismatch(principal, pii) {
    const fields = [];
    if (pii.email && lookupHash(pii.email) !== principal.emailHash) fields.push("email");
    if (pii.phone && lookupHash(pii.phone) !== principal.phoneHash) fields.push("phone");
    return fields.length ? fields : null;
  }
```

- [ ] **Step 9: Update the call site in `PUT /consent`**

Located by anchor, not by line number. The site is the single line

```js
      assertOwnContact(principal, readPii(req.body));
```

inside the `router.put("/consent", ...)` handler - it is the only occurrence of that text in the file.

Before:

```js
      assertOwnContact(principal, readPii(req.body));
```

After:

```js
      const mismatched = ownContactMismatch(principal, readPii(req.body));
      if (mismatched) {
        // Awaited, and before the throw. recordTrail is fail-open and never
        // rejects, so this cannot turn a 403 the caller needs to read into a
        // 500. Only the NUMBER of mismatched fields is stored: the trail holds
        // no contact detail, and which field it was does not make the refusal
        // any more accountable.
        await recordTrail(models, {
          principalId: req.principalId,
          kind: "contact_mismatch_refused",
          outcome: "refused",
          reasonCode: "not_own_contact",
          // principalActor is already at module scope - Task 3 put it there
          // for exactly this. Re-inlining the object literal would give this
          // file two definitions of what a principal actor is, and the one
          // that drifted would be whichever a later reader did not open.
          actor: principalActor(req),
          count: mismatched.length,
        });
        throw new AppError(
          "The contact details supplied do not belong to the signed-in data principal. Use the correction route to change them.",
          403
        );
      }
```

- [ ] **Step 10: Run the test and watch it pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/auth.test.js`

Expected: PASS - 20 tests. `PUT /consent updates the session principal, and cannot reach another principal by email` (`test/auth.test.js:236`) must still pass: the 403 status and the `AppError` message are byte-identical to before.

- [ ] **Step 11: Write the failing tests for the two unattributed router call sites**

Task 4 gives `withdrawConsent` and `escalateToBoard` an optional `actor`, defaulting to `UNATTRIBUTED`. Task 3 wires the two consent call sites. Nobody wires these two, so every refused withdrawal and every refused escalation that arrived over HTTP - with a session, from a real person, on a known surface - is filed as `{ role: "unattributed", channel: "library" }`: the trail says the library did it to itself. These are the last two principal-facing sites in the router with a service-level `actor` parameter.

Append to the END of `/Users/sandeep/Workspace/datsogood/dpdp-data-fiduciary-toolkit/data-fiduciary-toolkit/test/auth.test.js`, after the two tests added in Step 6.

```js
// ---------------------------------------------------------------------------
// The two router call sites that had an actor parameter and no actor
//
// Both branches under test save nothing: withdrawConsent skips save() when
// nothing changed, and escalateToBoard's SLA guard throws before it touches
// the grievance. The trail row is the whole record, so an `unattributed` one
// is a record of nobody having done nothing.
// ---------------------------------------------------------------------------

test("a withdrawal refused through the ROUTE is attributed to the data principal and to the surface they used", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    const { call, close } = await app(conn, { resolvePrincipal: () => principalId });
    try {
      // kyc_reporting rests on Section 7(d), not on consent, so the service
      // refuses it and skips the ledger write entirely. Accept: text/html so
      // the channel asserted below is one the request actually negotiated -
      // a hardcoded actor could not produce it.
      const res = await call(
        "PUT",
        "/consent/withdraw",
        { consentTypes: ["kyc_reporting"] },
        { Accept: "text/html" }
      );
      assert.equal(res.status, 200, "a purpose that cannot be withdrawn is reported in the receipt, not as an error status");
    } finally {
      await close();
    }

    const rows = await models.TrailEntry.find({ kind: "withdrawal_not_applied" }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reasonCode, "not_withdrawable");
    assert.equal(rows[0].principalId, principalId);
    assert.equal(
      rows[0].actor.role, "principal",
      "the request carried a session, so `unattributed` here means the route never passed the actor the service was given a parameter for"
    );
    assert.equal(
      rows[0].actor.channel, "html",
      "html, not library - the channel is negotiated per request, so this can only pass if principalActor(req) reached the service"
    );
  });
});

test("an escalation refused through the ROUTE names the person who was stopped from reaching the Board", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    const { call, close } = await app(conn, { resolvePrincipal: () => principalId });
    try {
      const filed = await call("POST", "/grievance", {
        subject: "No answer",
        description: "I asked twice and heard nothing.",
      });
      assert.equal(filed.status, 201);
      const { refId } = await filed.json();

      // Filed a moment ago, so the Grievance Officer's SLA has not lapsed and
      // escalateToBoard refuses. That branch saves nothing at all - the 409
      // and this row are its entire output.
      const res = await call("POST", `/grievance/${refId}/escalate`, {});
      assert.equal(res.status, 409, "setup check - the SLA guard must actually have refused");
    } finally {
      await close();
    }

    const rows = await models.TrailEntry.find({ kind: "escalation_refused" }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reasonCode, "sla_not_lapsed");
    assert.equal(rows[0].principalId, principalId);
    assert.equal(
      rows[0].actor.role, "principal",
      "a data principal was turned back from the Board - a row saying `unattributed` answers nobody's question about who was turned back"
    );
    assert.equal(rows[0].actor.channel, "api");
  });
});
```

- [ ] **Step 12: Run the tests and watch them fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/auth.test.js`

Expected: FAIL on both new tests. The rows exist - Task 4 writes them - but they are filed against nobody:

```
AssertionError [ERR_ASSERTION]: the request carried a session, so `unattributed` here means the route never passed the actor the service was given a parameter for

'unattributed' !== 'principal'
```

- [ ] **Step 13: Pass `principalActor(req)` at both call sites**

Two edits in `src/http/router.js`, both located by anchor rather than by line number.

**Edit A** - the `withdrawConsent` call inside the `withdraw` handler. It is the only `await withdrawConsent({` in the file.

Before:

```js
    const result = await withdrawConsent({
      models,
      principalId: req.principalId,
      consentTypes: asArray(req.body.consentTypes),
      onWithdrawal,
    });
```

After:

```js
    const result = await withdrawConsent({
      models,
      principalId: req.principalId,
      consentTypes: asArray(req.body.consentTypes),
      onWithdrawal,
      // The service defaults to UNATTRIBUTED, which is the honest answer for a
      // direct library call and the wrong one here: this request arrived with a
      // session, on a surface we can name. Same helper as every other
      // principal-facing site in this file.
      actor: principalActor(req),
    });
```

**Edit B** - the `escalateToBoard` call inside `router.post("/grievance/:refId/escalate", ...)`. It is the only `await escalateToBoard({` in the file.

Before:

```js
      const result = await escalateToBoard({
        models,
        refId: req.params.refId,
        principalId: req.principalId,
      });
```

After:

```js
      const result = await escalateToBoard({
        models,
        refId: req.params.refId,
        principalId: req.principalId,
        actor: principalActor(req),
      });
```

Nothing else changes at either site. `actor` is used by the trail write only - no status code, no message and no returned object depends on it, which is why the pre-existing withdrawal and escalation tests are untouched by this step.

- [ ] **Step 14: Run the tests and watch them pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/auth.test.js`

Expected: PASS - 22 tests.

- [ ] **Step 15: Fix the drifted `noStore` docstring**

`src/http/router.js:243-252` says "These six routes" and the code already carried seven; this task makes it eight. Replace the count with a statement that cannot drift.

Before:

```js
  /**
   * These six routes are the first cacheable responses in the toolkit that
   * carry personal data - every pre-existing PII route is POST or PUT, and
   * neither is cacheable by default. GET /consent in particular returns
   * name, email, phone, dob, PAN and address on a URL with no
   * user-identifying component, distinguished only by the host's session
   * cookie: a shared cache or CDN in front of the host, or a browser's disk
   * or back-forward cache on a shared machine, could otherwise serve one
   * principal's response to the next.
   */
```

After:

```js
  /**
   * Applied to every GET below that returns principal-identifying data. These
   * are the first cacheable responses in the toolkit that carry personal data
   * - every pre-existing PII route is POST or PUT, and neither is cacheable by
   * default. GET /consent in particular returns name, email, phone, dob, PAN
   * and address on a URL with no user-identifying component, distinguished
   * only by the host's session cookie: a shared cache or CDN in front of the
   * host, or a browser's disk or back-forward cache on a shared machine, could
   * otherwise serve one principal's response to the next. GET /consent/trail
   * is worse still: it is the whole lineage of one person on the same
   * undistinguished URL.
   *
   * The number of routes is deliberately not stated. It said "six" while the
   * code had seven, and a count in a comment drifts every time a read route is
   * added.
   */
```

- [ ] **Step 16: Run the whole suite**

Run: `npm test`

Expected: all existing tests still pass, plus the six added here. No existing test needs updating:
- `test/auth.test.js:236` asserts the mismatch is `403` and the victim's ledger is byte-identical - both unchanged.
- `test/readpath.test.js:270` asserts `?principalId=` is ignored on `GET /consent` - untouched.
- `test/children.test.js:83`/`:113` count `ConsentRecord` documents, not `TrailEntry`, so a new collection is invisible to them.
- `test/http.test.js:393` asserts a GET is never blocked by the origin check - `GET /consent/trail` inherits that unchanged.
- The pre-existing withdrawal and escalation tests are unaffected by Step 13: `actor` reaches the trail write and nothing else, so no status code, message or returned object moves.

- [ ] **Step 17: Commit**

```bash
git add src/http/router.js test/readpath.test.js test/auth.test.js
git commit -m "feat(http): serve the principal's own consent trail, record contact-mismatch refusals, and attribute refused withdrawals and escalations"
```

---

---

### Task 7: Extract `src/http/shared.js`

**Files:**
- Create: `src/http/shared.js`
- Modify: `src/http/router.js` - four blocks: the module-scope `wrap`, the `originHost` + `checkOrigin` pair, the `router.use(checkOrigin)` registration, and the inline error mapper. **No step below cites a line number in this file, deliberately.** Tasks 3 and 6 both edit `router.js` before this task runs - a `consentTrail` require at the top, the `principalActor` helper above `wrap`, a longer `noStore` docstring, `ownContactMismatch` in place of `assertOwnContact`, a fifteen-line call site in place of a one-line one, and the whole `GET /consent/trail` route - and every one of those insertions sits above at least one of these four blocks. Locate each block by the anchor text quoted in its step.
- Test: `test/http.test.js` (append one test at the end of the file)

**Implements:** spec section 8.4 - "plus `src/http/shared.js` extracting `{ errorMapper, wrap, makeCheckOrigin }` from `router.js` - one shared file, not two, because duplicating a security check across two routers is worse than sharing it."

This is a pure refactor. No route's behaviour changes, no status code changes, no message changes. The whole point of the task is that the pre-existing suite stays green.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces - `src/http/shared.js`:
  - `module.exports = { wrap, errorMapper, makeCheckOrigin };`
  - `const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);`
  - `function errorMapper(err, req, res, _next)` - the existing three-branch mapper, unchanged. **Four declared parameters.** Express identifies an error handler by `fn.length === 4`; declaring three would silently register it as ordinary middleware and every error would fall through to Express's default HTML 500.
  - `function makeCheckOrigin(allowedOrigins)` -> `(req, res, next) => void` - a factory because the check closes over `allowedOrigins`, and the two routers this library ships are configured separately.

---

- [ ] **Step 1: Write the failing test for `shared.js`'s contract**

Append to the END of `/Users/sandeep/Workspace/datsogood/dpdp-data-fiduciary-toolkit/data-fiduciary-toolkit/test/http.test.js`. This is a pure unit test with no database and no server, so it uses neither `withDb` nor `boot`. The `require` is inside the test body, the idiom already used at `test/auth.test.js:79`.

```js
// ---------------------------------------------------------------------------
// src/http/shared.js - the three pieces both routers need
//
// The origin check is a security control, and a security control duplicated
// across two routers drifts. These assertions pin the extracted contract; the
// seven origin tests above pin the behaviour end to end through a real server.
// ---------------------------------------------------------------------------

test("shared.js exports wrap, errorMapper and makeCheckOrigin, and errorMapper keeps Express's four-argument arity", () => {
  const { wrap, errorMapper, makeCheckOrigin } = require("../src/http/shared");

  assert.equal(typeof wrap, "function");
  assert.equal(typeof errorMapper, "function");
  assert.equal(typeof makeCheckOrigin, "function");
  assert.equal(
    errorMapper.length, 4,
    "Express decides a function is an error handler by its arity alone - a three-parameter mapper is registered as ordinary middleware, never runs, and every fault falls through to Express's default HTML 500 with no warning of any kind"
  );
  assert.equal(makeCheckOrigin([]).length, 3, "the built middleware takes (req, res, next)");
});

test("makeCheckOrigin closes over the origins it was built with, and lets GET through", () => {
  const { makeCheckOrigin } = require("../src/http/shared");

  // Minimal Express stand-ins. checkOrigin reads only req.method, req.get and
  // res.status().json(), so a real server is not needed to pin the branches.
  const req = (method, origin, host = "app.example") => {
    const headers = { host };
    if (origin !== undefined) headers.origin = origin;
    return { method, get: (name) => headers[name.toLowerCase()] };
  };
  const run = (mw, r) => {
    const out = {};
    const res = {
      status(code) { out.status = code; return this; },
      json(body) { out.body = body; return this; },
    };
    mw(r, res, () => { out.nexted = true; });
    return out;
  };

  const mw = makeCheckOrigin(["https://portal.example"]);

  assert.equal(run(mw, req("GET", "https://evil.example")).nexted, true, "GET is exempt - it changes no state");
  assert.equal(run(mw, req("POST", undefined)).nexted, true, "curl sends no Origin and no Referer, and is not the threat");
  assert.equal(run(mw, req("POST", "https://app.example")).nexted, true, "the request's own host is always allowed");
  assert.equal(run(mw, req("POST", "https://portal.example")).nexted, true, "a configured origin is a union with the own host, never a replacement");

  const refused = run(mw, req("POST", "https://evil.example"));
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: "cross-origin request refused" });

  const unparseable = run(mw, req("POST", "null"));
  assert.equal(unparseable.status, 403, "the literal string null is evidence of a cross-origin or sandboxed context");
  assert.deepEqual(unparseable.body, { error: "bad origin" });

  const other = makeCheckOrigin([]);
  assert.equal(
    run(other, req("POST", "https://portal.example")).status, 403,
    "each built middleware carries its own allowlist - a second router must not inherit the first's"
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/http.test.js`

Expected: FAIL on both new tests, the file does not exist yet:

```
Error: Cannot find module '../src/http/shared'
```

- [ ] **Step 3: Create `src/http/shared.js`**

Every docstring and every line of logic below is moved verbatim from `router.js`. The only edits are the wrapper around `checkOrigin` and the two paragraphs marked as new.

```js
const { escapeHtml } = require("./forms");
const { wantsHtml } = require("./negotiate");

/** Wraps an async handler so a rejection reaches the error mapper below. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * The host of an origin, or null if there isn't one.
 *
 * Returning null for an EMPTY host matters as much as returning null for an
 * unparseable one. `new URL("localhost:3000")` does not throw - it reads
 * "localhost" as a scheme and yields host "" - and so do "file://" and
 * "about:blank". Letting "" through would mean a scheme-less config entry
 * silently never matched anything, while any Origin that also parsed to ""
 * matched it. Both sides collapse "" to null so neither can happen.
 */
function originHost(value) {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/**
 * Builds the same-origin check on state-changing requests for one router.
 *
 * A factory rather than a plain middleware because the check closes over
 * allowedOrigins, and the two routers this library ships are configured
 * separately. It lives here rather than in either router because a security
 * control duplicated across two files drifts, and the half that drifts is the
 * half nobody is looking at.
 *
 * The original audit refuted a CSRF finding, and correctly: with no ambient
 * credential, a cross-site POST conferred nothing an attacker could not
 * already do with curl. resolvePrincipal changed that. Hosts back it with a
 * cookie session, and POST /consent/withdraw exists precisely so an HTML
 * form can reach it - so a cross-site form POST now rides that cookie, and
 * a forged withdrawal writes to an append-only ledger that cannot be undone.
 *
 * Not a substitute for CSRF tokens, which this library cannot issue - it has
 * no session store, by design, which is the whole point of the injected
 * hook. But the Fetch specification requires a browser to send Origin on
 * every request whose method is not GET or HEAD, so rejecting a mismatched
 * one closes the drive-by case. The absence of BOTH headers is treated as
 * same-origin because non-browser clients (curl, server-to-server) send
 * neither and are not the threat here; a browser cannot reach that branch.
 * Absence is tested as `undefined`, not falsiness, so a present-but-empty
 * `Origin:` is refused rather than read as "no origin at all".
 *
 * A referrer policy can reduce Origin to the literal string "null" rather
 * than remove it. That parses as neither a URL nor a host, so it lands in
 * the 403 below - which is right: "null" is evidence of a cross-origin or
 * sandboxed context, not of a same-origin one.
 *
 * Only the host is compared, not the scheme: req.get("host") carries no
 * scheme, and deriving one from req.protocol would depend on the host's
 * trust-proxy setting, which this library does not control.
 *
 * Hosts must still set SameSite=Lax or Strict on their session cookie -
 * see the README. This alone is not enough.
 */
function makeCheckOrigin(allowedOrigins) {
  return function checkOrigin(req, res, next) {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const fromOrigin = req.get("origin");
    const origin = fromOrigin !== undefined ? fromOrigin : req.get("referer");
    if (origin === undefined) return next();

    const host = originHost(origin);
    if (!host) return res.status(403).json({ error: "bad origin" });

    // UNION, not replace. Configuring one partner origin must not stop your own
    // forms working - that footgun fails closed in a way an operator would only
    // discover in production, on the withdrawal route, which is the one route a
    // data principal most needs to reach.
    //
    // `originHost(o) || o` is what lets a scheme-less entry ("portal.example",
    // "localhost:3000") be written the way an operator naturally writes it: the
    // parse yields no host, so the raw string is compared against req.get("host"),
    // which carries no scheme either.
    const allowed = host === req.get("host") || allowedOrigins.some((o) => (originHost(o) || o) === host);
    if (!allowed) return res.status(403).json({ error: "cross-origin request refused" });
    next();
  };
}

/**
 * One error mapper, shared by every router this library builds and registered
 * LAST on each. Replaces the six per-route catch blocks that turned every
 * fault into 400 with a raw internal message.
 *
 * The fourth parameter is load-bearing even though it is unused: Express
 * decides a function is an error handler by its arity alone. Drop it and this
 * registers as ordinary middleware, never runs, and every fault falls through
 * to Express's default handler - which returns HTML and, outside production,
 * the stack trace this function exists to withhold.
 */
function errorMapper(err, req, res, _next) {
  // Branch order matters, and each branch closes a specific hole.

  // Mongoose input faults are the CLIENT's fault. CastError included: sending
  // pii.pan as an object or a malformed date produces one, and reporting that
  // as 500 would repeat the bug in the opposite direction. Send the field
  // name, not mongoose's raw text - that text quotes the offending value back.
  if (err && (err.name === "ValidationError" || err.name === "CastError")) {
    const fields = err.errors ? Object.keys(err.errors).join(", ") : err.path;
    const message = `Invalid value for: ${fields}`;
    if (wantsHtml(req)) return res.status(400).type("html").send(`<p>${escapeHtml(message)}</p>`);
    return res.status(400).json({ error: message });
  }

  // A deliberate AppError below 500 is safe to echo - the message is written
  // for the caller. At or above 500 it is NOT: AppError(..., 500) carries
  // internal configuration detail (utils/principalId.js throws one naming
  // PRINCIPAL_ID_SECRET and how to generate it, and that path is reachable
  // from the unauthenticated POST /consent route).
  //
  // A browser gets the same message rendered as HTML rather than a JSON
  // body - a data principal filling in the consent form has no way to read
  // JSON. This is also the answer a minor rejected for want of verifiable
  // parental consent (422, see persistPIIwithconsent) actually sees: the
  // stated reason, not a raw status code they cannot act on.
  if (err && typeof err.status === "number" && err.status < 500) {
    if (wantsHtml(req)) return res.status(err.status).type("html").send(`<p>${escapeHtml(err.message)}</p>`);
    return res.status(err.status).json({ error: err.message });
  }

  console.error("[dpdp-toolkit] unhandled error:", err);
  const status = err && typeof err.status === "number" ? err.status : 500;
  // Same content negotiation as the two branches above, which this branch
  // alone was missing - so a browser user filling in the consent form got a
  // raw JSON body with Content-Type: application/json, on the one branch a
  // misconfigured deployment actually lands them on. The MESSAGE is still
  // withheld for the reason given above; only the rendering changes.
  if (wantsHtml(req)) {
    return res.status(status).type("html").send("<p>Something went wrong at our end. Please try again later.</p>");
  }
  res.status(status).json({ error: "internal error" });
}

module.exports = { wrap, errorMapper, makeCheckOrigin };
```

- [ ] **Step 4: Run the new test and watch it pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/http.test.js`

Expected: PASS. `router.js` still has its own private copies at this point, so nothing else has moved yet.

- [ ] **Step 5: Import the three from `shared.js` in `router.js` and delete the local `wrap`**

Two edits.

**Edit A** - add the import immediately after the `./negotiate` require, which is the last line of the require block at the top of the file and the file's only `require("./negotiate")`. `router.js` still needs `escapeHtml` and `wantsHtml` itself, for `sendAuthRequired`, the `principalActor` helper Task 3 added and the HTML route branches, so those requires stay.

Before:

```js
const { wantsHtml } = require("./negotiate");
```

After:

```js
const { wantsHtml } = require("./negotiate");
const { wrap, errorMapper, makeCheckOrigin } = require("./shared");
```

**Edit B** - delete the local `wrap`. It is at module scope, in the run of helpers between `isTrue` and the `createRouter` JSDoc block. Find it by these two lines, which are its only occurrence in the file:

```js
/** Wraps an async handler so a rejection reaches the error mapper below. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
```

Delete exactly those two lines and the blank line that follows them. Nothing else moves: whatever helper precedes them stays where it is and is what ends up directly above the `createRouter` JSDoc block. On `main` that helper is `isTrue`, but Task 3 inserts `principalActor` between `isTrue` and this comment, so by the time this task runs it is `principalActor` - and `principalActor` must survive untouched, because every router task from Task 3 on reuses it rather than re-inlining the object literal.

- [ ] **Step 6: Delete `originHost` and `checkOrigin` from `router.js` and build the middleware from the factory**

Delete the `originHost` and `checkOrigin` pair in full. They are contiguous, the first two things declared inside `createRouter` after `const models = buildModels(db);`, and nothing else in the file declares either name. Delete everything from the line

```js
  /**
   * The host of an origin, or null if there isn't one.
```

down to and including the closing brace of `checkOrigin`:

```js
    if (!allowed) return res.status(403).json({ error: "cross-origin request refused" });
    next();
  }
```

Then change the registration - the first `router.use` in the file, immediately below `const router = express.Router();`, which is now the line that directly follows the deletion above.

Before:

```js
  const router = express.Router();
  // FIRST, ahead of the body parsers and of requireAuth. There is no reason to
  // parse up to 100kb of a request that is about to be refused, and a forged
  // request should never reach the session lookup at all.
  router.use(checkOrigin);
```

After:

```js
  const router = express.Router();
  // FIRST, ahead of the body parsers and of requireAuth. There is no reason to
  // parse up to 100kb of a request that is about to be refused, and a forged
  // request should never reach the session lookup at all.
  router.use(makeCheckOrigin(allowedOrigins));
```

Leave the `allowedOrigins` array check exactly where it is - the `if (!Array.isArray(allowedOrigins) || allowedOrigins.some((o) => typeof o !== "string")) {` guard near the top of `createRouter`, above `assertConfigured()`. It runs before `assertConfigured()`, and moving the validation into `makeCheckOrigin` would move it to after - a change in which boot error an operator sees first, for no gain.

- [ ] **Step 7: Replace the inline error mapper with `router.use(errorMapper)`**

Delete the inline error mapper - the last thing in `createRouter` before `return router;`, and the file's only four-argument `router.use`. That is the banner comment starting

```js
  // ---------------------------------------------------------------------------
  // One error mapper, registered LAST. Replaces the six per-route catch blocks
```

together with the whole `router.use((err, req, res, _next) => { ... });` block below it, down to and including its closing

```js
  });
```

on the line before `return router;`.

Replace it with:

```js
  // ---------------------------------------------------------------------------
  // One error mapper, registered LAST. It lives in ./shared because the
  // back-office router needs the identical three branches, and two copies of an
  // error mapper drift - the half that drifts being the half that decides which
  // internal detail reaches a caller.
  // ---------------------------------------------------------------------------
  router.use(errorMapper);
```

- [ ] **Step 8: Run the three files that protect this refactor**

Run: `node --test --test-global-setup=scripts/test-setup.js test/http.test.js test/auth.test.js test/browser.test.js`

Expected: PASS, all of them. These are the files that cover the three extracted pieces:

- **`test/http.test.js`** - `checkOrigin` end to end, seven tests at `:213`, `:239`, `:260`, `:272`, `:293`, `:335`, `:373`, `:393` (cross-origin refused, same-origin allowed, no Origin at all, literal `"null"`, `allowedOrigins` union, scheme-less entries and the empty parsed host, present-but-empty Origin, GET exempt). The error mapper at `:148` (500 generic, no raw message) and `:190` (validation error still 400 with a useful message). Every `wrap`ped route in the file.
- **`test/auth.test.js`** - the error mapper's other three branches: `:508` (an `AppError` carrying 500 does not echo its message), `:535` (a browser gets HTML on the 5xx branch), `:567` (a mongoose cast failure is a 400 naming the field, not a 500 and not the raw value). Plus `wrap` on every 401 route at `:40`.
- **`test/browser.test.js`** - the HTML branch of the mapper and of every negotiated route.

Note on `test/http.test.js:409-470`: those three boot-guard tests cache-bust `../src/config/catalog` and `../src/http/router` and re-`require` the router. `./shared` is not cache-busted, so it keeps its binding to the previously loaded `forms`/`catalog` pair. That is already true of `./forms` today, which `router.js` requires the same way and which those tests already leave cached, and nothing in `shared.js` reads catalog state - `escapeHtml` and `wantsHtml` are both pure. So the extraction adds no new module instance and those tests are unaffected.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`

Expected: every pre-existing test still passes, plus the two added in Step 1. This step is the actual acceptance criterion for the task: the refactor is only correct if the suite is byte-for-byte as green as it was before it. No test file needs updating - nothing in the suite imports `wrap`, `checkOrigin`, `originHost` or the mapper by name, they were all private to `createRouter`'s closure.

If anything fails, the two likely causes, in order:
1. Every route 500s with an Express default HTML page - `errorMapper` was declared with fewer than four parameters, so Express registered it as ordinary middleware.
2. Every non-GET request is refused 403 or every cross-origin request is admitted - `makeCheckOrigin(allowedOrigins)` was called with the wrong argument, or `router.use(makeCheckOrigin)` was written without invoking the factory.

- [ ] **Step 10: Commit**

```bash
git add src/http/shared.js src/http/router.js test/http.test.js
git commit -m "refactor(http): extract wrap, the error mapper and checkOrigin into src/http/shared.js"
```

---

### Task 8: The back-office router - `createBackOfficeRouter`

**Files:**
- Create: `src/http/backOfficeRouter.js`
- Test: `test/backoffice.test.js`

**Implements:** Spec section 8.4 (the back-office router), the back-office half of 8.2 (disclosure writes fail closed), D3, D4, D7, and the section 5 invariant that no contact hash is ever stored beside a `principalId`. Delivers test-plan cases 7, 8 and 9.

**Interfaces:**
- Consumes, from Task 1 (`src/utils/validate.js`): `assertOpaqueRef(value, field)` - throws `AppError(msg, 400)`, returns the value; and the registered model `models.TrailEntry`.
- Consumes, from Task 2 (`src/services/consentTrail.js`): `async recordTrailStrict(models, entry)` - throws `AppError("...", 503)` if the write fails; and the module constant `COVERAGE_FROM = "2026-09-04"`, which is what `coverageFrom` carries.
- Consumes, from Task 5 (appended to that same `src/services/consentTrail.js`): `async getConsentTrail({ models, principalId, limit = 500, includeOperatorRefs = false })` -> `{ principalId, docRef, coverageFrom, timeline, truncated, totalEntries }`; throws `AppError(..., 400)` on a bad `principalId` or `limit` and `AppError(..., 404)` when the principal is unknown. Task 2 does not export it - Task 5 appends it and rewrites the `module.exports` line to carry it alongside `recordTrailStrict` and `COVERAGE_FROM`.
- Consumes, from Task 7 (`src/http/shared.js`): `module.exports = { wrap, errorMapper, makeCheckOrigin }` - `wrap(fn)` returns an express handler, `errorMapper(err, req, res, next)` is the existing 3-branch mapper, `makeCheckOrigin(allowedOrigins)` returns a middleware.
- Consumes, already in the repo: `buildModels(connection)` (`src/models/index.js`), `assertConfigured()` (`src/config/catalog.js`), `AppError` (`src/utils/errors.js`), `assertPrincipalId(value, field)` and `assertNonEmptyString(value, field, maxLength)` (`src/utils/validate.js`), `findPrincipalByContact({ models, email, phone })` and `findPrincipalById({ models, principalId })` (`src/utils/principalId.js`).
- Produces, for Task 9: `module.exports = createBackOfficeRouter` from `src/http/backOfficeRouter.js`, where
  `createBackOfficeRouter({ db, resolveOperator, rateLimitedByHost, allowedOrigins = [] })` returns an express Router carrying `POST /principals/lookup` and `POST /principals/trail`.

---

- [ ] **Step 1: Write the failing test for the construction guards**

Create `test/backoffice.test.js` with exactly this content. The preamble is copied from `test/readpath.test.js:1-16` - the two `process.env` assignments must sit after the `node:test` / `assert` / `express` / `./helpers/db` requires and **before** any `require("../src/...")`, because `src/config/catalog.js` captures `FIDUCIARY` at module load.

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
const { buildModels } = require("../src/models");
const createRouter = require("../src/http/router");
const createBackOfficeRouter = require("../src/http/backOfficeRouter");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const { lookupHash } = require("../src/utils/principalId");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };
const OPERATOR = { actorRef: "staff-4471" };

/**
 * Mounts the back-office router on an ephemeral port. Options are spread LAST
 * on purpose, so a test can pass `resolveOperator: undefined` and actually get
 * no hook - a default parameter would silently reinstate one, and "fails
 * closed with no hook configured" is one of the things under test.
 */
async function bootBackOffice(conn, opts = {}) {
  const models = buildModels(conn);
  const app = express();
  app.use(
    "/back-office",
    createBackOfficeRouter({ db: conn, rateLimitedByHost: true, resolveOperator: () => OPERATOR, ...opts })
  );
  const server = app.listen(0);
  const port = server.address().port;
  return {
    models,
    call: (path, body) =>
      fetch(`http://localhost:${port}/back-office${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test("the back-office factory refuses to build without an explicit rate-limiting acknowledgement", async () => {
  await withDb(async (conn) => {
    assert.throws(
      () => createBackOfficeRouter({ db: conn, resolveOperator: () => OPERATOR }),
      /express-rate-limit/,
      "this router is a people-search over a guessable keyspace and the package ships no rate limiting, so the acknowledgement is the whole point of the guard"
    );
    for (const bad of [false, "true", 1, null]) {
      assert.throws(
        () => createBackOfficeRouter({ db: conn, resolveOperator: () => OPERATOR, rateLimitedByHost: bad }),
        /rateLimitedByHost/,
        `rateLimitedByHost: ${JSON.stringify(bad)} is not an acknowledgement - only the literal true is`
      );
    }
    assert.equal(
      typeof createBackOfficeRouter({ db: conn, resolveOperator: () => OPERATOR, rateLimitedByHost: true }),
      "function",
      "with the acknowledgement it must build - if this throws, every assertion above is passing for the wrong reason"
    );
  });
});

test("the back-office factory requires a db handle and a string allowedOrigins list, like createRouter", async () => {
  await withDb(async (conn) => {
    assert.throws(
      () => createBackOfficeRouter({ resolveOperator: () => OPERATOR, rateLimitedByHost: true }),
      /db is required/
    );
    assert.throws(
      () => createBackOfficeRouter({ db: conn, resolveOperator: () => OPERATOR, rateLimitedByHost: true, allowedOrigins: [1] }),
      /allowedOrigins/
    );
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/backoffice.test.js`

Expected: FAIL before any test runs, with
`Error: Cannot find module '../src/http/backOfficeRouter'`
`Require stack:` … `test/backoffice.test.js`

- [ ] **Step 3: Create the router file with its construction guards only**

Create `src/http/backOfficeRouter.js`:

```js
const express = require("express");

const { buildModels } = require("../models");
const { assertConfigured } = require("../config/catalog");
const { AppError } = require("../utils/errors");
const { assertPrincipalId, assertNonEmptyString, assertOpaqueRef } = require("../utils/validate");
const { findPrincipalByContact, findPrincipalById } = require("../utils/principalId");
const { recordTrailStrict, getConsentTrail } = require("../services/consentTrail");
const { wrap, errorMapper, makeCheckOrigin } = require("./shared");

/**
 * The fiduciary's own back office: find a data principal by a contact detail
 * they have given you, and read their consent trail.
 *
 * MOUNT THIS SEPARATELY FROM createRouter, on its own path, behind your own
 * staff authentication. Every route here is operator-facing. Nothing on it is
 * scoped to a session principal, because an operator authorised to read one
 * data principal's trail is authorised to read any - that is what a back
 * office is - and the control is therefore attribution, not scoping: every
 * disclosure is recorded, with who made it and which ticket it was for,
 * before any data leaves.
 *
 * @param {object}   opts
 * @param {object}   opts.db - the connection returned by connect(). Required.
 * @param {Function} [opts.resolveOperator] - (req) => { actorRef } |
 *   Promise<{ actorRef }>. Your staff session lookup, the exact counterpart of
 *   createRouter's resolvePrincipal. Absent, throwing, or returning anything
 *   else and every route here denies with 401, so a misconfigured mount fails
 *   closed. actorRef is host-supplied and opaque - a staff id, a UUID, an LDAP
 *   uid - and is guarded by assertOpaqueRef.
 * @param {true}     opts.rateLimitedByHost - REQUIRED, and required to be
 *   literally true. See the throw below for why.
 * @param {string[]} [opts.allowedOrigins] - ADDITIONAL origins permitted to
 *   make a state-changing request, exactly as on createRouter. The host the
 *   request arrived on is always allowed; this list is a union with it.
 */
function createBackOfficeRouter({ db, resolveOperator, rateLimitedByHost, allowedOrigins = [] } = {}) {
  if (!db || typeof db.model !== "function") {
    throw new Error("db is required - pass the connection returned by connect()");
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((o) => typeof o !== "string")) {
    throw new Error("allowedOrigins must be an array of origin strings, e.g. [\"https://back-office.example\"]");
  }
  // A plain Error, never an AppError: this must not be mappable to an HTTP
  // response. It is a boot-time refusal, the same shape as assertConfigured's,
  // and for the same reason - the alternative fails silently at boot and then
  // loudly in front of the people it was supposed to protect.
  if (rateLimitedByHost !== true) {
    throw new Error(
      "createBackOfficeRouter requires rateLimitedByHost: true. This router is a people-search: " +
        "POST /principals/lookup answers whether an email address belongs to a registered data principal, " +
        "and for the shipped catalog's lender that means answering whether someone has applied for credit. " +
        "This package ships no rate limiting by documented decision, so put request-volume limiting " +
        "(e.g. express-rate-limit) in front of this mount, then pass rateLimitedByHost: true to say you have."
    );
  }
  // Same boot gate createRouter uses. It is not the DPO address that matters
  // here - it is PRINCIPAL_ID_SECRET, which lookupHash needs on the very first
  // lookup. Unset, this router builds fine and then 500s on the first search.
  assertConfigured();
  const models = buildModels(db);

  const router = express.Router();
  // Same order and same reasoning as createRouter: the origin check runs
  // FIRST, ahead of the body parsers, so there is no reason to parse up to
  // 100kb of a request that is about to be refused, and a forged request never
  // reaches the operator lookup at all.
  router.use(makeCheckOrigin(allowedOrigins));
  router.use(express.json({ limit: "100kb" }));
  router.use(express.urlencoded({ extended: false, limit: "100kb" }));

  // Routes go here.

  // The same three-branch mapper createRouter uses, registered LAST. It is
  // shared rather than duplicated: a security-relevant response shape
  // maintained twice drifts. recordTrailStrict's AppError(..., 503) lands in
  // its third branch, which keeps the status and withholds the message.
  router.use(errorMapper);

  return router;
}

module.exports = createBackOfficeRouter;
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/backoffice.test.js`

Expected: PASS - 2 tests.

- [ ] **Step 5: Write the failing tests for operator authentication and the lookup route**

Append to `test/backoffice.test.js`:

```js
// ---------------------------------------------------------------------------
// Operator authentication - fail closed, and never crash
// ---------------------------------------------------------------------------

test("with no resolveOperator configured every back-office route denies - a misconfigured mount fails closed", async () => {
  await withDb(async (conn) => {
    const bo = await bootBackOffice(conn, { resolveOperator: undefined });
    try {
      for (const path of ["/principals/lookup", "/principals/trail"]) {
        const res = await bo.call(path, { email: PII.email, principalId: "a".repeat(64) });
        assert.equal(res.status, 401, `${path} must deny when there is no staff auth hook at all`);
        assert.deepEqual(await res.json(), { error: "operator authentication required" });
      }
      assert.equal(
        await bo.models.TrailEntry.countDocuments({}),
        0,
        "a request that never got past authentication disclosed nothing, so it must record nothing - otherwise an unauthenticated caller can append rows to the accountability record"
      );
    } finally {
      await bo.close();
    }
  });
});

test("a hostile or throwing resolveOperator denies with 401 and does not crash the process", async () => {
  await withDb(async (conn) => {
    const hooks = [
      ["throws synchronously", () => { throw new Error("staff session store is down"); }],
      ["rejects", async () => { throw new Error("staff session store is down"); }],
      ["returns null", () => null],
      ["returns undefined", () => undefined],
      ["returns a bare string instead of an object", () => "staff-4471"],
      ["returns an operator payload as the ref", () => ({ actorRef: { $ne: null } })],
      ["returns a ref containing a space", () => ({ actorRef: "asha patel" })],
      ["returns an email address as the ref", () => ({ actorRef: "asha@example.com" })],
      ["throws from an actorRef getter", () => ({ get actorRef() { throw new Error("boom"); } })],
    ];
    for (const [label, resolveOperator] of hooks) {
      const bo = await bootBackOffice(conn, { resolveOperator });
      try {
        const res = await bo.call("/principals/lookup", { email: PII.email });
        assert.equal(res.status, 401, `a hook that ${label} must produce a 401`);
        assert.equal(
          await bo.models.TrailEntry.countDocuments({}),
          0,
          `a hook that ${label} disclosed nothing, so it must have recorded nothing`
        );
      } finally {
        await bo.close();
      }
    }

    // The whole point of putting the shape check inside the try/catch: after
    // nine hostile hooks the process is still up and a good one still works.
    const ok = await bootBackOffice(conn);
    try {
      const res = await ok.call("/principals/lookup", { email: "nobody@example.com" });
      assert.equal(res.status, 404, "a hostile hook must not have taken the router down with it");
    } finally {
      await ok.close();
    }
  });
});

test("the actorRef recorded is the one that was validated - a shifting getter cannot swap it after the check", async () => {
  await withDb(async (conn) => {
    let reads = 0;
    const shifty = {
      get actorRef() {
        reads += 1;
        return reads === 1 ? "staff-4471" : { $ne: null };
      },
    };
    const bo = await bootBackOffice(conn, { resolveOperator: () => shifty });
    try {
      const res = await bo.call("/principals/lookup", { email: "nobody@example.com" });
      assert.equal(res.status, 404);
      const rows = await bo.models.TrailEntry.find({}).lean();
      assert.equal(rows.length, 1);
      assert.equal(
        rows[0].actor.ref,
        "staff-4471",
        "the value must be copied into a local and validated there - re-reading the property after the check is what lets a getter hand over something else"
      );
      assert.equal(reads, 1, "reading actorRef more than once is exactly the defect this test exists to catch");
    } finally {
      await bo.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /principals/lookup
// ---------------------------------------------------------------------------

test("a back-office lookup records the disclosure before it answers - a hit files under principalId, a miss files no subject at all", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const bo = await bootBackOffice(conn);
    try {
      const hit = await bo.call("/principals/lookup", { email: PII.email, caseRef: "TKT-90210" });
      assert.equal(hit.status, 200);
      assert.deepEqual(
        await hit.json(),
        { principalId },
        "a lookup answers with the principalId and nothing else - name, phone, dob and PAN are not part of finding someone"
      );

      const miss = await bo.call("/principals/lookup", { email: "nobody@example.com", caseRef: "TKT-90211" });
      assert.equal(miss.status, 404);

      const rows = await models.TrailEntry.find({}).lean();
      assert.equal(rows.length, 2, "both the hit and the miss are uses of the surface, and both are recorded");
      const hitRow = rows.find((r) => r.reasonCode === undefined);
      const missRow = rows.find((r) => r.reasonCode === "no_match");
      assert.ok(hitRow && missRow, "one row for the hit, one for the miss, distinguished by reasonCode");

      assert.equal(hitRow.kind, "operator_lookup");
      assert.equal(hitRow.outcome, "recorded");
      assert.equal(hitRow.principalId, principalId);
      assert.equal(hitRow.caseRef, "TKT-90210", "the record must say which ticket the access was for, not only who made it");
      assert.deepEqual(
        { role: hitRow.actor.role, ref: hitRow.actor.ref, channel: hitRow.actor.channel },
        { role: "operator", ref: "staff-4471", channel: "api" }
      );

      assert.equal(missRow.kind, "operator_lookup");
      assert.equal(missRow.outcome, "recorded");
      assert.equal(
        missRow.principalId,
        undefined,
        "a lookup that matched nobody has no data principal to file under, and inventing one would be a claim the record cannot back"
      );

      // THE CENTRAL PRIVACY INVARIANT. A row carrying the contact hash beside
      // the principalId would rebuild the email-to-person index erasure exists
      // to destroy; a row carrying it on a miss would mint a permanent
      // contact-derived identifier for someone who is not a data principal of
      // this fiduciary at all.
      const dump = JSON.stringify(rows);
      assert.doesNotMatch(
        dump,
        new RegExp(lookupHash(PII.email)),
        "the hash of a matched address must appear nowhere in the trail - the fiduciary holds PRINCIPAL_ID_SECRET and could recompute it to rejoin an erased person to their surviving record"
      );
      assert.doesNotMatch(
        dump,
        new RegExp(lookupHash("nobody@example.com")),
        "the hash of an address that matched nobody must appear nowhere - there is no lawful basis for retaining an identifier for a person this fiduciary has no relationship with"
      );
      assert.doesNotMatch(dump, /asha@example\.com|nobody@example\.com/, "and no raw address either");
    } finally {
      await bo.close();
    }
  });
});

test("the back-office lookup is email only - it refuses to search by phone number", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const bo = await bootBackOffice(conn);
    try {
      const res = await bo.call("/principals/lookup", { phone: PII.phone });
      assert.equal(res.status, 400, "one handset can belong to a whole household, so a number identifies nobody on its own");
      const body = await res.json();
      assert.match(body.error, /email/);
      assert.equal(await models.TrailEntry.countDocuments({}), 0, "a refused request disclosed nothing and records nothing");
    } finally {
      await bo.close();
    }
  });
});

test("operator payloads are refused at every back-office entry point, and refusing one records nothing", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const bo = await bootBackOffice(conn);
    const before = await models.TrailEntry.countDocuments({});
    try {
      for (const payload of [{ $ne: null }, { $gt: "" }, { $regex: ".*" }]) {
        const lookup = await bo.call("/principals/lookup", { email: payload });
        assert.equal(lookup.status, 400, `email: ${JSON.stringify(payload)} must be refused, never run as a filter`);

        const trail = await bo.call("/principals/trail", { principalId: payload });
        assert.equal(trail.status, 400, `principalId: ${JSON.stringify(payload)} must be refused, never run as a filter`);
      }
      // caseRef reaches a stored field, so it is guarded as a primitive too.
      const badCase = await bo.call("/principals/lookup", { email: PII.email, caseRef: { $ne: null } });
      assert.equal(badCase.status, 400, "caseRef is written to the record, so it is validated before it gets there");

      assert.equal(
        await models.TrailEntry.countDocuments({}),
        before,
        "nothing was disclosed, so nothing is recorded - a refused payload must not become a way to append rows"
      );
      assert.ok(
        await models.Principal.findOne({ principalId }),
        "setup check - the data principal an operator filter would have matched must actually be on file, or these refusals prove nothing"
      );
    } finally {
      await bo.close();
    }
  });
});
```

- [ ] **Step 6: Run the tests and watch them fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/backoffice.test.js`

Expected: FAIL. The six new tests fail on the missing routes - the first assertion to blow is
`AssertionError [ERR_ASSERTION]: /principals/lookup must deny when there is no staff auth hook at all`
`+ actual - expected` … `+ 404` `- 401`
(Express falls through the router and answers 404 because no route is registered yet.)

- [ ] **Step 7: Implement `requireOperator`, `readCaseRef` and `POST /principals/lookup`**

In `src/http/backOfficeRouter.js`, replace the single line `  // Routes go here.` with the following block (it sits between the `express.urlencoded` line and `router.use(errorMapper)`):

```js
  /**
   * Operator identity comes only from the host's own staff authentication,
   * exactly as principal identity comes only from resolvePrincipal. It is
   * never read from the payload: actorRef is the entire content of the
   * accountability record, and one the caller chooses is not accountability.
   *
   * The ENTIRE shape check sits inside the try/catch, and the value is copied
   * into a local before it is validated. A hook that throws, returns a Proxy,
   * or exposes actorRef as a getter answering differently on each read must
   * produce a 401 - not an unhandled rejection that takes the process down,
   * and not a value that was validated and then swapped before it was stored.
   *
   * JSON only, deliberately not negotiated like createRouter's 401. There is
   * no signed-out data principal here to send back to a page; the only client
   * of this router is your own back-office application.
   */
  async function requireOperator(req, res, next) {
    if (typeof resolveOperator !== "function") {
      return res.status(401).json({ error: "operator authentication required" });
    }
    let actorRef;
    try {
      const resolved = await resolveOperator(req);
      if (!resolved || typeof resolved !== "object") {
        throw new AppError("resolveOperator did not return an operator", 401);
      }
      // Read ONCE, into a local, and validate the local - never the property.
      const candidate = resolved.actorRef;
      actorRef = assertOpaqueRef(candidate, "actorRef");
    } catch {
      return res.status(401).json({ error: "operator authentication required" });
    }
    req.actor = { role: "operator", ref: actorRef, channel: "api" };
    next();
  }

  /**
   * caseRef is the adopter's own ticket reference for the access, so the
   * record says WHY someone was looked up and not only by whom - answering a
   * Section 11 request rather than browsing. Optional, host-supplied, opaque,
   * and validated as a primitive before it can reach a stored field.
   */
  function readCaseRef(body) {
    const value = body.caseRef;
    if (value === undefined || value === null) return undefined;
    return assertOpaqueRef(value, "caseRef");
  }

  // ---------------------------------------------------------------------------
  // Back office - operator-facing, every disclosure recorded before it happens
  // ---------------------------------------------------------------------------

  /**
   * Find a data principal by a contact detail your operator already has.
   *
   * POST, not GET, and the address travels in the body: a raw email in a path
   * or a query string lands in access logs, browser history, Referer headers
   * and CDN cache keys, none of which this library can reach to clean up.
   *
   * EMAIL ONLY, refusing the phone branch findPrincipalByContact still offers
   * to direct library callers - the same rule POST /consent already applies.
   * One handset can belong to a whole household, so a phone number identifies
   * nobody on its own, and an operator surface must not guess.
   */
  router.post(
    "/principals/lookup",
    requireOperator,
    wrap(async (req, res) => {
      const caseRef = readCaseRef(req.body);
      // Validated as a primitive BEFORE it reaches a filter. Without this,
      // {"email": {"$ne": null}} would fall past findPrincipalByContact's
      // `typeof email === "string"` guard into its phone branch and answer a
      // clean "no match" for a payload that was an attack.
      // 320 is the RFC 5321 maximum for an address; nothing longer is one.
      const email = assertNonEmptyString(req.body.email, "email", 320);

      const principal = await findPrincipalByContact({ models, email });

      // THE RECORD IS WRITTEN BEFORE ANYTHING IS RETURNED, and it fails
      // closed: recordTrailStrict throws 503 if it cannot write, so no record
      // means no disclosure. An unaudited people-search is worse than no
      // people-search, and this is the whole of D7.
      //
      // WHAT THE ROW CARRIES is the design's central privacy invariant:
      //
      //   - on a HIT: principalId, and no hash of the address. A row carrying
      //     both would rebuild the email-to-person index erasure exists to
      //     destroy - the fiduciary holds PRINCIPAL_ID_SECRET, so it could
      //     recompute lookupHash("asha@...") at any time and rejoin an erased
      //     person to their surviving record forever.
      //   - on a MISS: no subject at all. A contact-derived identifier for
      //     someone who is not a data principal of this fiduciary would be
      //     personal data with no notice, no consent, no erasure path and no
      //     lawful basis for retention.
      //
      // TrailEntry has no field either hash could be written to, so neither
      // hazard can be reintroduced by a later edit here. Which addresses were
      // probed is forensics; that an operator searched, and found or did not
      // find, is accountability. Only the second is recorded.
      await recordTrailStrict(models, {
        principalId: principal ? principal.principalId : undefined,
        kind: "operator_lookup",
        outcome: "recorded",
        reasonCode: principal ? undefined : "no_match",
        actor: req.actor,
        caseRef,
      });

      if (!principal) {
        throw new AppError("No data principal matches that contact detail", 404);
      }
      res.status(200).json({ principalId: principal.principalId });
    })
  );
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/backoffice.test.js`

Expected: PASS on every test except the two `/principals/trail` assertions inside `"operator payloads are refused at every back-office entry point"`, which still 404 because that route does not exist yet. Failure text:
`AssertionError: principalId: {"$ne":null} must be refused, never run as a filter` … `+ 404` `- 400`

- [ ] **Step 9: Write the failing tests for `POST /principals/trail` and the no-disclosure-without-a-record rule**

Append to `test/backoffice.test.js`:

```js
// ---------------------------------------------------------------------------
// POST /principals/trail
// ---------------------------------------------------------------------------

test("POST /principals/trail records the read first, then answers with the trail including operator refs", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const bo = await bootBackOffice(conn);
    try {
      const res = await bo.call("/principals/trail", { principalId, caseRef: "TKT-90212" });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.principalId, principalId);
      assert.equal(
        body.coverageFrom,
        "2026-09-04",
        "a trail with nothing in it must be able to say we were not recording before this date, rather than implying nothing happened"
      );
      assert.ok(Array.isArray(body.timeline));

      const rows = await models.TrailEntry.find({ kind: "operator_trail_read" }).lean();
      assert.equal(rows.length, 1, "reading someone's trail is itself a disclosure and is itself recorded");
      assert.equal(rows[0].principalId, principalId);
      assert.equal(rows[0].outcome, "recorded");
      assert.equal(rows[0].caseRef, "TKT-90212");
      assert.equal(rows[0].actor.ref, "staff-4471");

      // The rows already written are visible to the next read, and on THIS
      // surface they carry actor.ref. That is the only difference between the
      // back-office read and the data principal's own.
      //
      // TWO rows, not one, and the count is the assertion: the route records
      // the read BEFORE it performs it, so the second call writes its own row
      // and then reads a trail containing both. A 1 here would mean the record
      // is being written after the disclosure, at which point a failed write
      // could no longer stop the data going out - which is the whole of D7.
      const second = await bo.call("/principals/trail", { principalId });
      const seen = (await second.json()).timeline.filter((e) => e.kind === "operator_trail_read");
      assert.equal(seen.length, 2, "the first read and the second read's own row are both in the second read's timeline");
      assert.ok(
        seen.every((e) => e.actor.ref === "staff-4471"),
        "includeOperatorRefs: true is what distinguishes this read from the principal's own, where the ref is withheld"
      );
      assert.ok(
        seen.some((e) => e.caseRef === "TKT-90212"),
        "and the first read's ticket reference survives into the timeline, so the back office can see which case an access was for"
      );
    } finally {
      await bo.close();
    }
  });
});

test("POST /principals/trail 404s for an id with no data principal behind it, and records the attempt anyway", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const bo = await bootBackOffice(conn);
    try {
      const res = await bo.call("/principals/trail", { principalId: "c".repeat(64) });
      assert.equal(res.status, 404);
      const rows = await models.TrailEntry.find({ kind: "operator_trail_read" }).lean();
      assert.equal(
        rows.length,
        1,
        "an operator who probes an id that does not exist has still used this surface - a 404 that left no trace would be the one way to use it unrecorded"
      );
    } finally {
      await bo.close();
    }
  });
});

test("no disclosure without a record - a failed access write is a 503 and returns no principal data", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const bo = await bootBackOffice(conn);

    // recordTrailStrict writes through models.TrailEntry.create. Patching it
    // is the only way to make the access write fail without breaking the
    // database out from under the rest of the request. The patch lives on a
    // model bound to this test's throwaway connection, so it cannot leak.
    const realCreate = models.TrailEntry.create;
    let attempted = 0;
    models.TrailEntry.create = async () => {
      attempted += 1;
      throw new Error("trailentries is unwritable");
    };

    try {
      const lookup = await bo.call("/principals/lookup", { email: PII.email });
      assert.equal(lookup.status, 503, "an unaudited people-search is worse than no people-search: no record, no disclosure");
      const lookupBody = await lookup.text();
      assert.doesNotMatch(
        lookupBody,
        new RegExp(principalId),
        "the principalId must not come back when the access could not be recorded"
      );

      const trail = await bo.call("/principals/trail", { principalId });
      assert.equal(trail.status, 503);
      const trailBody = await trail.text();
      assert.doesNotMatch(trailBody, new RegExp(principalId));
      assert.doesNotMatch(trailBody, /marketing|timeline/, "no part of the trail may be disclosed when the access could not be recorded");

      assert.equal(
        attempted,
        2,
        "both routes must have attempted the access write before answering - if this is 0, the write is not on the path this test believes it is"
      );
    } finally {
      models.TrailEntry.create = realCreate;
      await bo.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The two surfaces stay separate
// ---------------------------------------------------------------------------

test("a back-office route is not reachable on createRouter - the two surfaces never share a mount", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const before = await models.TrailEntry.countDocuments({});

    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      for (const path of ["/principals/lookup", "/principals/trail"]) {
        const res = await fetch(`http://localhost:${port}/dpdp${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ email: PII.email, principalId }),
        });
        assert.equal(
          res.status,
          404,
          `${path} must not exist on the principal-facing router - a data principal must never be able to look another one up`
        );
      }
      assert.equal(
        await models.TrailEntry.countDocuments({}),
        before,
        "and reaching for a back-office route on the wrong router must not have recorded anything"
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
```

- [ ] **Step 10: Run the tests and watch them fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/backoffice.test.js`

Expected: FAIL on the three `/principals/trail` tests. First failure:
`AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `+ actual - expected` `+ 404` `- 200`
at `"POST /principals/trail records the read first…"`. The `"a back-office route is not reachable on createRouter"` test passes already - it is a regression guard against a future mistake, not a driver of this code.

- [ ] **Step 11: Implement `POST /principals/trail`**

In `src/http/backOfficeRouter.js`, insert this immediately after the `router.post("/principals/lookup", ...)` block and before `router.use(errorMapper)`:

```js
  /**
   * Read one data principal's consent trail.
   *
   * POST, for two reasons. It keeps the principalId out of access logs and
   * Referer headers, and - under D7 - this read performs a database write,
   * while GET is exempt from the same-origin check. A cross-site-triggerable
   * write into the accountability record, attributed to a signed-in operator,
   * is not acceptable.
   *
   * principalId IS READ FROM THE BODY HERE, and that is a deliberate carve-out
   * from a rule the rest of this library treats as absolute. On createRouter's
   * principal-facing routes principalId is a CREDENTIAL: reading it from a
   * payload would let anyone who knew an id act as that person, which is the
   * exact bug an earlier version shipped. Here it is a QUERY SUBJECT, and four
   * things have to hold for that distinction to be sound:
   *
   *   1. Operator identity still comes only from resolveOperator(req), never
   *      from the payload. The rule is unchanged for the thing it protects.
   *   2. The operator is not the subject, so there is no privilege to escalate
   *      by naming a different id - an operator authorised to read one trail
   *      is authorised to read any, which is what a back office is.
   *   3. assertPrincipalId runs before the value reaches any filter, so the
   *      injection half of the rule is enforced exactly as it is elsewhere.
   *   4. The route is gated by operator auth AND a fail-closed access record,
   *      so every single use of the carve-out is attributable.
   */
  router.post(
    "/principals/trail",
    requireOperator,
    wrap(async (req, res) => {
      const caseRef = readCaseRef(req.body);
      const principalId = assertPrincipalId(req.body.principalId);

      // Fail-closed, and before anything is read: if the access record cannot
      // be written, recordTrailStrict throws 503 and the disclosure does not
      // happen at all.
      await recordTrailStrict(models, {
        principalId,
        kind: "operator_trail_read",
        outcome: "recorded",
        actor: req.actor,
        caseRef,
      });

      // The existence check runs AFTER the record, not before. An operator who
      // probes an id that does not exist has still used this surface, and a
      // 404 that left no trace would be the one way to use it unrecorded.
      const principal = await findPrincipalById({ models, principalId });
      if (!principal) throw new AppError("No data principal found for that id", 404);

      // includeOperatorRefs: this is the back-office view. actor.ref and
      // caseRef are present here and withheld on the data principal's own
      // read, where naming the individual member of staff is not the point -
      // that someone in the back office looked, is.
      res.status(200).json(await getConsentTrail({ models, principalId, includeOperatorRefs: true }));
    })
  );
```

- [ ] **Step 12: Run the tests and watch them pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/backoffice.test.js`

Expected: PASS - 12 tests, the whole of this file: 2 construction guards, 3 operator-authentication tests, 3 on `POST /principals/lookup`, 3 on `POST /principals/trail`, and the separate-mounts regression guard. The `no disclosure without a record` test prints two
`[dpdp-toolkit] unhandled error: AppError: ...` lines to stderr: that is the shared error mapper's third branch doing its job on a 503, and is expected output, not a failure.

- [ ] **Step 13: Run the whole suite**

Run: `npm test`

Expected: `ℹ pass 237` / `ℹ fail 0`. The arithmetic, so a mismatch tells you which task drifted rather than only that something did: 160 at HEAD, plus 8 from Task 1, 9 from Task 2, 13 from Task 3, 14 from Task 4, 13 from Task 5, 6 from Task 6 and 2 from Task 7 is 225 going in; the 12 in `test/backoffice.test.js` take it to 237. Task 3 contributes 13 rather than 12: a review fix round added a test forcing the E11000 recovery branch. Measured, not derived - run `npm test` and trust its own total. Each figure is the per-file gate that task's own final step states - if one is off, that task drifted. Nothing here touches `createRouter`, the consent ledger, or any existing service, so no existing test needs updating. `test/index.test.js` is untouched by this task - `createBackOfficeRouter` is exported in Task 9, and until then the new file is reachable only by direct require.

- [ ] **Step 14: Commit**

```bash
git add src/http/backOfficeRouter.js test/backoffice.test.js
git commit -m "feat(http): back-office lookup and trail routes behind a fail-closed access record"
```

---

---

### Task 9: Public exports, and the documentation this feature falsifies

**Files:**
- Modify: `src/index.js:1-14` (requires) and `src/index.js:16-70` (the export block)
- Modify: `test/index.test.js:7-30`
- Modify: `src/services/erasure.js:21-29`
- Modify: `README.md:18`, `README.md:119-124`, `README.md:386-403`, `README.md:598-604`, `README.md:605-611`, `README.md:612-616`, `README.md:623-626`, and a new section after "Reading it back"

**Implements:** Spec section 9 in full - every row of its documentation table, plus the residual-7 statement it requires in `README.md`'s register - and the public export surface for sections 8.3, 8.4 and 8.5.

**Interfaces:**
- Consumes: `getConsentTrail` and `findConsentTrailByContact`, both exported by name from `src/services/consentTrail.js` (Task 5, which appends them to the `{ COVERAGE_FROM, UNATTRIBUTED, recordTrail, recordTrailStrict }` surface Task 2 created); `createBackOfficeRouter`, the default export of `src/http/backOfficeRouter.js` (Task 8); the route `GET /consent/trail` on `createRouter` (Task 6) and the constant `COVERAGE_FROM = "2026-09-04"` (Task 2), which the prose documents.
- Produces: `require("dpdp-fiduciary-toolkit")` now yields `getConsentTrail`, `findConsentTrailByContact` and `createBackOfficeRouter` alongside the existing surface. Nothing later in the plan depends on this task.
- **Sole owner of the public export surface.** This task is the only one in the plan that touches `src/index.js` or `test/index.test.js`. Tasks 5 and 8 create the three functions in their own files and stop there; all three names are wired up here, in one edit, so the `expected` array and the `module.exports` object are never written twice.

---

- [ ] **Step 1: Write the failing test - add the three names to the public-API list**

In `test/index.test.js`, replace the line at `:29`:

```js
    "CONSENT_CATALOG", "RIGHTS_CATALOG", "FIDUCIARY",
```

with:

```js
    // The consent audit trail. getConsentTrail is the read; the other two are
    // the surfaces built on it - one deliberately unmounted, one a router the
    // host mounts separately behind its own staff auth.
    "getConsentTrail", "findConsentTrailByContact", "createBackOfficeRouter",
    "CONSENT_CATALOG", "RIGHTS_CATALOG", "FIDUCIARY",
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test --test-global-setup=scripts/test-setup.js test/index.test.js`

Expected: FAIL with
`AssertionError [ERR_ASSERTION]: missing export: getConsentTrail`
in `"the documented public API is all exported"`. All three names are missing
at this point; the `for (const name of expected)` loop below the array walks it
in order and `assert.ok` throws on the first, so `getConsentTrail` is named.
`findConsentTrailByContact` and `createBackOfficeRouter` surface only after
Step 3, and Step 3 adds all three at once.

- [ ] **Step 3: Add the requires and the exports to `src/index.js`**

In `src/index.js`, after the `const createRouter = require("./http/router");` line at `:11`, add:

```js
const createBackOfficeRouter = require("./http/backOfficeRouter");
const { getConsentTrail, findConsentTrailByContact } = require("./services/consentTrail");
```

Then, in the `module.exports` object, add `getConsentTrail` immediately after `listConsentManagerRequests` (it belongs under the existing `// The read path` banner):

```js
  listConsentManagerRequests: consentManagerRequest.listConsentManagerRequests,
  // The consent audit trail: the merged lineage of what a data principal did
  // and what they were told, across the consent ledger and the five other
  // collections that already carry a timestamp. Refusals and silent no-ops are
  // stored because nothing else records them; everything a primary collection
  // can already answer is derived at read time and never copied, so no act is
  // ever reported twice. Covers forward from its release date only - the
  // returned coverageFrom says so, rather than letting an empty timeline imply
  // that nothing happened.
  getConsentTrail,
```

and add `createBackOfficeRouter` and `findConsentTrailByContact` after `createRouter`:

```js
  // Express router with every route pre-wired.
  createRouter,
  // The back-office counterpart, mounted SEPARATELY and never on the same
  // path: it is operator-facing, so nothing on it is scoped to a session
  // principal. Operator identity comes from your own staff auth through
  // resolveOperator, every disclosure it makes is recorded before any data
  // leaves, and it refuses to build without rateLimitedByHost: true - it is a
  // people-search over a guessable keyspace and this package ships no rate
  // limiting. See the README's "The consent audit trail".
  createBackOfficeRouter,
  // Look a data principal up by a contact detail, then read their trail.
  // Deliberately NOT mounted on a route - the same pattern as
  // updatePrincipalContact and erasePrincipalPII. A raw contact value must
  // never reach a URL, and a principal-facing lookup by PII is either
  // redundant (it must equal your own) or a cross-principal read by
  // construction. This one keeps the phone branch the HTTP surface refuses,
  // because a direct library caller is already inside your trust boundary.
  findConsentTrailByContact,
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test --test-global-setup=scripts/test-setup.js test/index.test.js`

Expected: PASS - 3 tests. The structural `list*`/`get*` guard is unaffected: `consentTrail.js` exports no `list*` function, so it adds no pair to check and `pairsChecked` stays at its existing value.

- [ ] **Step 5: Commit the export change**

```bash
git add src/index.js test/index.test.js
git commit -m "feat(index): export getConsentTrail, findConsentTrailByContact and createBackOfficeRouter"
```

- [ ] **Step 6: Correct obligation 7 - the trail is not retroactive**

`README.md:18` today reads:

```
7. Audit trail of the consent should be available at any point in time.
```

Replace it with:

````markdown
7. Audit trail of the consent should be available at any point in time. This
   toolkit closes that obligation **forward from the release of the trail
   feature only**. Entries are written as acts happen, so acts from before that
   date left no entry, and no backfill is possible or permitted -
   reconstructing a timestamp nobody observed would be manufacturing evidence,
   which is the one thing an audit trail must never do. Every trail read
   returns a `coverageFrom` date saying where the record begins, so an empty
   trail reads as "we were not recording before this date" rather than as
   "nothing happened".
````

- [ ] **Step 7: Scope the "never read from a request body" claim to `createRouter`**

`README.md:119-124`, under "### Identity and authentication", today reads:

```
`principalId` is a random 32-byte value (`crypto.randomBytes(32)`), never
derived from an email, a phone number, or anything else an attacker could
already know. It is minted server-side the first time someone signs up
(`POST /consent`), and it is never read from a request body or query string
on any route - the only source of identity on every other route is
`resolvePrincipal(req)`, which you supply.
```

Replace those six lines with:

````markdown
`principalId` is a random 32-byte value (`crypto.randomBytes(32)`), never
derived from an email, a phone number, or anything else an attacker could
already know. It is minted server-side the first time someone signs up
(`POST /consent`), and on **every route `createRouter` mounts** it is never
read from a request body or query string - the only source of identity on
every other principal-facing route is `resolvePrincipal(req)`, which you
supply.

There is exactly one carve-out, and it is on the separate back-office router,
never on `createRouter`: `POST /principals/trail` takes the `principalId` it
is asked about from the request body. There it is a **query subject**, not a
credential, and the carve-out is only sound because all four of these hold.
Operator identity still comes only from `resolveOperator(req)`, so the rule is
unchanged for the thing it was written to protect. The operator is not the
subject, so naming a different id escalates nothing - an operator who may read
one trail may read any, which is what a back office is. `assertPrincipalId`
runs before the value reaches any filter, so the injection half of the rule is
enforced exactly as it is everywhere else. And the route is gated by operator
authentication and a fail-closed access record, so every use of it is
attributable to a named member of staff. See "The consent audit trail" below.
````

- [ ] **Step 8: Restate the same scoping on the read path, and add the new read route to its table**

`README.md:388-394` is the paragraph opening "Every write above has a matching read". Its parenthetical - "there is no path to read another principal's data" - is stated as an unqualified property of the library, and once `createBackOfficeRouter` ships, `POST /principals/trail` is exactly such a path. Appending a correction underneath it would leave a false sentence standing above its own correction, so the parenthetical itself has to be scoped. Spec section 9's second row requires this edit, not just the addition below it.

Replace those seven lines:

```
Every write above has a matching read. Every read is **auth**, scoped by
construction to the signed-in principal (there is no path to read another
principal's data - a `refId` that exists but belongs to someone else 404s,
the same as one that does not exist at all, so a guessed reference cannot be
distinguished from a wrong one), and sent with `Cache-Control: no-store` so a
shared cache or CDN, or a browser's own disk/back-forward cache on a shared
machine, cannot serve one principal's response to the next.
```

with:

````markdown
Every write above has a matching read. Every read is **auth**, scoped by
construction to the signed-in principal (on every route `createRouter` mounts
there is no path to read another principal's data - a `refId` that exists but
belongs to someone else 404s, the same as one that does not exist at all, so a
guessed reference cannot be distinguished from a wrong one; the back-office
router is the one deliberate exception, on its own mount, and it is described
below), and sent with `Cache-Control: no-store` so a shared cache or CDN, or a
browser's own disk/back-forward cache on a shared machine, cannot serve one
principal's response to the next.
````

Then insert this new paragraph immediately after that one, before the `| Route | Returns |` table:

````markdown
None of these routes takes a `principalId` from the request. The id they are
scoped to is the one `resolvePrincipal(req)` returned; a `?principalId=` or a
body field is ignored. Reading another person's record by naming them is the
back office's job, on its own router, behind your own staff authentication and
its own fail-closed access record - see "The consent audit trail" below.
````

Then add this row to that table, immediately under the `GET /consent` row. Task 6 adds the route itself; if it has already added this row, skip this edit rather than duplicating it.

````markdown
| `GET /consent/trail` | `{ principalId, docRef, coverageFrom, timeline, truncated, totalEntries }` - the consent audit trail: what this principal did and what they were told, refusals and silent no-ops included, plus who in the back office has read their record (the individual operator's reference is withheld). |
````

- [ ] **Step 9: Name the trail in `erasePrincipalPII`'s KNOWN LIMIT block**

In `src/services/erasure.js`, the docstring block at `:21-29` ends with "…without also reviewing those three collections, has not completed it." Leave that paragraph unchanged and insert this immediately after it, still inside the same `/** */` block, before the closing ` */` at `:30`:

```js
 *
 * A FOURTH collection now survives erasure, and it is a different case from
 * those three: `trailentries`, the consent audit trail. This function writes
 * nothing to it, edits nothing in it and deletes nothing from it - the erasure
 * is read back from `Principal.erasedAt`, so the trail needs no row of its own
 * to report it. It is retained pseudonymously for the same reason the consent
 * ledger is: it is the fiduciary's evidence of what it recorded and what it
 * told people. Unlike the three collections above it holds no free text and no
 * contact detail by construction - there is no field on it a contact hash
 * could be written to at all - so unlike them, there is nothing in it to
 * review by hand.
```

- [ ] **Step 10: Add the trail to the README's erasure checklist**

`README.md:605-611` today reads:

```
- **`erasePrincipalPII` clears the `Principal` document only.** Free text a
  data principal typed into a grievance description, a rights-request
  `details` field, or a consent-manager `message` is not touched - deciding
  what in a block of prose is personally identifying is a judgement call an
  automated pass gets wrong. A deployment that treats `erasePrincipalPII` as
  completing a Section 12 erasure request, without also reviewing those three
  collections by hand, has not completed it.
```

Replace that bullet with:

````markdown
- **`erasePrincipalPII` clears the `Principal` document only.** Free text a
  data principal typed into a grievance description, a rights-request
  `details` field, or a consent-manager `message` is not touched - deciding
  what in a block of prose is personally identifying is a judgement call an
  automated pass gets wrong. A deployment that treats `erasePrincipalPII` as
  completing a Section 12 erasure request, without also reviewing those three
  collections by hand, has not completed it. A **fourth** collection survives
  erasure and is deliberately *not* on that review list: `trailentries`, the
  consent audit trail. Erasure writes nothing to it, edits nothing in it and
  deletes nothing from it, and it holds no free text and no contact detail by
  construction - there is no field on it a contact hash could be written to -
  so it is retained pseudonymously as evidence, exactly as the consent ledger
  is, with nothing in it for you to review.
````

- [ ] **Step 11: Upgrade rate limiting from a residual to a prerequisite**

`README.md:612-616` today reads:

```
- **No rate limiting on any route.** The nearer-term risk this toolkit closes
  is storage exhaustion via unbounded free text: every free-text field has a
  Mongoose `maxlength` cap, and the request body itself is capped at 100kb.
  Request-volume rate limiting (e.g. `express-rate-limit` in front of this
  router) is host middleware's job and is not shipped here.
```

Replace that bullet with:

````markdown
- **No rate limiting on any route - and for one mount it is a hard
  prerequisite, not a note.** The nearer-term risk this toolkit closes is
  storage exhaustion via unbounded free text: every free-text field has a
  Mongoose `maxlength` cap, and the request body itself is capped at 100kb.
  Request-volume rate limiting (e.g. `express-rate-limit` in front of the
  router) is host middleware's job and is not shipped here. For `createRouter`
  that is informational. For `createBackOfficeRouter` it is not:
  `POST /principals/lookup` answers whether an address belongs to a registered
  data principal, and with the shipped catalog's fiduciary being a lender,
  "registered" means "applied for credit". That router therefore **refuses to
  build** unless you pass `rateLimitedByHost: true` to acknowledge you have put
  a limiter in front of it. Omitting it throws at startup, the same way a
  placeholder Grievance Officer address does, and for the same reason: loud at
  boot, rather than silent at boot and loud in front of a data principal.
````

Then, in the closing paragraph at `README.md:623-626`, replace:

```
Four items above - withdrawal/erasure not reaching your processors, erasure
not reaching free text, no rate limiting, and the install-from-git failure -
are closed **by this documentation, not by code**: an integrator who needs
any of them should plan to build it, not assume it exists.
```

with:

````markdown
Four items above - withdrawal/erasure not reaching your processors, erasure
not reaching free text, no rate limiting on `createRouter`, and the
install-from-git failure - are closed **by this documentation, not by code**:
an integrator who needs any of them should plan to build it, not assume it
exists. Rate limiting in front of `createBackOfficeRouter` is the one
exception in that list: there the documentation is backed by a boot-time
refusal, so a deployment that has not thought about it does not start.
````

- [ ] **Step 12: State the implicit-withdrawal gap in the register it belongs to**

`README.md:598-604` is the bullet beginning "**Withdrawal does not itself stop or erase anything.**" and ending "…this toolkit gives you the signal and the primitive, not the pipeline." Leave that text as it is and append the following to the same bullet:

````markdown
  One withdrawal path is quieter than the rest, and the trail now says so
  in writing. `PUT /consent` can withdraw a purpose **by omission** - submitting
  a shorter consent list withdraws whatever is missing from it - and on that
  path no `onWithdrawal` hook is called at all, because
  `persistPIIwithconsent` takes no such parameter and the router passes none.
  The withdrawal itself is in the ledger, so the trail derives it; what the
  trail *adds* is a `withdrawal_hook_not_fired` entry recording that your
  cease-processing pipeline was never told. That is written proof that a
  Section 6(6) cessation duty may have gone undischarged, and closing it is
  yours to do: recording that the hook did not fire is not the same as firing
  it.
````

- [ ] **Step 13: Add the trail's own entry to "What this is not"**

In the `## What this is not` list, insert this bullet immediately before the "No rate limiting" bullet you edited in Step 11:

````markdown
- **The consent audit trail is evidence of what was recorded, not proof that
  nothing else happened.** Four limits, stated rather than implied. It is **not
  retroactive**: it covers forward from the release of the feature, every read
  returns the `coverageFrom` date that says so, and no backfill is possible or
  permitted - inventing a timestamp nobody observed would be manufacturing
  evidence. Its instrumentation writes are **best-effort**: a trail write that
  fails is logged and the underlying act proceeds, because the trail must never
  take down consent capture, a withdrawal, or the refusal message a data
  principal needs to read. So an entry can be missing, and this package makes
  **no completeness claim** - the same register as "recorded", never "sent".
  Only the back office's own access records fail the other way, closed: if the
  record cannot be written, the disclosure does not happen and you get a `503`.
  And the back-office surface **processes your own staff's personal data**:
  `actor.ref` and `caseRef` are retained in a collection nothing deletes from,
  under your own employment basis, not under anything this library provides.
  `assertOpaqueRef` bounds their *shape* - no spaces, so no free text; no `@`,
  so no address; no punctuation, so no phone number - but not their *meaning*:
  `johnsmith` passes it unharmed. You owe your staff duties this library does
  not discharge.
````

- [ ] **Step 14: Add the feature's own README section**

Insert this as a new section immediately after the "Reading it back" table and before `## Age gate and parental consent`:

`````markdown
## The consent audit trail

`GET /consent` answers "what did this person end up consenting to". The trail
answers the question a Grievance Officer, a Section 11 access request and the
Data Protection Board actually ask: **what did this person do, and what did we
tell them** - refusals and silent no-ops included, which until now left no
trace anywhere.

**The partition rule**, which everything else falls out of: the trail stores
only facts that are destroyed, or never written, anywhere else, and everything
a read can recover from a primary collection is derived at read time and never
copied. A consent event, a rights request, a grievance, an escalation, a
consent-manager handoff and an erasure all already carry a real, observed
timestamp, so the trail reads those where they live. A refused withdrawal, a
re-grant submitted without `regrant: true`, a purpose refused for a child, an
age-gate refusal, a contact correction (which overwrites the old hash), a
request status transition (which the lifecycle functions overwrite in place)
and a back-office disclosure leave nothing behind at all, so those are stored.
Nothing is both stored and derived, so nothing can be double-reported, and no
fact is ever reconstructed from a timestamp nobody observed.

Two surfaces, separate on purpose.

### The data principal's own

`GET /consent/trail`, on `createRouter`, behind `requireAuth`, scoped to the
session principal and sent `no-store` like every other read. It includes the
rows recording that someone in your back office read their record - with the
individual operator's reference withheld - so a data principal exercising
their right of access can see **who looked at them**. This is the headline of
the feature, not the back office.

```js
GET /consent/trail   // auth
-> 200 {
     principalId, docRef,
     coverageFrom: "2026-09-04",
     timeline: [
       { at, kind, source, outcome, actor: { role, channel },
         reasonCode, refId, receiptId, consentTypes, fromStatus, toStatus, count }
     ],
     truncated: false,
     totalEntries: 9
   }
```

Every element has the same shape whether it was stored or derived, so nothing
consuming it has to branch on where it came from; `source` is `"stored"` or
`"derived"` and says which. `outcome` is always one of `recorded`, `refused`
or `no_change`, so a refusal can never be mistaken for a state change. The
read is bounded rather than paginated - under the partition rule a normal
principal has single-digit stored entries - and `truncated` plus
`totalEntries` say honestly whether you have seen everything.

### Your back office

`createBackOfficeRouter` is a **second router**, mounted separately, behind
your own staff authentication. It is not part of `createRouter` and must not be
mounted on the same path.

```js
const { createBackOfficeRouter } = require("dpdp-fiduciary-toolkit");

app.use(
  "/back-office",
  yourStaffAuthMiddleware,
  yourRateLimiter,                        // required - see below
  createBackOfficeRouter({
    db,
    // (req) => { actorRef } | Promise<{ actorRef }>. Your staff session
    // lookup, the exact counterpart of resolvePrincipal. Missing, throwing,
    // or returning anything else and every route here answers 401.
    resolveOperator: (req) => ({ actorRef: req.staff.id }),
    rateLimitedByHost: true,
    allowedOrigins: ["https://back-office.example"],
  })
);
```

```js
POST /principals/lookup   { "email": "asha@example.com", "caseRef": "TKT-90210" }
-> 200 { principalId: "..." }      // 404 if nobody matches

POST /principals/trail    { "principalId": "...", "caseRef": "TKT-90210" }
-> 200 { principalId, docRef, coverageFrom, timeline, truncated, totalEntries }
```

Both are POST, and neither puts a contact detail or a `principalId` in a URL:
a raw email in a path or query string lands in access logs, browser history,
`Referer` headers and CDN cache keys, none of which this library can reach to
clean up. The trail read is POST for a second reason - under the access-record
rule it performs a database write, and `GET` is exempt from the same-origin
check, so a cross-site-triggerable write into the accountability record,
attributed to a signed-in operator, would not be acceptable.

The lookup is **email only**, and refuses the phone branch that
`findConsentTrailByContact` still offers a direct library caller - the same
rule `POST /consent` already applies. One handset can belong to a whole
household, so a phone number identifies nobody on its own.

Every access is recorded **before anything is returned**, and that write
**fails closed**: if the access record cannot be written you get a `503` and no
data at all. No record, no disclosure - an unaudited people-search is worse
than no people-search. `caseRef` is your own ticket reference for the access,
so the record says *why* someone was looked up and not only by whom: answering
a Section 11 request, rather than browsing.

What the access record deliberately does **not** hold is any hash of the
address that was searched for. On a hit it files under `principalId` and
nothing else; on a miss it stores no subject whatsoever, only that an operator
searched and found nothing. Storing the hash beside the `principalId` would
rebuild the email-to-person index erasure exists to destroy - you hold
`PRINCIPAL_ID_SECRET`, so you could recompute it and rejoin an erased person to
their surviving record forever - and storing it on a miss would mint a
permanent contact-derived identifier for someone who is not your data principal
at all. The collection has no field either could be written to.

### The unmounted function

```js
const { findConsentTrailByContact } = require("dpdp-fiduciary-toolkit");

const trail = await findConsentTrailByContact({ models, email: "asha@example.com" });
// -> the same trail shape, or null if nobody matches
```

Exported and **deliberately not a route** - the same pattern as
`erasePrincipalPII`, `updatePrincipalContact` and the fiduciary-side lifecycle
functions. It keeps the phone branch the HTTP surface refuses, because a direct
library caller is already inside your trust boundary and is not a browser.

See "What this is not" below for the four limits that come with all of this:
it is not retroactive, its instrumentation writes are best-effort, it makes no
completeness claim, and the back-office surface processes your own staff's
personal data under your own basis.
`````

- [ ] **Step 15: Run the whole suite**

Run: `npm test`

Expected: all tests pass. No test asserts on README prose, and the only source file this task changes besides `src/index.js` is `src/services/erasure.js`, where the change is inside a docstring - `test/erasure.test.js`'s three tests assert on behaviour and are unaffected. `test/index.test.js` was already updated and passing in Step 4.

- [ ] **Step 16: Verify no dash characters slipped in**

Run: `grep -n "[—–]" README.md src/index.js src/services/erasure.js src/http/backOfficeRouter.js`

Expected: no output. The codebase uses a hyphen ( - ) only; an em or en dash anywhere in the text above is a defect to fix before committing.

- [ ] **Step 17: Commit the documentation**

```bash
git add README.md src/services/erasure.js
git commit -m "docs(readme,erasure): document the consent audit trail and correct what it falsifies"
```

---

