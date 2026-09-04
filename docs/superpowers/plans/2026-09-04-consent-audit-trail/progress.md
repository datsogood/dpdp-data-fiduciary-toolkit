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

Not started.

| Exec | Task | Deliverable | State |
| --- | --- | --- | --- |
| 1 | T1 | `TrailEntry` model, registry line, `assertOpaqueRef` | pending |
| 2 | T2 | `recordTrail`, `recordTrailStrict`, `COVERAGE_FROM` | pending |
| 3 | T3 | Instrument the consent write path | pending |
| 4 | T4 | Instrument withdrawal, lifecycle, escalation, contact correction | pending |
| 5 | T5 | `getConsentTrail`, `findConsentTrailByContact` | pending |
| 6 | T6 | `GET /consent/trail`, contact-mismatch refusal | pending |
| 7 | T7 | Extract `src/http/shared.js` | pending |
| 8 | T8 | `createBackOfficeRouter` | pending |
| 9 | T9 | Public exports and documentation | pending |

Then, outside the plan: code review, ADR, and `docs/handbook/`.
