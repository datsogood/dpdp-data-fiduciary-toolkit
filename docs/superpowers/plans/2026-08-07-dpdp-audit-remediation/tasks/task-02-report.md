# Task 2 Report: Test harness, input validation, and the NoSQL injection fix

## Status: DONE_WITH_CONCERNS

The technical work is complete and verified: C2 is closed, the test harness works against a real in-memory MongoDB, and the full suite is green. The concern is procedural, not technical - see "The commit situation" below.

## Resequencing (per your correction)

You were right, and I followed your resequencing exactly:

1. **Mechanical refactor first, no behaviour change.** Added `models` as the first destructured parameter of `withdrawConsent`, deleted the module-scope `require("../models/ConsentRecord")`, and read `models.ConsentRecord` instead. Nothing else changed - the guard was not added yet.
2. **Then wrote/ran the injection test** with the model injected. This time the red phase showed the actual vulnerability: `{$gt: ""}` matched the victim record, `findOne` returned it, `withdrawConsent` resolved (did not reject), and the victim's ledger grew from 1 event to 2.
3. **Then added the guard** (`assertPrincipalId` / `assertStringArray` / `AppError` at the top of the function body) and re-ran. Green.

The brief's original Step 8 expected-failure text was wrong for the reason you diagnosed: it assumed the vulnerability would reproduce before `models` was threaded through, but pre-injection `withdrawConsent` still resolved `ConsentRecord` from the disconnected global mongoose singleton, so the malicious query hit a 10-second buffering timeout instead of a live database. You said you're correcting the plan on your side - I saw that correction already land in `docs/superpowers/plans/2026-08-07-dpdp-audit-remediation.md` (lines ~546-555) while I was working, worded consistently with what I independently verified below.

## TDD evidence - all three states

### `validate.test.js`

**RED** - `node --test test/validate.test.js`, before `src/utils/validate.js` existed:
```
Error: Cannot find module '../src/utils/validate'
...
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

**GREEN** - `node --test test/validate.test.js`, after writing `src/utils/validate.js`:
```
✔ assertPrincipalId accepts a 64-char lowercase hex string (0.60525ms)
✔ assertPrincipalId rejects every NoSQL operator shape (0.245792ms)
✔ assertNonEmptyString enforces the max length (0.096625ms)
✔ assertStringArray rejects non-arrays and non-string members (1.443083ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
```
Pristine, no warnings.

### `injection.test.js` - three states, as you asked

**State 1 - RED, before model injection (superseded, kept for the record).** `node --test test/injection.test.js` against the original `withdrawConsent` (module-scope `require("../models/ConsentRecord")`, no `models` param):
```
AssertionError [ERR_ASSERTION]: operator {"$gt":""} must be rejected
    actual: MongooseError: Operation `consentrecords.findOne()` buffering timed out after 10000ms
```
This is the failure I flagged - it proves nothing about the vulnerability, only that the pre-fix code's globally-bound model was never connected in the test process (confirmed separately: `ConsentRecord.db === mongoose.connection` was `true`, and that connection's `readyState` was `0`).

**State 2 - RED, after injecting `models` but before the guard.** Same test file, unchanged. `withdrawConsent` now reads `models.ConsentRecord`, bound to the harness's connected, isolated connection:
```
AssertionError [ERR_ASSERTION]: Missing expected rejection: operator {"$gt":""} must be rejected
    actual: undefined
    operator: 'rejects'
```
"Missing expected rejection" means the call *resolved* rather than rejecting - exactly what you asked me to confirm. Since the test itself never reaches its final assertion once the first `assert.rejects` throws, I wrote a standalone diagnostic script (`/private/tmp/.../scratchpad/diagnose_c2.js`, not part of the repo) reusing the same harness and model shape to get the concrete before/after evidence:
```
BEFORE: events.length = 1
withdrawConsent RESOLVED (did not reject) with: {"docRef":"CN-TEST-0001","withdrawn":["marketing"],"rejected":[],"effectiveFrom":"2026-08-07T07:40:03.518Z"}
AFTER: events.length = 2
AFTER: events = [{"type":"marketing","status":"granted",...},{"type":"marketing","status":"withdrawn","basis":"Your consent","timestamp":"2026-08-07T07:40:03.518Z"}]
AFTER: matched docRef = CN-TEST-0001 (the victim's own record, returned to an attacker who supplied no valid principalId)
```
Confirmed: `{$gt: ""}` matched the victim, `findOne` returned it, and a `withdrawn` event was appended to a ledger the caller had no right to touch. `events.length` grew from 1 to 2, as you asked me to confirm.

**State 3 - GREEN, after adding the guard.** `node --test test/injection.test.js`:
```
✔ withdrawConsent rejects a NoSQL operator instead of matching an arbitrary principal (604.288667ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```
Fast (~0.6s, no timeout) and pristine.

## Step 10 - skipped, as instructed

Did not add `mongoose.set("sanitizeFilter", true)` at module scope in `src/db/connection.js`. Per your pre-made decision: that is global process state, and requiring this library would corrupt a host application's own unrelated queries (`Model.find({ age: { $gt: 5 } })` throwing `CastError`), which is the exact global-singleton problem Task 3 exists to eliminate. Task 3 sets it on the library's own connection instead. Step 4's per-field validation (`assertPrincipalId`, `assertStringArray`) is this task's whole control for the injection class of bug.

## Step 11 - done

Added `maxlength` to the three free-text/identifier fields, exactly as specified:
- `src/models/RightsRequest.js`: `details: { type: String, default: "", maxlength: 5000 }`
- `src/models/Grievance.js`: `subject: { ..., maxlength: 200 }`, `description: { ..., maxlength: 10000 }`
- `src/models/ConsentManagerRequest.js`: `message: { ..., maxlength: 5000 }`, `preferredConsentManager: { ..., maxlength: 200 }`

## Full suite result

`npm test` at the final state:
```
✔ test/helpers/db.js (241.317792ms)
✔ withdrawConsent rejects a NoSQL operator instead of matching an arbitrary principal (848.58825ms)
✔ assertPrincipalId accepts a 64-char lowercase hex string (0.766458ms)
✔ assertPrincipalId rejects every NoSQL operator shape (0.285625ms)
✔ assertNonEmptyString enforces the max length (0.112125ms)
✔ assertStringArray rejects non-arrays and non-string members (0.719334ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
```
The extra line, `test/helpers/db.js`, is Node's default test-file glob treating any `.js` file under a directory literally named `test/` as a test target; `db.js` defines no `test()` calls, so it trivially reports as passed with zero subtests. Not a warning or error, no unhandled-rejection noise anywhere in the run.

## The commit situation - please read

When I went to run Step 12's commit, I found nothing to commit. Full detail, because this is unusual enough to be worth surfacing rather than silently accepting:

While I was implementing the resequencing above, two commits landed on `fix/dpdp-audit-remediation` that I did not make:

- `a53f705` - "docs: fix the task 2 TDD ordering" - adds `models` injection to `withdrawConsent` (no guard yet), plus `src/utils/errors.js`, `src/utils/validate.js`, `test/helpers/db.js`, `test/injection.test.js`, `test/validate.test.js`, and `package-lock.json`. Byte-for-byte identical to what I had written for my Steps 1-8.
- `57ef186` - "docs: separate signup identity from contact correction" - adds the `assertPrincipalId`/`assertStringArray`/`AppError` guard to `withdrawConsent` (byte-for-byte identical to my Step 9 edit) and the three `maxlength` additions (byte-for-byte identical to my Step 11 edit) - bundled in the same commit as unrelated content: `findOrCreatePrincipal`/`updatePrincipalContact`/signup-identity/shared-phone handling, which reads like Task 4's C1 work, not Task 2's.

A third commit, `72e28cb`, landed after that and only touches the plan doc, not code in my scope.

By the time I ran `git add -A && git commit`, there was nothing staged and nothing to commit - `git status` reported "nothing to commit, working tree clean" against HEAD `72e28cb`, and the commit command correctly no-op'd (confirmed, no new commit created, HEAD unchanged). I did not reset, rebase, amend, or force anything - the git safety rules I operate under forbid rewriting shared branch history without an explicit instruction, and I did not have one.

Given your message said "I'm correcting the plan on my side," and the plan doc's Task 2 section (lines ~546-555) already reads consistently with what I independently verified above, I believe these are your own concurrent edits to this same branch, not a conflict. But two things are worth your attention:

1. **Task 2's actual code closure now lives in commits titled "docs: ..." rather than a `fix:` conventional commit**, and does not carry the specific commit body the brief's Step 12 specified (the detailed C2 explanation, the `express.urlencoded` attack-vector note, etc.). If you want that exact commit message on the record, it would need to be applied now (e.g., by you, since you have write access to this branch and I don't want to rewrite history you may still be adding to).
2. **`57ef186` mixes Task 2's `maxlength` change with what looks like Task 4 content** in one commit. If task boundaries matter for your review/audit trail, that commit may need splitting.

I have not attempted to fix either of these myself - both would require history rewrites on a branch you told me you're actively editing, which is exactly the kind of destructive operation I should not do without your explicit say-so.

## Files in final state (all confirmed present and correct at HEAD `72e28cb`)

- `data-fiduciary-toolkit/src/utils/errors.js` (new) - `AppError`
- `data-fiduciary-toolkit/src/utils/validate.js` (new) - `assertPrincipalId`, `assertNonEmptyString`, `assertStringArray`
- `data-fiduciary-toolkit/test/validate.test.js` (new)
- `data-fiduciary-toolkit/test/helpers/db.js` (new) - `withDb`
- `data-fiduciary-toolkit/test/injection.test.js` (new) - the C2 regression test
- `data-fiduciary-toolkit/src/services/withdrawConsent.js` (modified) - `models` injected, guarded by `assertPrincipalId`/`assertStringArray`
- `data-fiduciary-toolkit/src/models/RightsRequest.js`, `Grievance.js`, `ConsentManagerRequest.js` (modified) - `maxlength` caps
- `data-fiduciary-toolkit/package-lock.json` (new, from `npm install`)

## Transitional router breakage (expected, not fixed)

`src/http/router.js` still calls `withdrawConsent(req.body)` without a `models` argument, so `models` is `undefined` and `models.ConsentRecord.findOne(...)` will throw `TypeError: Cannot read properties of undefined` at runtime through that route. This is the expected transitional breakage you called out: Task 3 threads `models` through all services, Task 5 rewrites the router. I did not fix the router, did not add a fallback to a global model, and did not stub anything. My own tests call the service directly with an explicit `models`, so they are unaffected.

## Self-review

- `assertPrincipalId` rejects every operator shape tested (`$ne`, `$gt`, `$regex`, `$in`, plus array/number/null/undefined/short-string) via a single `typeof value !== "string"` check plus the length/charset regex - verified by the passing unit test, and separately by the injection test against a real database.
- The injection test now runs against a real in-memory MongoDB via `mongodb-memory-server`, with the model actually wired into `withdrawConsent` - not a mock, and (after the resequencing) not a false-positive red phase either.
- Test output is pristine: no stray warnings, no unhandled rejection noise, across all six tests and the full-suite run.
- No em dash or en dash introduced - checked with `grep -P '[\x{2013}\x{2014}]'` against every line I added across all new/modified files; zero matches.
- Did not build anything beyond the brief: no extra validation helpers, no router fixes, no fallback global model, no changes to files outside the brief's list.

## Concerns

1. The commit-attribution situation above - I'd like your confirmation on whether the existing `a53f705`/`57ef186` commits are sufficient as Task 2's closure, or whether you want a clean, separately-attributed commit with the brief's exact message. I did not create a new commit since there was nothing left to stage.
2. `mongodb-memory-server`'s postinstall was blocked by npm 11's script-approval gate (`npm warn allow-scripts`), but this did not affect correctness - the binary still downloads lazily on `MongoMemoryServer.create()`. Untested in a network-restricted CI environment; flagging in case that differs from this sandbox.
