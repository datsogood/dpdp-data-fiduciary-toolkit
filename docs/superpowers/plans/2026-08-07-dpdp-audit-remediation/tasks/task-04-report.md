# Task 4 Report: Split PII from the ledger, randomise `principalId`

Status: DONE

Branch: `fix/dpdp-audit-remediation`
Commit: `cec9aa2` - feat: split PII from the ledger, randomise principalId

## What was implemented

Followed the brief step by step, verbatim, with TDD for the two new test files.

1. **`src/models/Principal.js`** (new) - `{ schema, build }` factory, matching the T3 shape. Holds `principalId` (required, unique), `emailHash` / `phoneHash` (sparse, indexed, NOT unique), `pii` (name/email/phone/dob/pan/address, none required), `erasedAt`.
2. **`src/utils/principalId.js`** (rewritten) - `newPrincipalId()` (32 random bytes), `secret()` + `lookupHash()` (HMAC-SHA256 keyed on `PRINCIPAL_ID_SECRET`, normalised), `generateDocRef()` (widened to 8 random bytes), `findOrCreatePrincipal()`, `findPrincipalByContact()` (read-only), `findPrincipalById()`, `updatePrincipalContact()`. `derivePrincipalId` is gone entirely, not deprecated.
3. **`src/models/index.js`** - registered `Principal` as the first entry in the model registry.
4. **`src/services/erasure.js`** (new) - `erasePrincipalPII()`, idempotent, clears `pii` fields and both lookup hashes, sets `erasedAt`, leaves the ledger untouched. Docstring names the known limit (free-text PII in Grievance/RightsRequest/ConsentManagerRequest bodies is out of scope for this function).
5. **`test/principal.test.js`** (new) and **`test/erasure.test.js`** (new) - written verbatim from the brief.

Two consequential edits beyond the brief's file list, both required by the decisions already made rather than new scope:

6. **`src/index.js`** - removed the `derivePrincipalId` import and its re-export. Decision 4 says "nothing may re-export it"; leaving the import in place after deleting the function from `principalId.js` would have re-exported `undefined` under that name, which is not deletion, just a quieter version of the same bug.
7. **`src/services/persistPIIwithconsent.js`** - deleted the single inert line `record.pii = { ...record.pii, ...pii };`. `ConsentRecord`'s schema has no `pii` field, so this assignment was already silently dropped by mongoose before my changes (not something my changes caused). Per decision 7, I deleted it because it was safe to do so: no test exercises `persistPIIwithconsent` (confirmed by grep across `test/`), and the function's `derivePrincipalId(pii.email)` call is left as-is - it now resolves to `undefined(...)` and will throw `TypeError` if this function is ever actually invoked, which is expected and matches decision 7 ("you are not fixing it in this task"; Task 7 rewrites this service). I did not touch the adjacent comment ("keep the original docRef and PII record") since it wasn't the specific line named in decision 7 and touching it would be outside a surgical change.

## TDD evidence

### `test/principal.test.js`

RED - command: `node --test test/principal.test.js` (before writing `Principal.js` / rewriting `principalId.js`)

```
✖ newPrincipalId is random, 64 hex chars, and never derived from input (0.75275ms)
✖ lookupHash is keyed - it is not a bare sha256 of the email (0.284ms)
✖ lookupHash refuses to run without a configured secret (0.900042ms)
✖ a principal can be registered by phone alone - no email required (498.615375ms)
  TypeError: findOrCreatePrincipal is not a function
✖ two people sharing a phone can both register (479.208125ms)
  TypeError: findOrCreatePrincipal is not a function
✖ correcting an email keeps the same principalId, via the authenticated path (485.520208ms)
  TypeError: findOrCreatePrincipal is not a function
✖ a contact correction cannot steal another principal's email (520.80125ms)
  TypeError: findOrCreatePrincipal is not a function
ℹ tests 7
ℹ pass 0
ℹ fail 7
```

Expected and matched: `newPrincipalId`/`lookupHash`/`findOrCreatePrincipal`/etc. didn't exist yet in `principalId.js`, so destructuring them from the require gave `undefined`, and calling `undefined()` threw `TypeError: ... is not a function`. The `lookupHash refuses...` test failed too (assert.throws didn't see the expected message, since `lookupHash` itself was `undefined` and calling it threw a different error).

Note: the brief's step 2 said the file would fail with "`newPrincipalId` is not exported" and step 8 anticipated "5/5" - the actual test file the brief itself specifies has 7 `test(...)` blocks, not 5. I ran the file as written; the count discrepancy is in the brief's prose, not in my implementation.

GREEN - command: `node --test test/principal.test.js` (after Steps 3-5)

```
✔ newPrincipalId is random, 64 hex chars, and never derived from input (0.861792ms)
✔ lookupHash is keyed - it is not a bare sha256 of the email (0.40325ms)
✔ lookupHash refuses to run without a configured secret (0.192917ms)
✔ a principal can be registered by phone alone - no email required (914.394459ms)
✔ two people sharing a phone can both register (938.315ms)
✔ correcting an email keeps the same principalId, via the authenticated path (790.541292ms)
✔ a contact correction cannot steal another principal's email (808.011209ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

### `test/erasure.test.js`

Written after `erasure.js` existed (brief's Steps 6-7 are sequential, not RED/GREEN against each other), so there was no separate RED run for this file alone. Ran once, GREEN immediately:

```
node --test test/erasure.test.js
✔ erasure clears PII but preserves the consent ledger (789.670375ms)
✔ erasure is idempotent (797.135ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

## Full-suite result

Command: `node --test`

```
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

10 pre-existing tests (connection, buildModels, injection, validate) + 7 in `principal.test.js` + 2 in `erasure.test.js` = 19, all passing. Ran the full suite three times across the session (before/after the `src/index.js` and `persistPIIwithconsent.js` edits, and again immediately before committing) - same 19/19 each time.

## Files changed

- `data-fiduciary-toolkit/src/models/Principal.js` (new)
- `data-fiduciary-toolkit/src/utils/principalId.js` (rewritten)
- `data-fiduciary-toolkit/src/models/index.js` (modified - registered Principal)
- `data-fiduciary-toolkit/src/services/erasure.js` (new)
- `data-fiduciary-toolkit/test/principal.test.js` (new)
- `data-fiduciary-toolkit/test/erasure.test.js` (new)
- `data-fiduciary-toolkit/src/index.js` (modified - removed `derivePrincipalId` re-export)
- `data-fiduciary-toolkit/src/services/persistPIIwithconsent.js` (modified - removed inert `record.pii` line)

## Judgement questions

### 1. Is `principal.pii ? principal.pii.toObject() : {}` sufficient on a brand-new document?

Verified empirically against the installed mongoose 8.24.2, not assumed. `pii` here is a plain nested-object schema path (`{ name: String, email: String, ... }` directly under the field, not wrapped in `new Schema(...)`) rather than a subdocument. Mongoose auto-initialises nested paths of this shape: constructing `new models.Principal({ principalId: newPrincipalId() })` with no `pii` key at all gives `doc.pii === {}` immediately - truthy, not undefined - and that empty object already carries a working `.toObject()` method (confirmed by direct calls returning `{}`). I also checked the erasure shape (`principal.pii = { name: undefined, email: undefined, ... }`) and the correction-merge shape; in both cases `.toObject()` returns the plain object with the same key/value pairs, including explicit `undefined` values, and the ternary's `{}` fallback branch is simply never reached in practice for this schema shape.

So: the guard is correct and safe, but for a subtly different reason than "handles the undefined case" - in mongoose 8 with a bare nested-object path, `principal.pii` is never actually `undefined` on a freshly constructed document, so the `: {}` fallback is defensive dead code rather than the thing doing the work. It would matter if this field were ever changed to a `Schema`-wrapped subdocument (those can genuinely be `undefined` until assigned) - if that refactor ever happens, this guard is exactly the line that would start doing real work, so leaving it in is correct future-proofing, not cruft.

### 2. Is `phoneHash` free of a unique index?

Verified against a real MongoDB (via `mongodb-memory-server`), not just the schema declaration. After `Principal.createIndexes()`, `collection.getIndexes({ full: true })` returns:

```
{ key: { principalId: 1 }, name: "principalId_1", unique: true }
{ key: { emailHash: 1 }, name: "emailHash_1", sparse: true }
{ key: { phoneHash: 1 }, name: "phoneHash_1", sparse: true }
```

`phoneHash` (and `emailHash`) are `sparse` but carry no `unique` flag at the index level. Uniqueness for contact details is enforced at the application layer only, in `updatePrincipalContact`'s explicit "does this hash already belong to someone else" check - which is correct, since two people sharing a phone (the household-handset case the brief calls out) must be able to coexist with the same `phoneHash`, and a DB-level unique index would make that impossible regardless of application logic.

## Self-review

- **Erasure leaves the ledger intact - asserted, not assumed.** Ran a standalone check (not just the test): created a principal, wrote a `ConsentRecord` with one `granted` event, called `erasePrincipalPII`, then re-fetched both documents. `ConsentRecord.findOne` still returns 1 event with `status: "granted"` after erasure. `test/erasure.test.js` asserts this directly (`ledger.events.length === 1`).
- **Erasure clears `emailHash` and `phoneHash`.** Confirmed both in the test (`assert.equal(after.emailHash, undefined, ...)`) and in the standalone check above, where the post-erasure document serialises to `{"pii":{},"erasedAt":"..."}` with no `emailHash`/`phoneHash` keys at all - the person cannot be re-identified from this system by contact detail.
- **Two people sharing a phone can both register.** Yes - `test/principal.test.js`, "two people sharing a phone can both register": mother and daughter both supply `phone: "9876543210"` with distinct emails, both get `created: true`, distinct `principalId`s, `countDocuments() === 2`.
- **A contact correction cannot steal another principal's email.** Refused, not silently merged. `test/principal.test.js`, "a contact correction cannot steal another principal's email": `updatePrincipalContact` rejects with `status: 409` when the new email already belongs to a different `principalId`. The check excludes the caller's own id (`principalId: { $ne: principalId }`) so re-submitting your own unchanged email doesn't false-positive.
- **`newPrincipalId` is genuinely random.** `crypto.randomBytes(32).toString("hex")` - no arguments, no email/phone/timestamp input anywhere in the function. Test asserts two calls differ and match `/^[a-f0-9]{64}$/`.
- **Test output pristine; no em dash or en dash** in any file I wrote or edited (`Principal.js`, `principalId.js`, `erasure.js`, both new test files, `models/index.js`). I did find pre-existing em dashes in comments in two files I touched for other reasons (`src/index.js` line 14, `persistPIIwithconsent.js` lines 8 and 42) - these predate this task and are not on lines I changed, so per the surgical-changes rule I left them and am flagging them here rather than fixing them silently.

## Concerns

- None that block this task. The two pre-existing em-dash comments noted above are the only style debt I'm aware of in the files this task touched; worth a note for whichever task does a final style sweep.
- `persistPIIwithconsent.js` still calls the now-nonexistent `derivePrincipalId` (line 27) - this was already true the moment I deleted the function per decision 4, and it is explicitly Task 7's job to rewrite this service against `findOrCreatePrincipal`. Flagging for visibility, not asking for scope change.
- `src/http/router.js` and `examples/server.js` are unchanged and remain broken per decision 6 (Tasks 5/14).

---

## Fix round 1

Commit: `7d8c5e7` - fix: close identity races and the erasure-terminal gap in Principal

The reviewer confirmed all nine security properties hold and verified at the raw-document level that erasure's `$unset` really removes the hashes. Four Important findings remained, three demonstrated empirically. Findings 1 and 2 were corrections to the original plan (per the coordinator), not defects introduced by my implementation of that plan; I implemented the specified fixes as given, plus one gap I found while making finding 2's fix actually testable.

### Finding 1 - phone clash check locked shared-handset households out of corrections

`updatePrincipalContact` previously checked both `email` and `phone` for a clash against another principal. Since `phoneHash` is deliberately non-unique (household handset sharing), a daughter resubmitting her own unchanged phone number while correcting her name would hit another legitimate principal's `phoneHash` and 409 - a functional lockout of the Section 12 correction right for exactly the population this design targets.

Fix, exactly as specified: `phoneHash` is now written unconditionally when `pii.phone` is supplied, with no clash check at all. Only `email` is checked, and only when the new hash differs from the principal's current one (resubmitting your own unchanged email is never a clash).

### Finding 2 - check-then-act race let two principals share one emailHash

Two concurrent `updatePrincipalContact` (or `findOrCreatePrincipal`) calls claiming the same email could both pass their `findOne` clash-check before either had written, leaving `countDocuments({ emailHash })` at 2. Since "email is the stronger identifier" is the premise of the whole matching rule, that means `findOne({ emailHash })` afterwards resolves to an arbitrary one of two people.

Fix, exactly as specified: `emailHash` is now `unique: true` (alongside the existing `sparse: true`) in `src/models/Principal.js`. Both `findOrCreatePrincipal` and `updatePrincipalContact` wrap their `save()` in try/catch and convert a MongoDB duplicate-key error (`err.code === 11000`) into the same `AppError(..., 409)` a synchronous clash check would throw, so the loser of the race reads as a clean conflict rather than a raw Mongo error.

**Gap found while writing the required concurrency test, not in the original finding.** The first version of the concurrency test failed with `2 !== 1` - both racing writes succeeded. Root cause, verified directly against a real `mongodb-memory-server` instance (not assumed):

```
process.env.PRINCIPAL_ID_SECRET set; buildModels(conn) called;
immediately fired two Principal.create() calls with the same emailHash,
with no wait for index build:
  r1: fulfilled
  r2: fulfilled
  count with sameHash: 2
```

Mongoose builds declared indexes in the background after a model is first registered (`autoIndex`); nothing in `buildModels`/`connect()` waits for that build to finish, so immediately after wiring up models the unique index is declared but not yet enforced - precisely the race the fix exists to close. Re-running the same script with `await models.Principal.init()` before the race:

```
  r1: fulfilled
  r2: rejected 11000
  count with sameHash: 1
  second init() call took ms: 0
```

`Model.init()` resolves once index building finishes and is memoized (confirmed: 0ms on a second call), so it is free after the first real call in the process's life. I added `await models.Principal.init();` as the first database operation in both `findOrCreatePrincipal` and `updatePrincipalContact`. This wasn't in the coordinator's fix text; I'm flagging it explicitly because it's load-bearing for finding 2's fix to actually hold under the exact conditions the reviewer reproduced (a freshly connected process, which is exactly what every test in this suite does via `withDb`, and plausibly also true of a real deployment in the seconds after a cold start/restart).

### Finding 3 - erasure was not terminal

`updatePrincipalContact` now checks `principal.erasedAt` immediately after loading the document and rejects with 409 before touching any field, using the exact message and placement specified. A session issued before an erasure - or any authenticated caller - can no longer write PII back onto an erased record.

### Finding 4 - erasure test under-asserted

Replaced the 3-field assertion with the specified `assert.deepEqual(after.toObject().pii ?? {}, {}, ...)` plus an explicit `phoneHash` check. Verified before writing it (not assumed) that this is safe regardless of which shape mongoose returns for an all-cleared nested path: dumped the raw BSON document via the native driver after erasure and confirmed `pii`, `emailHash`, and `phoneHash` are absent from the document entirely -

```
RAW BSON doc: {
  "_id": "...", "principalId": "...",
  "erasedAt": "...", "createdAt": "...", "updatedAt": "...", "__v": 0
}
```

- no `pii` key, no `emailHash`, no `phoneHash`. All 8 fields (6 `pii` leaves + 2 hashes) are genuinely gone at the storage layer, confirming the reviewer's raw-document finding and the coordinator's assertion strategy.

### Minor items also done

- `secret()` now rejects a blank or under-32-character `PRINCIPAL_ID_SECRET` (`!s || !s.trim() || s.trim().length < 32`), not just a falsy one. Checked the existing test fixture first: `"test-secret-not-for-production"` is 30 characters, so I bumped both `test/principal.test.js` and `test/erasure.test.js` to `"test-secret-not-for-production-32chars"` (38 characters) - otherwise every test in both files would have started failing `secret()`'s new check.
- Added `findPrincipalById` coverage: known id returns the principal, unknown id (a freshly generated `newPrincipalId()`) returns `null`.
- Removed `persistPIIwithconsent.js`'s other inert PII write - the `pii,` key passed into `models.ConsentRecord.create({...})` in the create branch. `ConsentRecord`'s schema has no `pii` field (confirmed unchanged from the original Task 4 report), so this was already silently dropped, symmetric with the `record.pii = ...` line already removed in the update branch. Did not touch the adjacent comments or the still-present `derivePrincipalId(pii.email)` call - both remain because Task 7 rewrites this file entirely.

### Tests added

In `test/principal.test.js`:
- `resubmitting your own unchanged phone number does not 409 - a shared handset must not lock out corrections`
- `two concurrent corrections claiming the same new email - exactly one wins`
- `an erased principal's record cannot be written back to - erasure is terminal`
- `findPrincipalById returns the principal for a known id and null for an unknown one`

In `test/erasure.test.js`: broadened the existing assertion (no new test added; finding 4 was a gap in an existing test, not a missing one).

### RED/GREEN evidence

The concurrency test is the one case with a real RED phase in this round - it caught a genuine bug (the index-build race), not a not-yet-implemented feature:

RED (before adding `Model.init()`), `node --test test/principal.test.js`:
```
✖ two concurrent corrections claiming the same new email - exactly one wins (783.74425ms)
  AssertionError [ERR_ASSERTION]: exactly one of the two racing corrections must win
  2 !== 1
ℹ tests 11
ℹ pass 10
ℹ fail 1
```

GREEN (after adding `await models.Principal.init()` to both functions), `node --test test/principal.test.js`:
```
✔ newPrincipalId is random, 64 hex chars, and never derived from input (0.861625ms)
✔ lookupHash is keyed - it is not a bare sha256 of the email (0.415291ms)
✔ lookupHash refuses to run without a configured secret (0.181583ms)
✔ a principal can be registered by phone alone - no email required (922.781916ms)
✔ two people sharing a phone can both register (758.261958ms)
✔ correcting an email keeps the same principalId, via the authenticated path (757.818875ms)
✔ a contact correction cannot steal another principal's email (750.803333ms)
✔ resubmitting your own unchanged phone number does not 409 - a shared handset must not lock out corrections (770.314625ms)
✔ two concurrent corrections claiming the same new email - exactly one wins (739.844625ms)
✔ an erased principal's record cannot be written back to - erasure is terminal (734.90625ms)
✔ findPrincipalById returns the principal for a known id and null for an unknown one (748.52275ms)
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

Re-ran `node --test test/principal.test.js` 5 consecutive times after the fix to check the concurrency test for flakiness (a real two-process race against a real, if ephemeral, mongod could in principle be timing-sensitive): `11/11` every time.

`node --test test/erasure.test.js`:
```
✔ erasure clears PII but preserves the consent ledger (763.96475ms)
✔ erasure is idempotent (770.758ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

Full suite, `node --test`:
```
ℹ tests 23
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

23 = 10 original + 2 `erasure.test.js` + 11 `principal.test.js` (7 from the initial implementation + 4 new this round). Ran the full suite twice this round (once mid-fix, once immediately before committing) - 23/23 both times.

### Files changed this round

- `data-fiduciary-toolkit/src/models/Principal.js` - `emailHash` is now `unique: true`; comments explain why `emailHash` is unique and `phoneHash` deliberately is not.
- `data-fiduciary-toolkit/src/utils/principalId.js` - `secret()` minimum-length check; `Model.init()` guard and duplicate-key handling in `findOrCreatePrincipal`; erasure-terminal check, phone/email asymmetric handling, and duplicate-key handling in `updatePrincipalContact`.
- `data-fiduciary-toolkit/src/services/persistPIIwithconsent.js` - removed the second inert `pii` write.
- `data-fiduciary-toolkit/test/principal.test.js` - bumped test secret to 38 characters; added the four tests listed above.
- `data-fiduciary-toolkit/test/erasure.test.js` - bumped test secret to 38 characters; broadened the erasure assertion to the full `pii` shape plus `phoneHash`.

Note: `git status` also showed `docs/superpowers/plans/2026-08-07-dpdp-audit-remediation.md` as modified during this round. I did not touch that file - it is the coordinator's own edit to the plan (referenced in their message as "I have corrected the plan") - and deliberately left it unstaged and out of my commit.

### Concerns

- None blocking. The `Model.init()` addition is outside the coordinator's literal fix text; I judged it necessary because without it, finding 2's fix does not actually hold under the exact conditions demonstrated (a freshly wired-up connection), so shipping the specified fix without it would leave the finding effectively open. Flagging for the reviewer's attention rather than treating it as a silent extra.
- `src/http/router.js` and `examples/server.js` remain untouched and broken per decision 6 (Tasks 5/14), same as the original Task 4 report.
