# Task 11 report: Request lifecycle transitions

**Closes:** H11, L3, L8

## What I implemented

1. **`src/services/requestLifecycle.js` (new).** Holds the shared `advance()` helper, `assertTransition()`, the three transition maps (`RIGHTS_TRANSITIONS`, `GRIEVANCE_TRANSITIONS`, `CM_TRANSITIONS`), and the three exported functions `advanceRightsRequest`, `advanceGrievance`, `advanceConsentManagerRequest` - exactly the code given in the brief's Step 3. Each validates the transition against its map and throws `AppError(..., 409)` on an illegal move; `assertTransition` runs before any mutation, so a rejected call never touches the row (verified below).

2. **`escalateToBoard` guard (`src/services/complaintToTheBoard.js`).** Added a null-safe `if (grievance.status === "escalated")` branch before the SLA check, throwing 409 naming the prior escalation date (or "earlier" if `escalatedAt` is somehow unset). This closes L3 (re-escalation no longer silently overwrites `escalatedAt`) and, combined with `advanceGrievance` now being able to reach `resolved`, makes the pre-existing `resolved` guard reachable for the first time - closing L8, which was "currently unreachable anyway (H11)" per spec.md.

3. **Schema changes.**
   - `RightsRequest`: added `slaDueAt: { type: Date, required: true }` and `resolution: { type: String, default: "", maxlength: 5000 }`.
   - `Grievance`: added `resolution: { type: String, default: "", maxlength: 5000 }` (it already had `slaDueAt`).

4. **`exerciseRight` (`src/services/dataPrincipalRights.js`).** Now sets `slaDueAt` on every `RightsRequest` it creates, computed from a new `FIDUCIARY.rightsSlaDays` config value (default 30), read from `process.env.RIGHTS_SLA_DAYS`. Added to `src/config/catalog.js` alongside the existing `grievanceSlaDays`, and documented in `.env.example` next to `GRIEVANCE_SLA_DAYS`.

5. **`src/index.js`.** Exports `advanceRightsRequest`, `advanceGrievance`, `advanceConsentManagerRequest` with a comment explaining why they are not wired into `createRouter` - deliberately fiduciary-side, not principal-facing.

6. **`test/lifecycle.test.js` (new).** 6 tests - see TDD evidence and the note on test count below.

## Code organization: where the shared helper went, and why

The brief's Step 3 gives exact code that puts `advance()`, `assertTransition()`, and all three transition maps in one file, `src/services/requestLifecycle.js`, rather than splitting each `advance*` function into the service file beside its record's create/read functions. I followed that literally rather than splitting it up, for the reason the task description itself flags as the deciding factor: `advance()` is identical logic shared by all three record types (find by refId, check the map, mutate, save, return). Splitting it three ways would mean either duplicating `advance()`/`assertTransition()` verbatim in `dataPrincipalRights.js`, `complaintToTheBoard.js`, and `consentManagerRequest.js`, or extracting a shared helper into a fourth file anyway and importing it into three - more files and more indirection for the same behavior. One file with three thin exported wrappers is the simpler option and is what the brief's exact code already does.

## TDD evidence

**RED** - `node --test test/lifecycle.test.js` before `src/services/requestLifecycle.js` existed:

```
node:internal/test_runner/harness:124
      throw err;
      ^

Error: Cannot find module '../src/services/requestLifecycle'
...
✖ test/lifecycle.test.js (172.247417ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

Expected failure: the module referenced by the test did not exist yet.

**GREEN** - after writing `requestLifecycle.js`, the schema changes, the `escalateToBoard` guard, and `exerciseRight`'s `slaDueAt`:

```
✔ a rights request can be advanced through its lifecycle (652.099291ms)
✔ an illegal transition is refused (275.888125ms)
✔ a grievance can reach resolved, which makes the resolved guard reachable (327.586541ms)
✔ re-escalation does not overwrite the original escalation date (276.205875ms)
✔ a grievance cannot reach escalated through advanceGrievance - escalateToBoard is the only path in (258.437042ms)
✔ a consent manager request can be advanced, and its transitions have no resolution concept (301.08625ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

## Note on test count vs. the brief's "4/4"

The brief's Step 1 code block gives 4 tests, and Step 6 says "Expected: `test/lifecycle.test.js` 4/4 PASS." But Step 4 separately instructs "Add a test asserting `advanceGrievance({ status: "escalated" })` is refused with 409," and Step 5 instructs "Assert `row.resolution` in the grievance test" - neither of which is present in the Step 1 code as literally given. I read these as later steps layering onto the Step 1 skeleton (consistent with the self-review checklist explicitly asking "Can a grievance reach `escalated` by any route other than `escalateToBoard`? Try it," which only a dedicated test proves), so I:

- Added the `row.resolution` assertion (fetched fresh from the DB, not the return value) to the existing "a grievance can reach resolved" test.
- Added a 5th test: `advanceGrievance({ status: "escalated" })` is refused with 409, and the row is unchanged.
- Added a 6th test for `advanceConsentManagerRequest`, which the brief's Step 1 code never exercises at all despite it being one of the three produced interfaces - added because the plan's global constraint says "every task that changes behaviour ships tests in the same commit," and this function had zero coverage otherwise.
- Added a stored-value check to "an illegal transition is refused" confirming the `RightsRequest` row's status is untouched after the rejected call.

Final count is 6/6, not 4/4. If this reading of the brief is wrong, the fix is trivial (delete the extra assertions/tests), but I believe the added coverage is exactly what the brief's own later steps and self-review checklist ask for.

## Full-suite result

```
ℹ tests 111
ℹ suites 0
ℹ pass 111
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 19802.262041
```

Wall clock (via `time npm test`): ~19.8-20.6s total, consistent with the 19.7s baseline. All 105 pre-existing tests plus the 6 new lifecycle tests pass (111 total).

Baseline was independently re-confirmed before any changes: 105/105 in 19670.475958ms internal duration (20.515s wall).

## Files changed

- `data-fiduciary-toolkit/src/services/requestLifecycle.js` (new)
- `data-fiduciary-toolkit/test/lifecycle.test.js` (new)
- `data-fiduciary-toolkit/src/models/RightsRequest.js` (added `slaDueAt`, `resolution`)
- `data-fiduciary-toolkit/src/models/Grievance.js` (added `resolution`)
- `data-fiduciary-toolkit/src/services/complaintToTheBoard.js` (re-escalation guard)
- `data-fiduciary-toolkit/src/services/dataPrincipalRights.js` (`exerciseRight` sets `slaDueAt`)
- `data-fiduciary-toolkit/src/config/catalog.js` (added `FIDUCIARY.rightsSlaDays`)
- `data-fiduciary-toolkit/.env.example` (documented `RIGHTS_SLA_DAYS`)
- `data-fiduciary-toolkit/src/index.js` (exports the three `advance*` functions)

Commit: `3add911 feat: add request lifecycle transitions`

## Answers to the two judgement questions

**1. Should the transition maps be extensible by an adopter?**

I would keep them fixed, as the brief already does, and not add a configuration hook in this task. Two reasons:

- The audit motivation for this whole task is that a status field an auditor reads must mean something reliable - `updatedAt` moved because a real transition happened, `escalated` implies `escalatedAt` is set, etc. An adopter-supplied map could add a state (e.g. `withdrawn_by_principal`) that no other code in the library knows how to handle: it would not set `escalatedAt`-equivalent fields, would not appear in the audit trail's guard conditions, and any future code (like the `resolved` guard here) written against the fixed set of states could silently mis-handle it. Extensibility here is not "add a config value," it is "add a state the rest of the library has to reason about," which is a bigger change than a toolkit's install-time config surface should carry.
- If an adopter's actual process does not match these four/three/three states, the honest fix is for them to fork the map (it is 3-10 lines) rather than the library accepting arbitrary caller-defined states it cannot otherwise reason about. A compliance toolkit that lets its own audit invariants be redefined by config is a worse failure mode than one that gets bypassed and is visibly forked - the fork is at least legible to a future auditor reading the source, whereas a runtime-injected state is not.

That said, I would not call the question closed forever - if a second or third adopter hits this same wall, that is real signal the fixed maps are wrong, and the right move then is to design a proper extension point (e.g. a documented "custom states must not collide with these reserved values, and here is the extra hook they must implement") rather than a bare "pass your own map" escape hatch that reopens the invariant-violation risk above.

**2. Should `advance()` move `updatedAt` on a no-op transition?**

In the current code this is moot: every transition map's `allowed` list excludes the state you are already in (`closed: []`, `received: ["in_progress", "closed"]` never lists `"received"`, etc.), so `assertTransition` always throws 409 before a same-state call could reach the mutation code. There is no live path today where `status` is set to its current value and `updatedAt` moves.

If a same-state transition were ever allowed (say, to let a caller re-save `resolution` text without changing `status`), I would still not move `updatedAt` unless something actually changed. An auditor reading `updatedAt` on a `RightsRequest` or `Grievance` is inferring "this record was touched, something happened here" - that is the entire value of the field for demonstrating an SLA was tracked and acted on. Moving it on a call that changed nothing manufactures a phantom event: two records with identical `status` and `resolution` values would show different `updatedAt` timestamps for no substantive reason, which is worse for an audit trail than not moving it at all. The correct rule would be "move `updatedAt` only when a field that matters to the record's state actually changed," which the current all-transitions-are-substantive design gets right by construction rather than by an explicit no-op check.

## Self-review

- **Can a grievance reach `escalated` by any route other than `escalateToBoard`?** Tried it directly: `advanceGrievance({ status: "escalated" })` from `open` throws `AppError(..., 409)`, and the row's `status` stays `"open"` with `escalatedAt` still unset. `GRIEVANCE_TRANSITIONS` has no entry whose array contains `"escalated"` as a target, so no state can reach it through `advance()`. Test: "a grievance cannot reach escalated through advanceGrievance."
- **Does `resolution` persist on a `Grievance`, or is it silently dropped?** Asserted the DB-fetched value (`models.Grievance.findOne({ refId }).resolution`), not the return value of `advanceGrievance`, in the "reach resolved" test. It equals `"Calls stopped"` as set. Before the schema change this assertion would have failed with `resolution === undefined` (Mongoose strict mode drops unknown paths silently on `.save()` with no error), which is exactly the bug L8/H11 called out.
- **Is the resolved-grievance guard in `escalateToBoard` now reachable?** Yes - the "reach resolved" test drives a grievance to `resolved` via `advanceGrievance` and then calls `escalateToBoard` on it, asserting the rejection message matches `/resolved/i`. That branch was previously dead code because nothing could ever set `status` to `"resolved"`.
- **Does an illegal transition leave the record untouched, or does it partially apply?** By construction: `assertTransition` runs and throws before `row.status = status` or any other mutation in `advance()`, so a rejected call never calls `.save()`. Verified with two tests re-fetching the row after a rejected call: `RightsRequest` status stays `"closed"`, and `Grievance` status stays `"open"` with `escalatedAt` still unset after a rejected `"escalated"` transition.
- **Test output pristine? Any em dash or en dash?** Ran `grep -nP '[\x{2014}\x{2013}]'` over every file I touched. All new/modified code and comments are clean. Two pre-existing em dashes surfaced in files I edited (`src/services/complaintToTheBoard.js:9` and `src/services/dataPrincipalRights.js:6`, plus one in `src/index.js:16`) - I confirmed via `git diff` that all three are on lines I did not touch, predating this task. Per the "surgical changes" constraint I left them alone rather than sweeping unrelated lines; flagging them here rather than silently fixing or silently ignoring.

## Concerns

- The test-count discrepancy noted above (brief says "4/4," I shipped 6/6) is the only place I diverged from the brief's literal Step 1 text - explained above, and I believe it is what the brief's own Steps 4-5 and self-review checklist ask for, but flagging it explicitly in case that reading is wrong.
- ~~`listGrievances`/`getGrievance` in `complaintToTheBoard.js` still do not expose `resolution` in their returned shape~~ - fixed in the review round below.
- Pre-existing em dashes in three files I touched (not on lines I edited) - noted above, left untouched per "surgical changes."

---

## Fix round 1 of 5

Review approved the task (no Critical, no Important defect in the implementation) and independently re-verified all four invariants from the self-review section above, plus confirmed `slaDueAt` becoming required on `RightsRequest` breaks no existing `.create()` call site. All three of my own flagged concerns were upheld: the 6-vs-4 test count traces to the brief's own Steps 4-5 and is not scope creep; leaving the pre-existing em dashes for Task 14 was correct under surgical-changes discipline; and the `resolution`-missing-from-the-read-path concern was upheld as a real Section 13 gap - this task is what makes a stored `resolution` exist at all, and the read path Task 10 built was hiding the field this task added. One fix requested.

### The fix

**`src/services/complaintToTheBoard.js`.** Added `resolution` to the destructured field list and returned object in both `listGrievances` and `getGrievance`. Previously a data principal reading a resolved grievance back via the read path saw `status: "resolved"` with no explanation of the outcome, even though `advanceGrievance` had genuinely persisted one.

**`src/services/dataPrincipalRights.js`.** Checked whether `listRightsRequests`/`getRightsRequest` had the same gap, as asked - they did, for the identical reason: `RightsRequest` gained `resolution` in this same task, and these two functions' projections predate it. Added `resolution` to both.

**`slaDueAt` on `RightsRequest` has the same non-exposure problem and I did not fix it.** While checking the projections I noticed `listRightsRequests`/`getRightsRequest` also omit `slaDueAt`, which this task likewise added to `RightsRequest` this same task. Unlike `resolution`, this was not part of what was asked ("check whether ... have the same gap" was scoped to `resolution` specifically), so per the surgical-changes discipline I fixed exactly what was requested and confirmed, and I am flagging `slaDueAt`'s non-exposure here as a new finding rather than fixing it unasked. If wanted, it is the same one-line change in both functions in `dataPrincipalRights.js`.

**`test/lifecycle.test.js`.** Added two end-to-end tests per the instruction to test the persistence-plus-projection pair together rather than in isolation (a projection-only test cannot distinguish "field was never stored" from "field was stored but the projection drops it"):
- `complaintToTheBoard` files a real grievance, `advanceGrievance` resolves it with a resolution string, `getGrievance` (the principal-facing read function, not the DB) reads it back and the resolution string is asserted on the returned object.
- `exerciseRight` files a real rights request, `advanceRightsRequest` closes it with a resolution string, `getRightsRequest` reads it back and the resolution string is asserted on the returned object.

### Verification

`node --test test/lifecycle.test.js`:

```
✔ a rights request can be advanced through its lifecycle (629.183834ms)
✔ an illegal transition is refused (260.994ms)
✔ a grievance can reach resolved, which makes the resolved guard reachable (270.85725ms)
✔ re-escalation does not overwrite the original escalation date (293.839791ms)
✔ a grievance cannot reach escalated through advanceGrievance - escalateToBoard is the only path in (278.919375ms)
✔ a consent manager request can be advanced, and its transitions have no resolution concept (298.97425ms)
✔ a resolved grievance's resolution is visible on the principal-facing read path (292.239167ms)
✔ a closed rights request's resolution is visible on the principal-facing read path (279.086ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

`node --test test/readpath.test.js` (owns the two projections I edited - confirms no shape assumption elsewhere broke):

```
✔ a principal's full consent history can be read back (675.438583ms)
✔ the ledger surfaces noticeVersion per event, not just on currentState()'s latest one (269.260958ms)
✔ getConsentState returns pii for a principal who has not been erased, and erasedAt is null (273.942166ms)
✔ GET /consent returns the ledger to the authenticated owner only (342.872791ms)
✔ GET /consent carries Cache-Control: no-store and Vary: Cookie - PII must never be cached (273.258625ms)
✔ GET /rights/requests and GET /rights/requests/:refId are scoped to the owner - a stranger gets 404, not 403 (292.319958ms)
✔ GET /grievances and GET /grievances/:refId are scoped to the owner - a stranger gets 404, not 403 (282.51925ms)
✔ GET /consent-manager/requests is scoped to the owner (280.774333ms)
✔ GET /consent for an erased principal surfaces erasedAt and never resurrects pii (275.660667ms)
✔ a principalId in the query string is ignored on a read route - identity comes only from the session (280.402875ms)
✔ GET /rights/requests/:refId and GET /grievances/:refId are 404 for a syntactically valid refId that never existed (306.873542ms)
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

`npm test` (full suite):

```
ℹ tests 113
ℹ pass 113
ℹ fail 0
ℹ duration_ms 20217.059625
```

Wall clock ~21.1s (`time npm test`). 113 = 105 baseline + 8 lifecycle tests (6 from the original implementation, 2 added in this fix round).

### Files changed in this fix round

- `data-fiduciary-toolkit/src/services/complaintToTheBoard.js` (`resolution` added to `listGrievances`/`getGrievance` projections)
- `data-fiduciary-toolkit/src/services/dataPrincipalRights.js` (`resolution` added to `listRightsRequests`/`getRightsRequest` projections)
- `data-fiduciary-toolkit/test/lifecycle.test.js` (two end-to-end tests)

Commit: `fix: expose grievance and rights-request resolution on the read path`

### New finding for a future round

- `slaDueAt` on `RightsRequest` is not exposed by `listRightsRequests`/`getRightsRequest`, same gap and same cause as the `resolution` fix above, not fixed here because it was outside what was asked this round.
