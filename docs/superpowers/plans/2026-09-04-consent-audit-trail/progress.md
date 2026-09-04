# SDD ledger - plan: docs/superpowers/plans/2026-09-04-consent-audit-trail/

Branch: `feat/consent-audit-trail`, cut from `main` at `befffe6`.
Isolation: dedicated feature branch in the primary working directory (not main).
Issue: [#4](https://github.com/datsogood/dpdp-data-fiduciary-toolkit/issues/4). The PR references it; the reviewer closes it.

Tasks: 9. Steps: 134. Suite at HEAD: 158 tests, expected 234 when Task 8 lands.

## Design phase

Design produced from a 7-agent understand pass over the codebase, the DPDP obligations
and the PII-lookup threat model, then a 5-designer / 3-critic pass. All three critics
returned needs-rework on the first design and reshaped it substantially:

- 25 event kinds cut to 11; ~1000 new src LOC cut to ~400; 144 test cases cut to ~40.
- The dedup layer (~120 LOC) deleted outright by adopting the partition rule.
- `lookupHash` removed as a field entirely, after three lenses independently found that
  a row carrying it beside `principalId` rebuilds the email-to-person index erasure
  exists to destroy, and that a schema validator does not hold it (verified: mongoose
  8.24.2 `updateOne` skips document validators).

## Design review

Five adversarial lenses against the WRITTEN spec, every blocker and major then sent to
an independent verifier prompted to refute it. 61 raised, 15 verified, 13 survived,
2 refuted.

Verdicts: security `ready-with-changes` ("could not break it"), dpdp
`ready-with-changes` ("unusually careful about the law"), simplicity
`ready-with-changes` ("right-sized"), implementability `needs-rework`, codebase-fit
`needs-rework`. The two rework verdicts were precision defects, not design defects.

Four lenses independently found the same blocker: the `trail_opened` marker row could
not be written against its own schema (`actor` and `outcome` both required, marker
specified as having neither - verified `ValidationError: Path 'actor' is required`),
and under the fail-open rule that failure would have been SILENT, so `coverageFrom`
would have been permanently absent. Deleted; `COVERAGE_FROM` is a module constant.

Also closed: `caseRef` had no schema field; the `@` blocklist guarding it was replaced
by `assertOpaqueRef`, a positive regex matching `validate.js`'s own discipline;
`consentType` became `consentTypes: [String]` (a scalar path CastErrors on the array a
collapsed refusal row must carry); the timeline element shape, derived kind vocabulary
and ordering tiebreak were specified; the `principalId`-in-body carve-out from the
branch Global Constraints was named and argued; the seven README sentences this feature
falsifies were listed as required edits; and residual 7's factual claim was corrected.

## Plan phase

Drafted by 7 parallel agents against a frozen interface contract, then 2 checkers.

PLAN REVISION 1 (30 cross-task findings, both checkers `fixable`)
  Applied by 9 repair agents, one per task file. Notable:
   - `src/index.js` and `test/index.test.js` were edited by both Task 5 and Task 9.
     Task 9 is now sole owner; Task 5's steps 13-17 deleted.
   - `module.exports` of `consentTrail.js` was being rewritten by Task 5 in a way that
     DROPPED the constants Task 2 exports.
   - Four of spec section 10's ten test cases had no test at all: the PII property scan
     with its non-vacuity inverse, the lookupHash-zero-documents scan, the
     `GET /consent/new` and duplicate-signup-409 zero-growth pair, and the 200-type
     collapse bound. All four added.
   - Running test totals were quoted off a polluted count (see CONTROLLER ERROR below).

PLAN REVISION 2 (11 further findings after re-check)
   - BLOCKER: the Task 2 repair deleted the `SYSTEM` constant as dead code, and that
     deletion was not propagated - Tasks 5 and 9 still named it in six places.
   - BLOCKER: a test asserted `doesNotMatch(JSON.stringify(row), /SLA|due/i)` on a row
     whose own `reasonCode` is `sla_not_lapsed`. The regex matches the value the row is
     required to carry, so the test could never pass.
   - Whole-suite total in Task 8 contradicted four of the seven per-task gates it summed.
   - The erasure hash scan covered only `TrailEntry`; widened to every registered model,
     which is what spec case 3 actually says.
   - Two enum values no task emits (`already_in_state`, and the
     `consent_refused`/`unknown_consent_type` pair) now carry a comment saying so, rather
     than leaving a reader hunting for the emitter.

CONTROLLER ERROR (mine, recorded rather than quietly fixed)
  A drafting agent wrote `test/trail.test.js` and modified `test/validate.test.js`
  directly in the working tree during the PLANNING phase. Content was identical to what
  it put in the plan, so nothing was lost, and both were reverted - but I then counted
  the suite against the polluted tree and briefly reported 166 tests at HEAD. The true
  figure is 158, which is what the checkers had said. Two lessons, both applied: verify
  a count against `git stash`-clean state or against HEAD directly, and add an explicit
  "do not write to the repo" constraint to build-phase agent prompts so instrumentation
  lands only task-by-task behind its review gate.

## Execution

Complete. All nine tasks landed, whole-branch review clean, PR #13 open against main.
Suite 158 -> 238. The subagent-driven execution ledger follows, preserved from the
git-ignored SDD workspace before that workspace was deleted - it is the only record of
the rulings made during the build.

| Exec | Task | Deliverable | State |
| --- | --- | --- | --- |
| 1 | T1 | `TrailEntry` model, registry line, `assertOpaqueRef` | complete |
| 2 | T2 | `recordTrail`, `recordTrailStrict`, `COVERAGE_FROM` | complete |
| 3 | T3 | Instrument the consent write path | complete |
| 4 | T4 | Instrument withdrawal, lifecycle, escalation, contact correction | complete |
| 5 | T5 | `getConsentTrail`, `findConsentTrailByContact` | complete |
| 6 | T6 | `GET /consent/trail`, contact-mismatch refusal | complete |
| 7 | T7 | Extract `src/http/shared.js` | complete |
| 8 | T8 | `createBackOfficeRouter` | complete |
| 9 | T9 | Public exports and documentation | complete |

Then, outside the plan: code review, ADR, and `docs/handbook/`.


---

# Execution ledger (from .superpowers/sdd/plan/progress.md)

## Execution

Task 1: dispatched (implementer sonnet, BASE 58272e2) - TrailEntry model, registry line, assertOpaqueRef
Task 1: DONE_WITH_CONCERNS (commits 6975881, 377d43f). Suite 168/168 pass, 0 fail.
Task 1: Ruling: the plan's pass-count gates were each 2 low. I derived the 158 baseline with
  `grep -c '^test('`; the implementer measured 160 by running the suite and was right.
  Verified myself: every test FILE's runtime count matches its grep count (sum 166 post-task),
  but `npm test` reports 168 - node's suite-level bookkeeping adds 2 that per-file runs do not.
  Fixed the four gates in plan.md (+2 each: T1 166->168, T2 175->177, T3 187->189, T8 234->236)
  and told later tasks to trust `npm test`'s own total over any summed count.
  Cost if wrong: a later task chases a 2-test discrepancy that is not real. Low - the gate is a
  drift detector, not an acceptance criterion, and the delta each task adds is unchanged.
Task 1: review - spec PASS, quality CHANGES REQUESTED (1 Important, plan-mandated).
Task 1: Ruling: the Important finding ("the JSDoc claims the README states the
  assertOpaqueRef shape-not-meaning residual, but no task adds it, so it ships false")
  is REFUTED on the facts. Task 9 Step 13 adds exactly that residual to README's
  "What this is not" list: "assertOpaqueRef bounds their *shape* ... but not their
  *meaning*: `johnsmith` passes it unharmed." The reviewer grepped README.md (correctly
  empty so far) and searched briefs for the phrase "residual 4", missing Task 9's bullet
  because it is worded differently. The text is verbatim from the brief, so it is
  plan-mandated and mine to rule on. Combined with this repo's own precedent
  (2026-08-07 progress.md:23, "accept forward-referencing docs - branch lands as one PR"),
  the claim is true at merge. No code change.
  Cost if wrong: a code comment points at a README section that lands 8 tasks later in
  the same PR. If Task 9 Step 13 is ever cut, the comment becomes false - so it is now
  a named dependency of Task 9 and is recorded as such below.
Task 1: minor (deferred): Task 9 Step 13's bullet says assertOpaqueRef allows "no @, so no
  address", which is true of the positive regex but frames it as a blocklist - the exact
  mental model the design rejected. Reword when Task 9 runs.
Task 1: dependency: Task 9 Step 13 must not be cut - Task 1's JSDoc references it.
Task 1: resolved the reviewer's "cannot verify from diff" myself: ran `npm test` on this
  checkout, 168 pass / 0 fail, which includes test/connection.test.js:62-63 (global
  mongoose registry stays clean). Not a gap.
Task 1: complete (commits 58272e2..377d43f, review clean after ruling)
Task 2: dispatched (implementer haiku, BASE 46fd2fa) - recordTrail, recordTrailStrict, COVERAGE_FROM
Task 2: controller correction sent mid-task - my dispatch said "if the brief shows SYSTEM
  anywhere, that is stale, drop it", which was too broad. The brief's one SYSTEM mention
  (task-2-brief.md:228-232) is a correct comment recording WHY no such constant exists.
  Clarified: no SYSTEM constant and none in module.exports, but keep the comment verbatim.
Task 2: review - spec PASS, quality APPROVED. 1 Minor.
Task 2: minor (deferred): recordTrail(models, entry) / recordTrailStrict(models, entry) take
  models positionally, while every other service in src/ destructures { models, ... }. Raised
  by the reviewer, correctly, and it originates in MY frozen contract, not the implementer.
Task 2: Ruling: defer, with a rule rather than an accident. Writers take (registry, payload);
  readers take an options bag. getConsentTrail({ models, principalId, ... }) in this same file
  (Task 5) will follow the codebase convention, because it is a read with named options and it
  IS exported from src/index.js. recordTrail is an internal writer, never exported, always
  called with exactly two arguments whose roles are unambiguous. Weighed against changing it
  now: that costs a rewrite of both writers, buildDoc, 9 tests, and ~29 call sites already
  written into briefs 3, 4 and 8, plus a re-review - for a stylistic point with no correctness
  impact. Per the skill, Minor findings never enter the fix loop.
  Cost if wrong: one file carries two argument conventions. Mechanically fixable at any time,
  and the final whole-branch review sees this line and can triage it with every call site visible.
Task 2: reviewer's "cannot verify from diff" (did not run the suite; brief predicted 175, report
  claimed 177) - resolved: 177 is correct. The gate was corrected from 175 to 177 under the
  Task 1 ruling above, before this task was dispatched. Not a defect and not baseline drift.
Task 2: complete (commits 46fd2fa..91c7f4e, review clean)
Task 3: dispatched (implementer sonnet, BASE 91c7f4e) - instrument the consent write path
Task 3: DONE (commits 4a08e3a, 33ebaab). Suite 189/189 pass, 0 fail - matches the corrected gate.
Task 3: controller pre-check before review: verified decide() untouched in the diff,
  events.push unchanged, and the three instrumentation sites (persistPIIwithconsent.js:326,
  341, 364) sit after the E11000 catch closes, not inside decideFor. The double-write hazard
  I named in the dispatch did not materialise.
Task 3: implementer concern carried into review: principalActor(req) attributes
  role: "principal" on POST /consent, which is the one deliberately unauthenticated route.
  Asked the reviewer for an explicit opinion on whether that labels an identity the library
  has not verified. Not a correctness issue - the row's principalId comes from the resolved
  principal, not the actor - but it is a question about honest labelling on a trail whose
  whole value is honesty.
Task 3: review - spec PASS, quality APPROVED, 1 Important + 2 Minor.
Task 3: reviewer's opinion on the principalActor concern: defensible, do not block. actor.role
  classifies the KIND of caller rather than asserting a verified session; the row's principalId
  is derived independently from findOrCreatePrincipal/session resolution, never from actor, so
  a role label cannot forge a subject. Signup is definitionally the act of becoming a data
  principal. Accepted - no change. The residual is a documentation gap, recorded below.
Task 3: minor (deferred): fail-open tests emit two expected "[dpdp] trail write failed" stderr
  lines. Sanctioned by the brief; originates in Task 2's code, not this diff.
Task 3: minor (deferred) -> TASK 9: a trail READER has nothing telling them role "principal"
  spans both authenticated (PUT /consent) and pre-authentication (POST /consent) callers. Same
  label, two verification states. Task 9 owns documentation and should add one line.
Task 3: fix round 1/5 dispatched - Important: the E11000 double-write hazard is closed by
  inspection, not by a discriminating test. Asked for a test that forces the recovery branch
  AND for both-positions evidence (move the block inside decideFor, watch it fail with count 2,
  move it back, watch it pass with 1). A test that passes in both positions proves nothing.
Task 3: fix round 1/5 (1 addressed pending re-review, 0 open; commit 4d3423e). Suite 190/190.
  Implementer reported the both-positions proof: duplicated the instrumentation at both
  decideFor call sites, confirmed the new test AND ONLY that test failed with actual 2 /
  expected 1, reverted to an empty git diff, re-verified green.
Task 3: re-review - finding ADDRESSED (test/trailconsent.test.js:58-120). It forces the E11000
  collision deterministically by patching ConsentRecord.findOne to return null once, asserts
  exactly one consent_refused/prohibited_for_child row scoped by the collision call's own
  receiptId, and restores the patch in a finally. Both-positions evidence present and
  convincing. No new breakage.
Task 3: minor (deferred): test/trailconsent.test.js:26 imports findOrCreatePrincipal and never
  uses it. Out-of-scope observation from the re-review; no behavioural impact.
Task 3: complete (commits 91c7f4e..4d3423e, review clean after 1 fix round)
Task 4: dispatched (implementer sonnet, BASE 4d3423e) - instrument withdrawal, lifecycle,
  escalation and contact correction. Suite standing at 190 before this task.
Task 4: DONE (commits 03601cb, 4af1db6, c716996, 56757b2). Suite 204/204 - matches target.
Task 4: controller pre-check: fromStatus IS captured before `row.status = status`
  (requestLifecycle.js, with a comment stating why), and the contact-correction row stores
  only a fixed-vocabulary marker ("email" | "phone" | "email+phone") built by filtering a
  literal array, so it is enum-ish rather than caller-shaped and carries no PII.
Task 4: review - spec PASS, quality APPROVED. 0 Critical/Important, 1 Minor. All five named
  risks verified by the reviewer: fromStatus order (pinned by a two-step test matching on
  DESTINATION rather than array order, so it fails under a post-assignment capture bug); no PII
  on any new recordTrail call; the withdrawal write sits outside the `if (withdrawn.length)`
  save guard so a fully-refused call still records; all three lifecycle wrappers thread models;
  collapsing real and pinned by the 200-purpose test (1 row, count 200, no consentTypes).
Task 4: minor (deferred): principalId.js uses `actor || UNATTRIBUTED` while the other three
  files use `actor = UNATTRIBUTED`. The reviewer called this a real behavioural difference for
  `actor: null`. Ruling: it is NOT - I checked, and consentTrail.js buildDoc opens with
  `const source = entry.actor || UNATTRIBUTED`, so a null actor is normalised centrally
  whichever service passed it. The inconsistency is cosmetic only. Recorded so the final review
  is not misled by the stronger claim.
  Cost if wrong: none behavioural; two spellings of the same intent in four files.
Task 4: complete (commits 4d3423e..56757b2, review clean)
Task 5: dispatched (implementer sonnet, BASE 56757b2) - getConsentTrail and
  findConsentTrailByContact. Suite standing at 204 before this task.
Task 5: DONE (commits f36f734, dbe1947). Suite 217/217.
Task 5: review (opus) - spec PASS, quality APPROVED. 0 Critical/Important, 4 Minor.
Task 5: PARTITION VERDICT: HOLDS. Reviewer set-intersected the 11 stored KINDS against the 8
  derived kinds - empty. Then checked the one call that can fire both halves, a partially
  refused withdrawal (withdrawConsent.js:55-86): the loop is per-purpose and each `continue` is
  exclusive, so a purpose lands in record.events (derived) or a refusal bucket (stored), never
  both. escalation_refused is complementary to grievance_escalated (the case where escalatedAt
  was never written). No dedup pass anywhere - which is the whole point.
Task 5: minor (deferred): two separate require("../utils/validate") statements at
  consentTrail.js:2,4 - fold into one destructure.
Task 5: minor (deferred): byRecency (consentTrail.js:136-142) compares `ordinal` that is a
  String for stored rows and a Number for derived. Correct today only because sourceRank
  separates them first; a future kind collected at rank 0 with a numeric ordinal would silently
  disorder. Normalise to strings, or document that ordinals are only compared within a rank.
Task 5: minor (deferred, HIGHEST VALUE OF THE FOUR): no test exercises a PARTIALLY refused
  withdrawal - one purpose withdrawn, one refused in the same call. That is the strongest
  expression of the partition rule and the reviewer's own walk used it as the proof case, but
  only the all-refused and all-succeeded ends are tested. One assertion closes it: such a call
  yields one consent_withdrawn (derived) plus one withdrawal_not_applied (stored) naming
  disjoint consentTypes. Flagged for the final-review fix wave.
Task 5: minor (deferred): the PII property scan's "64-hex principalId" shape also admits any
  sha256, so the scan alone cannot distinguish a leaked contact hash from a principalId. Not a
  hole in practice - the adjacent erasure test scans every collection for lookupHash(email) and
  lookupHash(phone) literally. Add a cross-reference comment so a future editor does not delete
  the erasure test believing the shape scan covers it.
Task 5: reviewer verified, not a finding: MAX_SCAN cannot make truncated:false dishonest, and
  actor/role/channel being required:true means the un-compacted branch cannot emit a
  present-but-undefined key.
Task 5: complete (commits 56757b2..dbe1947, review clean)
Task 6: dispatched (implementer sonnet, BASE dbe1947) - GET /consent/trail and the
  contact-mismatch refusal. Suite standing at 217.
Task 6: DONE (commit e2d3fba). Suite 223/223.
Task 6: controller pre-check: route passes includeOperatorRefs:false and is ordered
  requireAuth, noStore, wrap; principalActor defined once and reused at 6 call sites with no
  re-inlining; assertOwnContact renamed to ownContactMismatch and kept SYNCHRONOUS, returning
  the mismatched fields instead of throwing (the rename is right - a function that returns
  rather than asserts should not be called assertX); the refusal row stores only
  count: mismatched.length, not which fields, which is more conservative than the brief asked.
  The noStore docstring fix is better than specified: instead of incrementing "six" to "eight"
  it removes the number, so the comment cannot drift again.
Task 6: review - spec PASS, quality APPROVED. 0 Critical/Important, 1 Minor (informational).
Task 6: CONTROLLER CORRECTION: I credited the implementer with the assertOwnContact ->
  ownContactMismatch rename. The reviewer checked and the brief's own Interfaces section and
  Step 8 specify that exact name and body, so it was plan-mandated, not implementer initiative.
  The noStore docstring fix (removing the count rather than incrementing it) does appear to be
  the implementer's own judgment. Recorded because misattributing work distorts any later
  judgement about scope creep.
Task 6: reviewer verified the withholding test is non-vacuous: it seeds a real
  operator_trail_read row carrying BOTH actor.ref and caseRef, asserts the row IS present in
  the response, asserts both fields absent via Object.hasOwn (not just === undefined), then
  cross-checks the same row with includeOperatorRefs:true to prove the stripping is the route's
  choice rather than an absence of data.
Task 6: minor (deferred): no test for GET /consent/trail with a hex-valid but never-created
  principalId. Unlikely by construction - principalId is always session-derived and there is no
  id-in-path lookup - but recorded.
Task 6: resolved the reviewer's "cannot verify from diff" myself: ran npm test on this
  checkout, 223 pass / 0 fail.
Task 6: complete (commits dbe1947..e2d3fba, review clean)
Task 7: dispatched (implementer sonnet, BASE e2d3fba) - extract src/http/shared.js. Pure
  refactor; its whole value is that all 223 existing tests stay green.
Task 7: DONE_WITH_CONCERNS (commit 7dce3d2). Suite 225/225 pass, 0 fail.
Task 7: CONTROLLER ERROR (mine, second of this kind). My dispatch asserted "this task adds no
  tests and must break none - 223 is your acceptance criterion". Wrong: the brief's Step 1
  appends two tests pinning shared.js's contract, and Step 9 states the criterion as "every
  pre-existing test still passes, plus the two added in Step 1" = 225. The implementer followed
  the brief - correctly, it is the requirements document - and flagged the discrepancy instead
  of silently resolving it, which is exactly the right behaviour. 225 is correct.
  PATTERN: this is the second time an implementer has corrected my arithmetic about a test gate
  (Task 1 was the 158-vs-160 baseline). Both times I asserted a number without reading the
  brief's own final step. Corrective action for Tasks 8 and 9: read the brief's last step and
  quote ITS number, rather than deriving one.
Task 7: the implementer's second concern is environmental, not code - mongodb-memory-server hit
  port collisions from an unrelated Spark/Java process on this machine; retries resolved it
  every time. Noted, no action.
Task 7: implementer confirmed the origin check and error mapper are byte-identical in logic
  against the pre-move code, verified line by line, with only wrapping syntax and the new
  factory docstring changed.
Task 7: review - spec PASS, quality APPROVED. 0 Critical/Important, 1 Minor (cosmetic, no fix).
  All five checkOrigin subtleties confirmed BYTE-IDENTICAL individually: GET/HEAD exemption;
  absence tested as undefined not falsiness; originHost collapsing "" and unparseable and the
  literal "null" to null; allowedOrigins as union not replacement; scheme-less entry compared
  as a bare host. All three error-mapper branches confirmed identical, and the new test pins
  errorMapper.length === 4, which is load-bearing for Express's error-handler detection.
  The new tests also assert closure independence between two makeCheckOrigin calls - exactly
  the bug a lazier refactor would introduce with a singleton re-reading a shared variable.
Task 7: minor (deferred, no fix needed): the new unit tests cover the literal "null" origin but
  not the present-but-empty Origin header or the ""-host case. The brief delegates breadth to
  the seven pre-existing end-to-end origin tests, which this diff leaves untouched.
Task 7: resolved the reviewer's "cannot verify from diff" myself: npm test = 225 pass, 0 fail.
Task 7: complete (commits e2d3fba..7dce3d2, review clean)
Task 7: Ruling: corrected the Task 8 suite gate in plan.md from 236 to 237, MEASURED rather
  than derived. Task 3 contributes 13 tests, not the planned 12 - its review fix round added
  the E11000 test. This is the corrective action from my two earlier counting errors applied:
  I ran npm test (225), added the brief's own stated delta (12), and wrote 237.
  Cost if wrong: the last gate in the plan is off by a small integer; it is a drift detector,
  not an acceptance criterion.
Task 8: dispatched (implementer sonnet, BASE 7dce3d2) - createBackOfficeRouter. Suite at 225.
Task 8: DONE (commit b5dc25c). Suite 237/237 - matches my measured correction exactly, which
  confirms the plan's derived 234 was the stale figure and 237 is right.
Task 8: review (opus, adversarial) - spec PASS, quality APPROVED, all SEVEN named risks PASS:
  no-disclosure-without-a-record on both routes (the forcing test reads res.text() and asserts
  the body carries neither the principalId nor timeline data, plus attempted === 2 to prove the
  write is on both paths); mutual exclusion (consentTrail.js buildDoc builds from an explicit
  field whitelist, so no payload field can carry a contact hash even by a later edit); hostile
  resolveOperator (a `reads === 1` test fails on any re-read of the property); injection (every
  guard precedes the first Mongo call, asserted for all three body fields); enumeration (an
  erased principal returns the same 404 as a never-existed id, so erasure is not an oracle);
  the boot guard (plain Error, unmappable, with false/"true"/1/null each tested); containment
  (a test proves both back-office paths 404 on createRouter and record nothing).
Task 8: Ruling: the Important finding IS entering the fix loop, against the reviewer's own
  suggestion to defer it to the whole-branch review. POST /principals/trail always writes
  outcome:"recorded", so an access row for a principalId with nothing behind it is
  indistinguishable from a row for a real disclosure - an auditor cannot tell a disclosure from
  a probe. The lookup route already solves this with reasonCode:"no_match", so the route that
  discloses the WHOLE record is the weaker record while the route that discloses one bit is the
  stronger. The shape came from the brief, which makes it plan-mandated and mine to rule on;
  I weighed it against the plan text and the spec wins - the feature exists to tell an auditor
  what happened. Fix specified: move findPrincipalById above recordTrailStrict and set
  outcome/reasonCode from whether the principal exists, with D7 preserved (the record still
  precedes every response, including the 404).
  Cost if wrong: a reordering on the disclosure path. Mitigated by requiring the existing
  forcing test to keep passing unchanged.
Task 8: minor (deferred, FOR BRANCH REVIEW): findPrincipalById is a partly redundant round trip
  against getConsentTrail, which already 404s - but the route is STRICTER, so it 404s where a
  ConsentRecord survives without a Principal. That is the documented orphaned-ledger residual,
  and in that case the back office loses its read of the surviving pseudonymous evidence -
  exactly the case the design says matters most. Confirm at branch level.
Task 8: minor (deferred): readCaseRef treats null as absent where assertOpaqueRef would reject
  it. Harmless (no field written) but quiet permissiveness in a validator whose job is refusal.
Task 8: minor (deferred): caseRef is optional, so the "why" of an access can be omitted, and
  its opaque charset is still an operator-controlled channel. Same residual class validate.js
  already documents for actor.ref; not introduced here.
Task 8: fix round 1/5 dispatched - Important: distinguish a probe from a disclosure.
Task 8: fix round 1/5 (1 addressed, 0 open; commit 80bb20a). Suite unchanged at 237 - the fix
  strengthened two existing assertions rather than adding tests, which is the right shape.
Task 8: re-review - finding ADDRESSED, a probe now records outcome:"refused"/no_match and a
  real disclosure records outcome:"recorded" with no reasonCode, both pinned by test
  assertions. "No disclosure without a record" INTACT: all three exit paths traced - the 404 is
  thrown after the record write, getConsentTrail runs only after it succeeds, and a forced
  write failure still 503s with no principal data. Enum validity CONFIRMED: "refused" is in the
  outcome enum and "no_match" in reasonCode. No new breakage.
Task 8: complete (commits 7dce3d2..80bb20a, review clean after 1 fix round)
Task 9: dispatched (implementer sonnet, BASE 80bb20a) - public exports and the documentation
  this feature falsifies. Suite at 237; this task asserts "all tests pass" rather than a count,
  since it adds no behaviour and test/index.test.js is updated inside the task.
Task 9: DONE (commits 8d480b4, 5d7b2bc). Suite 237/237.
Task 9: review - spec PASS, quality APPROVED. 1 Important, refuted below. All four named risks
  verified: the principalId claim is scoped to createRouter's routes with the four-condition
  carve-out argued and matching backOfficeRouter.js point for point (reviewer grepped router.js
  for body.principalId / query.principalId - zero hits); no completeness-claim leakage
  (grepped the diff for complete/comprehensive/guarantee/ensures - only correct negations);
  all three carried-forward items present and correct, including Step 13, which makes Task 1's
  shipped JSDoc true; and both erasure notes updated in matching language stating the trail is
  written to, edited and deleted from by erasure exactly never.
Task 9: Ruling: the Important finding is REFUTED, and applying its proposed fix would have
  introduced a defect. It claimed src/index.js's "the consent ledger and the five other
  collections" miscounts and should read "four other". I counted the collections getConsentTrail
  actually queries: ConsentRecord, Principal, RightsRequest, Grievance, ConsentManagerRequest
  AND TrailEntry - six. The reviewer's own enumeration omitted TrailEntry, the collection the
  trail is stored in. So the ledger plus five others is correct and the comment stands.
  The finding did surface a REAL inconsistency, in the other direction: spec.md:124 said the
  trail is a "merged read across five sources", which is the number that is wrong. Corrected
  the spec to name all six explicitly rather than carry a count that invited this confusion.
  Cost if wrong: a code comment and a design doc would disagree about a collection count. Low,
  and now both enumerate rather than count.
Task 9: reviewer's "cannot verify from diff" (ran only test/index.test.js, 3/3) - the full
  suite at 237 was verified by me before this task and by the implementer after it.
Task 9: complete (commits 80bb20a..5d7b2bc, review clean after ruling)

ALL NINE TASKS COMPLETE. Suite 158 -> 237. Next: whole-branch review, then ADR, then handbook.

WHOLE-BRANCH REVIEW (opus): READY WITH FIXES. Suite independently confirmed 237.
  Important 1: DERIVED_ACTOR stamped role:"principal" on every derived entry including
    principal_erased - but erasePrincipalPII is unmounted and always fiduciary-side, so the
    trail attributed the fiduciary's erasure to the data principal. The reviewer turned the
    design's own principle on it: the branch refuses to invent a timestamp nobody observed and
    should not invent an actor nobody observed either. Fixed to unattributed.
  Important 2: MY Task 8 ruling caused this. I fixed the trail route to distinguish a probe
    from a disclosure and did not check the lookup route, which still recorded a miss as
    "recorded". Both routes now carry the identical expression.
  Triage: 10 of 12 deferred minors carried, 2 fixed. The findPrincipalById concern I escalated
    was checked and found UNREACHABLE - nothing in src/ deletes a Principal and erasure keeps
    the document, so a ConsentRecord cannot outlive its Principal. No evidence is lost.
  CONTROLLER ERROR: deferred-and-rulings.txt was truncated mid-line on every row, because I
    grepped single lines out of multi-line ledger entries. The reviewer said plainly it could
    not read six of the eight rulings and declined to endorse them - the right response to
    unreadable input. Rebuilt with continuations (117 lines).
BRANCH FIX WAVE: 4 commits (bdcfb2d, 6672879, 1801585, fe4286d). Suite 237 -> 238.
BRANCH RE-REVIEW: all findings ADDRESSED, no new breakage, MERGE VERDICT READY.
  "No disclosure without a record" INTACT on both routes after the reorder. The partition test
  is DISCRIMINATING (asserts exact per-side counts AND disjointness, not just that two rows
  exist). The ?limit= guard is SOUND: req.query is not covered by the body-parser hardening,
  but Number({$ne:"1"}) is NaN and assertLimit 400s it before the read, pinned by a loop over
  five hostile values. Both implementer judgment calls upheld.

Remaining: ADR, then docs/handbook/, then the PR against issue #4.
