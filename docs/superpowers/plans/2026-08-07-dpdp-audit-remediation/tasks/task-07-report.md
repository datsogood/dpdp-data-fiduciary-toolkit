# Task 7 report: Non-destructive consent writes

**Status:** DONE_WITH_CONCERNS
**Commit:** `2b9596e` fix: make consent writes non-destructive and state-aware
**Closes:** C3, M4, M5, M7, M9
**Suite:** 53/53 pass (33 pre-existing + 20 new), 0 fail, output pristine.

---

## 1. What I implemented

### `src/services/persistPIIwithconsent.js` (rewritten)

Signature is now `{ models, pii, consentTypes, regrant = false, notice }` returning
`{ docRef, receiptId, principalId, created, events, state }`.

- `consentSubmitted = consentTypes !== undefined` is computed **before**
  `assertStringArray` collapses `undefined` to `[]`. This is the whole distinction
  between "no consent decision was made" (omitted, touch nothing) and "I decline
  everything" (`[]`, record declines).
- Unknown types are rejected with `AppError(400)` **before** `findOrCreatePrincipal`,
  so a bad payload writes no principal and no ledger. Tested.
- Identity comes from `findOrCreatePrincipal` (T4), replacing the deleted
  `derivePrincipalId`.
- `decideFor(state)` is a closure returning the event array for a given state. It is
  called twice: once against the document read (or newly built), and again inside the
  E11000 catch against the winner's `currentState()`. `decide()` itself is a single
  module-level pure function - one copy of the state table, no duplication.
- Events carry `{ type, status, basis, lawfulBasisKind, receiptId, timestamp }` where
  `basis` is `entry.lawfulBasis.description` and `lawfulBasisKind` is
  `entry.lawfulBasis.kind`, replacing the deleted `entry.basis`.
- `if (!target || target === current) continue;` is the second guard behind
  `decide()` returning `null`: even if a future `decide()` returned the status a
  purpose already holds, no event is appended.
- `await models.ConsentRecord.init()` before the read/write pair. See §5 Q1 for why,
  and for the honest caveat that no test proves it necessary.

### `src/services/withdrawConsent.js` (rewritten)

Returns `{ docRef, receiptId, withdrawn, rejected, noChange, effectiveFrom }`.

- Reads current state and pushes a `withdrawn` event **only** when the purpose is
  currently `granted`. Everything else lands in `noChange`.
- Saves only when `withdrawn.length`, and fires `onWithdrawal` only then - so a
  host's cessation-and-erasure pipeline is not re-run for a no-op.
- Rejection ordering: unknown type first with `continue`, so `getCatalogEntry(type)`
  is unreachable for a type that has no entry. See §5 Q2.
- `getCatalogEntry(type)` is hoisted once per iteration and used for both the
  rejection reason and the event body (was called twice in the brief's sketch).
- `lawfulBasisKind` is derived from the entry rather than hardcoded `"consent"`, so
  the event cannot misstate the basis for an adopter-authored withdrawable entry.
- Loops `types` (the validated value), not the raw `consentTypes` param - closes the
  minor deferred from Task 2.
- **Input is deduplicated** (`[...new Set(...)]`). See §6, finding 1: this was a real
  duplicate-event bug in the brief's sketch, not a tidy-up.

### `test/consent.test.js` (new, 20 tests)

The brief's 9 tests, plus 11 more (§3).

---

## 2. TDD evidence

### RED

```
$ node --test test/consent.test.js
ℹ tests 20
ℹ pass 0
ℹ fail 20
```

Representative failure:

```
✖ a declined optional purpose is recorded as denied, never as withdrawn
  TypeError: Cannot read properties of undefined (reading 'includes')
      at src/services/persistPIIwithconsent.js:22:72
      at Array.filter (<anonymous>)
      at persistPIIwithconsent (src/services/persistPIIwithconsent.js:22:37)
```

**Why this is the expected failure, and why it differs from the brief's prediction.**
The brief predicted assertion failures ("the current service always rewrites every
purpose"). The actual pre-state fails harder and earlier: Task 6 deleted
`VALID_CONSENT_TYPES` from the catalog, so the module-level destructure at line 1
bound `undefined`, and line 22's `!VALID_CONSENT_TYPES.includes(t)` threw before any
state logic ran. All 20 tests failed at that same line. Had they reached the old
logic they would have failed on the behaviour instead - the old body maps every
catalog entry to `granted`-or-`withdrawn` unconditionally, which is exactly the C3/M5
defect. Either way the red phase is genuine: nothing in the new test file passed
against the old service.

### GREEN

```
$ node --test test/consent.test.js
ℹ tests 20
ℹ pass 20
ℹ fail 0
ℹ duration_ms 15731.66
```

### Mutation testing (verification that the tests are load-bearing)

Assertions that cannot fail are worse than no assertions, so rather than assert
row coverage I proved it. Twelve single-line mutants of `decide()` and the recovery
path, each run against the full new file. **All 12 killed.**

| Mutant | Result | Killed by (count) |
| --- | --- | --- |
| row 1: `return "granted"` -> null when `current === undefined` | KILLED | 13 tests |
| row 2: final `return current ? null : "denied"` -> `null` | KILLED | 5 tests |
| row 3: `granted` + ticked -> `"denied"` instead of `null` | KILLED | 4 tests |
| row 4: `granted` + absent -> `null` instead of `"withdrawn"` | KILLED | 1 test |
| row 5: `denied` + ticked -> `null` instead of `"granted"` | KILLED | 2 tests |
| row 6: `denied` + absent -> `"granted"` instead of `null` | KILLED | 7 tests |
| row 7: `withdrawn` + ticked -> `"granted"` (ignore `regrant`) | KILLED | 2 tests |
| row 7b: `withdrawn` + ticked + `regrant` -> `null` | KILLED | 1 test |
| row 8: `withdrawn` + absent -> `"denied"` instead of `null` | KILLED | 1 test |
| `entry.withdrawable ? "withdrawn" : null` -> `"withdrawn"` | KILLED | 1 test |
| delete the `legitimate_use` early return | KILLED | 2 tests |
| delete `if (!consentSubmitted) return null;` | KILLED | 2 tests |

Two further mutants on the race recovery:

- Replacing `newEvents = decideFor(record.currentState())` with a replay of the stale
  `newEvents`: **KILLED**, and the failure is precisely the one the task warned about -
  `AssertionError: kyc_reporting: the recovery must recompute the delta, not replay
  events computed against an empty state / 2 !== 1`. The same run printed a
  `console.error` marker I had put in the catch, proving the recovery path is
  genuinely entered rather than the test passing because no race occurred.
- Deleting `await models.ConsentRecord.init()`: **SURVIVED** (20/20 still pass). Reported
  honestly in §5 Q1 rather than claimed as verified.

---

## 3. State table, row by row against the code

`decide()` reached with a consent-based entry and `consentSubmitted === true`:

| # | Current | Submitted | Table says | Code path | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | no event | ticked | append `granted` | `wants`, not granted, not withdrawn -> `"granted"`; `target !== current` (undefined) -> appended | correct |
| 2 | no event | absent | append `denied` | not `wants`, `current !== "granted"`, `current` falsy -> `"denied"` | correct |
| 3 | `granted` | ticked | **no event** | `wants` + `current === "granted"` -> `null` | correct |
| 4 | `granted` | absent | append `withdrawn` | not `wants`, `current === "granted"`, `entry.withdrawable` true -> `"withdrawn"` | correct |
| 5 | `denied` | ticked | append `granted` | `wants`, `current` neither granted nor withdrawn -> `"granted"` | correct |
| 6 | `denied` | absent | **no event** | not `wants`, not granted, `current` truthy -> `null` | correct |
| 7 | `withdrawn` | ticked | **no event unless `regrant`** | `wants`, `current === "withdrawn"` -> `regrant ? "granted" : null` | correct |
| 8 | `withdrawn` | absent | **no event** | not `wants`, not granted, `current` truthy -> `null` | correct |

Two rows outside the table, both specified in the task:

- **`legitimate_use`, any submission.** Early return `current ? null : "granted"`, evaluated
  before the `consentSubmitted` check - so the 7(d) notice event is recorded even on a
  PII-only first write, then never touched again.
- **Consent-based with `withdrawable: false`, row 4.** Returns `null`, not `"withdrawn"`.
  `POST /consent` therefore cannot withdraw what `withdrawConsent` refuses to withdraw.

**Rows the brief's tests did not cover, for which I added tests:**

| Row | Test I added |
| --- | --- |
| 4 (`granted` + absent -> `withdrawn`) | "dropping a purpose from a later submission withdraws it, exactly once" - the only test that kills the row-4 mutant |
| 5 (`denied` + ticked -> `granted`) | "a purpose that was declined can be granted later, with no regrant flag needed" - the brief exercised row 5 only incidentally, inside the receipt-id test, asserting nothing about the transition |
| 6 (`denied` + absent -> no event) | covered incidentally by the brief's re-post test; I added explicit `state` assertions to it so the row is named |
| 8 (`withdrawn` + absent -> no event) | "a withdrawal stands whether the next submission ticks the box or leaves it out" - the only test that kills the row-8 mutant |
| 7 (no-event half) | the brief's test asserted only the resulting status; I added `after.events.length === 0` so it fails on a redundant append too |
| `withdrawable: false` guard | "a consent-based purpose an adopter marked non-withdrawable is not withdrawn by omission" - injects a synthetic entry into the live catalog (the push/pop pattern `catalog.test.js` already uses), asserts both services refuse it, pops in a `finally` |
| `legitimate_use` recorded once | "a legitimate use is recorded once for notice and is never withdrawn by omission" - three submissions, exactly one `kyc_reporting` event, and `lawfulBasisKind === "legitimate_use"` so the ledger names the non-consent basis |
| `[]` vs omitted | "an empty consentTypes array declines everything, which is not the same as omitting it" - the row the whole C3 fix turns on; omitting leaves the optional purposes with **no** state at all (`undefined`), not `denied` |
| regrant appends rather than rewrites | added `["granted","withdrawn","granted"]` sequence assertion - the withdrawal stays in the ledger |
| unknown type rejected before any write | "an unknown consent type is rejected before anything is written" - asserts `Principal.countDocuments() === 0` |
| unknown type in `withdrawConsent` | "an unknown purpose is reported as unknown, not looked up for a clause it has no entry for" - §5 Q2 |
| duplicate type in one withdrawal | "a purpose listed twice in one withdrawal request yields one event" - §6 finding 1 |
| `onWithdrawal` silent on a no-op | "the onWithdrawal hook does not fire when nothing changed" |
| create race | "two concurrent first submissions leave one ledger holding one event per purpose" |

---

## 4. Full suite

```
$ npm test
ℹ tests 53
ℹ suites 0
ℹ pass 53
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21022.59
```

33 pre-existing tests all still pass, including `test/injection.test.js`, which now
reaches the rewritten guard. Filtering the output for anything that is not a `✔`,
an `ℹ` or an npm banner line returns nothing - no warnings, no stray stderr, no
unhandled rejections.

Runtime went from 8.1s to 21.0s. That is the cost of 20 more `MongoMemoryServer`
instances at roughly 0.8s each, following the existing per-test `withDb` pattern. I
did not switch the file to a shared server, since deviating from the established
helper is a bigger change than the task warrants; noted in §7 as a candidate for T14.

**Files changed:** `src/services/persistPIIwithconsent.js` (rewritten),
`src/services/withdrawConsent.js` (rewritten), `test/consent.test.js` (new).
Nothing else touched. `src/http/router.js` and `examples/server.js` remain broken for
T5 and T14 as instructed.

---

## 5. The two judgement questions

### Q1: how I structured the race recovery

**I dropped `record.$dpdpNewEvents` and the `saveWithRaceRecovery` helper entirely.**
The try/catch lives inline in `persistPIIwithconsent`, immediately around the single
`record.save()`.

Reasoning: the helper needed `models`, `record`, `principalId`, `notice`, `now` and
`decideFor` passed in - six parameters that exist only to reconstitute a scope the
caller already has. And it needed the `$dpdpNewEvents` back-channel because a function
returning `{ record, events }` cannot otherwise tell the caller what the *first*
attempt appended. Both problems vanish inline: `decideFor` and `snapshotNotice` are
closures, and `record` and `newEvents` are `let` bindings the catch reassigns. The
recovery is 15 lines, sits where a reader is already looking, and the ledger-invariant
comment sits next to the code it protects.

Two things the sketch got right and I kept:

- The delta is **recomputed**: `newEvents = decideFor(record.currentState())` against
  the winner. Mutation-tested (§2) - replaying gives 2 events per purpose.
- `newEvents` is reassigned, so the returned `events` array is what was actually
  appended, and the returned `docRef` and `state` come from the winner. The
  concurrency test asserts `a.docRef === b.docRef` and
  `a.events.length + b.events.length === getCatalog().length`, which fails if the
  loser reports its own discarded ref or its stale delta.

**One inconsistency in the sketch I resolved, and how.** The brief's first attempt does
`if (notice) record.lastNotice = notice;` while its recovery does
`existing.lastNotice = { version, language, body: notice, shownAt: now }` - two
different shapes for the same field. `ConsentRecord` has no `lastNotice` path yet, so
both are currently silent no-ops under mongoose strict mode. I checked the plan: Task 8
adds the field and says "replace `if (notice) record.lastNotice = notice;` with" the
richer shape - singular, one site. So I put the assignment in a single
`snapshotNotice(doc)` closure called from both paths. Task 8 changes one line and both
paths stay in step; the alternative would have left T8 to notice a second divergent
copy on its own.

**On `await models.ConsentRecord.init()` - an addition beyond the brief, reported
honestly.** The recovery only works if E11000 is actually raised, and that depends on
the unique index on `principalId` existing. Mongoose builds indexes in the background
after a model is compiled, so between `buildModels()` and the first request there is a
window in which the index does not exist, both concurrent inserts succeed, and one
principal ends up with two ledgers - the exact M7 failure, now silent instead of loud.
This is the same reasoning progress.md records for accepting `Principal.init()` in
Task 4 ("the race window was open in PRODUCTION indefinitely, not just in tests").

**But I could not make a test prove it.** Deleting the line leaves all 20 tests green,
because `findOrCreatePrincipal` awaits `Principal.init()` first, and that await gives
`ConsentRecord`'s background build enough time to finish. So the line is defensive:
it stops the uniqueness backstop from depending on an incidental await inside an
unrelated function. I think it earns its keep, but it is an addition the brief did not
ask for and a reviewer may reasonably strike it. Task 4's deferred minor already
proposes hoisting all of these into an async `buildModels` entry point.

### Q2: can an unknown purpose be dereferenced for a clause it has no entry for?

**No - and the ordering that prevents it is load-bearing, so I tested it.**

In the loop, the unknown-type check comes first and `continue`s:

```js
if (!getValidConsentTypes().includes(type)) {
  rejected.push({ type, reason: "Unknown consent type" });
  continue;
}
const entry = getCatalogEntry(type);
```

`getValidConsentTypes()` and `getCatalogEntry()` read the same live
`CONSENT_CATALOG`, so passing the first check guarantees `find()` returns an entry -
`entry` cannot be `undefined` at line 48, and `entry.lawfulBasis.clause` cannot throw.
Reversing those two blocks would produce a `TypeError` on any unknown type, and since
`withdrawConsent` is reachable from HTTP that is a 500 on attacker-controlled input.

I hoisted `entry` above the withdrawable check (the sketch called `getCatalogEntry`
twice, once in the rejection branch and once in the event push) so there is exactly
one dereference site to reason about, and added
`"an unknown purpose is reported as unknown, not looked up for a clause it has no
entry for"`, which sends `["not_a_purpose", "marketing"]` and asserts the unknown one
is rejected with reason `Unknown consent type` while the valid one still withdraws.
Without that test the ordering is invisible and a future edit could swap the blocks
silently.

I also changed the event's `lawfulBasisKind` from the sketch's hardcoded `"consent"`
to `entry.lawfulBasis.kind`. The push is only reachable for a `withdrawable` type, and
in the shipped catalog withdrawable implies consent - but hardcoding it means an
adopter with a withdrawable legitimate-use entry would get an event asserting a basis
the catalog contradicts. Deriving it costs nothing and cannot lie.

---

## 6. Self-review findings

**Finding 1 (fixed): the brief's `withdrawConsent` appends duplicate events for a
purpose named twice in one request.** `state` is computed once before the loop, so
`withdrawConsent({ consentTypes: ["marketing", "marketing"] })` read `granted` on both
passes and pushed **two** `withdrawn` events, returning
`withdrawn: ["marketing", "marketing"]`. That is exactly what this task exists to
prevent - a duplicate event for a purpose whose state did not change - and because the
ledger is append-only it could never be corrected. `POST /consent/withdraw` will be
form-fed in T13, and a duplicated checkbox name is an ordinary way for that to arrive.
Fixed by deduplicating at the boundary: `[...new Set(assertStringArray(...))]`. Also
keeps `rejected` and `noChange` free of repeats. Test:
"a purpose listed twice in one withdrawal request yields one event".

`persistPIIwithconsent` is immune to the same input by construction - it iterates the
catalog and only reads `chosen.includes(...)` - so no change was needed there.

**Finding 2 (fixed): unused import.** The brief's `persistPIIwithconsent` imports
`getCatalogEntry` and never uses it. Dropped.

**Finding 3 (fixed): the brief's test secret is too short.** It sets
`PRINCIPAL_ID_SECRET = "test-secret-not-for-production"` - 30 characters. Task 4's fix
round added a 32-character floor to `secret()`, so every test would have thrown
`PRINCIPAL_ID_SECRET is not set or too weak`. Used
`"test-secret-not-for-production-32chars"`, matching `principal.test.js` and
`erasure.test.js`. Worth propagating to any remaining brief that copies that line.

**Finding 4 (not fixed, deliberate - wording only): the non-withdrawable rejection
reason reads as a contradiction for an adopter-authored consent-based entry.** The
message is templated as "rests on `<clause>` (`<description>`), not on your consent".
For `kyc_reporting` it is exactly right and genuinely useful - it names Section 7(d) so
the principal can check the claim. For the synthetic `legacy_locked` entry in my test
(consent basis, `withdrawable: false`) it renders "rests on Section 6 (Your consent),
not on your consent", which is nonsense. I did not fix it: the *behaviour* the task
asked to make consistent by construction is consistent (both services refuse), only
the prose is off, it is unreachable for any catalog satisfying `catalog.test.js`'s
`withdrawable === (kind === "consent")` invariant, and degrading the clause-naming
message to cover a configuration the suite forbids would be a net loss for the
principal. My test asserts only `rejected[0].type` and `withdrawn: []`, so it does not
enshrine the wording. Flagging for a reviewer ruling rather than fixing silently.

**Finding 5 (not fixed, out of scope - see §7): concurrent writes to an *already
existing* record can still append duplicate same-status events.** Verified
empirically, not assumed. Two concurrent submissions both granting `underwriting` on an
existing record produced **three** `underwriting` events (one `denied`, two `granted`),
with both calls reporting `underwriting:granted`. Details and why I judged it out of
scope are in §7.

**Checklist items that came back clean:**

- Re-post after withdrawal leaves the withdrawal standing - two tests, and the row-7
  mutant dies.
- Omitting `consentTypes` touches nothing (`events.length === 0`); `[]` records
  `denied` for every optional purpose; a principal created with `consentTypes` omitted
  has `state.marketing === undefined`, not `denied`.
- `receiptId` is per transaction (`generateDocRef("RC")` per call, asserted distinct
  across two submissions) and is stamped on every event that call appends; `docRef` is
  per record (`generateDocRef("CN")` once at creation, asserted equal across
  submissions, and equal across both winners of the race).
- No path deletes or mutates an existing event. Both services only `push`. The regrant
  test asserts the full `["granted","withdrawn","granted"]` sequence survives.
- Zero em dashes and en dashes in all three files, including the pre-existing ones in
  `persistPIIwithconsent.js` comments that progress.md deferred here. No "2025".
- Commit trailers exact, staged by explicit path, tree clean, `git add -A` not used.

---

## 7. Concerns

1. **A duplicate-event window remains for concurrent writes to an existing record**
   (finding 5). M7 and the brief scope the race to *record creation*, which the E11000
   recovery closes. But once the record exists, two concurrent submissions each read
   the pre-write state, each compute the same delta, and mongoose sends both as
   `$push` - so both land. Measured: 3 `underwriting` events where there should be 2.
   The good news, also measured: `$push` means nothing is **lost** (a whole-array
   `$set` would have dropped the winner's event), and the duplicates are always
   *same-status*, so `currentState()` still resolves correctly and no withdrawal is
   reversed or fabricated. It is ledger noise, not a state defect. I walked the
   adversarial interleavings - `granted`+withdraw, `denied`+omit, `withdrawn`+regrant -
   and none produces a wrong final state. Fixing it properly means optimistic
   concurrency (`__v` guard plus retry) on `ConsentRecord`, which touches a model file
   this task does not own and would make concurrent PII-only updates throw
   `VersionError` for callers to handle. Out of scope; flagging for T14 or a follow-up.
2. **`await models.ConsentRecord.init()` is not test-proven** (§5 Q1). I kept it on the
   merits and disclosed that deleting it leaves the suite green. If a reviewer prefers
   the brief's exact scope, it is one line to remove and nothing else depends on it.
3. **The suite is 2.6x slower** - 8.1s to 21.0s - from 20 more `MongoMemoryServer`
   instances. Following the existing `withDb` pattern rather than changing it. A
   file-scoped shared server with per-test collection drops would recover most of it;
   T14 territory.
4. **`record.updatedAt` does not move when only the notice changes.** `updatedAt` is set
   only inside `if (newEvents.length)`, per the brief. So a submission that refreshes
   the notice snapshot without changing any consent leaves `updatedAt` stale. Kept the
   brief's behaviour rather than guessing; Task 8 owns the notice snapshot and should
   decide.
5. **`created` in the return value describes the *Principal*, not the ConsentRecord.**
   That is what the interface specifies and what T5's router needs, but the name is
   ambiguous next to `docRef` and `state`, which are both about the ledger. Worth a
   line of JSDoc in T5 if the router surfaces it.

---
---

# Fix round 1 report

**Commit:** `d1de99e` fix: treat consentTypes null as omission, not as a decline of everything
**Suite:** 56/56 pass (33 pre-existing + 23 in `consent.test.js`), 0 fail, output pristine.
All four items addressed. No item deferred, no pushback.

## Item 1 (Important): `consentTypes: null` reinstated C3

Confirmed exactly as described, and the impact is worse than "a withdrawn event per
purpose" reads on paper - it is every live optional consent at once.

**Verified failing before the fix.** Rather than infer it from the assertion count I ran
a probe against the pre-fix service: grant `["marketing","analytics","underwriting"]`,
then submit `consentTypes: null`.

```
--- BEFORE FIX ---
events appended by consentTypes: null -> underwriting:withdrawn, marketing:withdrawn, analytics:withdrawn
resulting state -> kyc_reporting:granted, identity_verification:denied, underwriting:withdrawn, marketing:withdrawn, analytics:withdrawn
```

Three live consents revoked by a payload that expressed no consent decision, on an
append-only ledger. The new test failed with `2 !== 0` on its own two-purpose fixture:

```
✖ consentTypes: null counts as omission, not as a decline of everything
  AssertionError [ERR_ASSERTION]: null carries no consent decision, so it appends nothing
  2 !== 0
```

**Fixed** with the suggested one-line change, plus the reasoning in a comment so the
next editor does not simplify it back:

```js
const consentSubmitted = consentTypes !== undefined && consentTypes !== null;
```

After the fix, the same probe:

```
--- AFTER FIX ---
events appended by consentTypes: null -> (none)
resulting state -> kyc_reporting:granted, identity_verification:denied, underwriting:granted, marketing:granted, analytics:granted
```

**Test added:** "consentTypes: null counts as omission, not as a decline of everything" -
asserts `events.length === 0`, both prior grants still `granted`, and the stored event
count unchanged.

I agree with the placement argument: this belongs at the service boundary, not in
Task 5's router. The service is exported directly from `src/index.js` as a
framework-agnostic entry point, so a non-Express adopter never passes through the router
at all. And the note that `withdrawConsent` already rejects `null` (via `types.length`)
is the tell - the two services disagreeing about the same input shape is the smell that
made this findable.

## Item 2 (Minor): `updatedAt` on a notice-only change

Fixed as suggested, in **both** the first-attempt path and the E11000 recovery path -
the recovery had the same `record.updatedAt = now` nested inside `if (newEvents.length)`,
so fixing only the first would have left the two paths disagreeing about a record that
lost the race.

```js
if (newEvents.length) {
  record.events.push(...newEvents);
}
if (newEvents.length || notice) {
  record.updatedAt = now;
}
```

**Test added:** "a notice-only submission moves updatedAt; a submission that changes
nothing does not". It pins both directions, because only asserting the notice case would
let a plain `record.updatedAt = now` on every call pass:

- an unchanged submission leaves `updatedAt` **exactly** equal to the baseline
  (`deepEqual` on the Date - deterministic, no timing involved),
- a notice-only submission moves it.

To make the second half deterministic rather than a race against millisecond
granularity, the test awaits a 5ms `tick()` between submissions. Without that the two
calls could in principle land in the same millisecond and the assertion would flake.
Failed as expected before the fix:

```
✖ a notice-only submission moves updatedAt; a submission that changes nothing does not
  AssertionError [ERR_ASSERTION]: refreshing the notice snapshot is a modification of the record, so updatedAt must move
```

Note this test has real teeth today even though `lastNotice` is not yet a schema path -
`notice` is dropped by mongoose strict mode, but `updatedAt` is persisted, so the
behaviour is observable now and will not silently regress when Task 8 adds the field.

## Item 3 (Minor): `effectiveFrom` on a no-op withdrawal

Fixed: `effectiveFrom: withdrawn.length ? now : null`, with the reason inline and the
JSDoc `@returns` updated to state the null case.

**I checked for existing assertions on a truthy `effectiveFrom`, as asked.** One exists,
in "withdrawing an already-withdrawn purpose is a no-op": `first.effectiveFrom.getTime()
<= Date.now()`. It did **not** need updating - `first` is the withdrawal that actually
withdrew `marketing`, so `withdrawn.length` is 1 and `effectiveFrom` is still a Date. No
other test touches it. Rather than leave the no-op side unasserted I added to that same
test:

```js
assert.equal(second.effectiveFrom, null,
  "a no-op must not report a moment a revocation took effect - nothing took effect");
```

which failed before the fix:

```
  AssertionError [ERR_ASSERTION]: a no-op must not report a moment a revocation took effect
  + actual - expected
  + 2026-08-07T09:37:44.361Z
  - null
```

## Item 4 (Minor): the race test could silently degrade

The criticism is correct and I had understated it in my own report - I noted the
Promise.all test "tests the real concurrent path" without acknowledging that every one
of its assertions holds identically under serialisation. It is not a test of the
recovery; it is a test of the outcome, which the recovery is only one route to.

**What I did: made the collision forced rather than hoped for.** New test, "the
create-race recovery recomputes against the winner instead of replaying", which stubs
`models.ConsentRecord.findOne` to return `null` on its **first** call only. The service
therefore believes no record exists, builds one, and its insert collides on the unique
`principalId` index - so the recovery path is the only way through. The stub then falls
through to the real `findOne`, so the recovery's own re-read sees the truth. The patch
lives on a model bound to that test's throwaway connection, so it cannot leak; it is
restored in a `finally` regardless.

Assertions, each observing a distinct consequence of recomputing rather than replaying:

- `forcedMisses === 1` - the forced miss was consumed, so a collision really was provoked
- `loser.events.length === 0` - the delta recomputed against the winner is empty
- `loser.docRef === winner.docRef` - the loser reports the surviving ref, not its discarded one
- `loser.receiptId !== winner.receiptId` - they were genuinely separate transactions
- `countDocuments === 1` - one ledger
- `after.events.length === stored.events.length` - a replay would have doubled it
- the set of receiptIds in the stored ledger is exactly `[winner.receiptId]` - the
  loser's receipt appears nowhere, so it appended nothing

**How it fails if the recovery is removed.** Mutant: replace the `err.code !== 11000`
guard with an unconditional `throw err`. Result - **KILLED**, the call rejects and the
raw duplicate-key error surfaces:

```
✖ the create-race recovery recomputes against the winner instead of replaying
  Error [MongoServerError]: E11000 duplicate key error collection: test.consentrecords
  index: principalId_1 dup key: { principalId: "60af93cc..." }
```

**How it fails if the recovery replays instead of recomputing.** Mutant: drop the
`newEvents = decideFor(record.currentState())` reassignment. Result - **KILLED** at the
first recovery assertion:

```
  AssertionError [ERR_ASSERTION]: the delta recomputed against the winner is empty
  5 !== 0
```

**How it fails if the race stops happening.** It cannot - that is the point of the
change. The collision is constructed, not awaited: the stub guarantees the missed read
on every run, with no dependence on event-loop ordering, connection pooling or mongod
timing. Two tripwires cover the ways the construction could stop being valid:
`forcedMisses === 1` fires if the service ever stops issuing that read (so the stub is
never consumed), and `countDocuments === 1` together with the `docRef` assertion fires
if the insert stops colliding or the recovery stops re-reading.

**The Promise.all test stays, deliberately, but demoted and relabelled.** It is now
"two concurrent first submissions cannot create two ledgers for one principal" - which is
what it actually guarantees - and its comment says plainly that it does not pin the
recovery and why, pointing at the deterministic test. It still earns its place: it is
the only test that exercises genuine concurrency end to end, and therefore the only one
that would catch the unique index not being built at write time. Its per-purpose
assertion message no longer claims to be about the recovery.

Incidentally, the R1 mutant killed the Promise.all test too, with the same raw E11000 -
so the race *is* occurring in it today rather than serialising. That is evidence for
now, not a guarantee for later, which is exactly the reviewer's point.

## Commands and output

```
$ node --test test/consent.test.js          # RED, after adding the four tests
ℹ tests 23
ℹ pass 20
ℹ fail 3
✖ consentTypes: null counts as omission, not as a decline of everything
✖ withdrawing an already-withdrawn purpose is a no-op, not a duplicate event
✖ a notice-only submission moves updatedAt; a submission that changes nothing does not
```

The new deterministic recovery test passed in the red run, as it should have - it
describes behaviour the previous commit already had correct, and its job is to stop that
behaviour regressing. Its non-vacuity is established by the two mutants above, not by
the red run.

```
$ node --test test/consent.test.js          # GREEN
ℹ tests 23
ℹ pass 23
ℹ fail 0
ℹ duration_ms 20564.03

$ npm test                                  # full suite
ℹ tests 56
ℹ suites 0
ℹ pass 56
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 24800.04
```

Filtering the full-suite output for anything that is not a `✔`, an `ℹ` or an npm banner
line returns nothing - no warnings, no stray stderr, no unhandled rejections. No em
dashes or en dashes in any of the three files; no "2025". All mutants reverted and the
restored file byte-compared against the pre-mutation copy before committing; no `MUTANT`
marker survives anywhere in the tree.

## Files changed in this round

- `src/services/persistPIIwithconsent.js` - items 1 and 2
- `src/services/withdrawConsent.js` - item 3
- `test/consent.test.js` - 3 new tests (23 total, up from 20), 1 new assertion in an
  existing test, 1 test renamed with a corrected comment

Staged by explicit path. **Note:** `docs/superpowers/plans/2026-08-07-dpdp-audit-remediation.md`
is modified in the working tree - that is the coordinator's edit propagating the short
`PRINCIPAL_ID_SECRET` finding from my first report. I left it unstaged and uncommitted.

## Standing concerns after this round

Unchanged from the first report except that concern 4 is now resolved:

1. Duplicate same-status events on concurrent writes to an **already existing** record.
   Confirmed out of scope and carried by the coordinator as a named follow-up
   (optimistic concurrency via `__v` on `ConsentRecord`).
2. `await models.ConsentRecord.init()` remains not test-proven; accepted on the merits
   by the review.
3. Suite runtime is now 24.8s, up from 8.1s at the start of the task and 21.0s after the
   first commit - three more `MongoMemoryServer` instances. Still following the existing
   `withDb` pattern; a file-scoped shared server is T14 territory.
4. ~~`updatedAt` does not move on a notice-only change~~ - fixed in this round.
5. `created` in the return value describes the Principal, not the ConsentRecord. Naming
   only; worth a JSDoc line in T5 if the router surfaces it.
