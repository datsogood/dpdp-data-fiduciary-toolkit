# DPDP audit remediation

Everything for this piece of work lives in this folder: the spec that defines it, the plan that sequences it, and one brief and report per task.

Started 2026-08-07, against commit `6c98d19`.

## Contents

| File | What it is |
| --- | --- |
| [`spec.md`](spec.md) | The audit. 43 findings across security, correctness, DPDP legal fidelity and repo hygiene, plus an obligation coverage map. This is the requirements document - every task closes findings named here. |
| [`plan.md`](plan.md) | The implementation plan. 14 tasks, 117 line items, with the exact code and tests for each. |
| [`progress.md`](progress.md) | The ledger. Append-only record of what completed, every review finding, every ruling, and every controller error. This is the recovery map if context is lost. |
| [`tasks/`](tasks) | Per task: the brief handed to the implementer, and the report it wrote back. |

## How to read it

Start with `spec.md` section 2 for the findings and section 4 for the suggested order. Then `plan.md`'s Global Constraints, which bind every task. `progress.md` tells you where execution actually got to, which is more reliable than any summary.

## Execution order

Not task-number order. Task 5 runs after 7 and 9, because its end-to-end consent tests cannot pass while the consent service is mid-refactor.

```
1 -> 2 -> 3 -> 4 -> 6 -> 7 -> 9 -> 5 -> 8 -> 10 -> 11 -> 12 -> 13 -> 14
```

## Status

7 of 14 tasks complete. 64 tests passing.

| Exec | Task | Closes | State |
| --- | --- | --- | --- |
| 1 | T1 hygiene, packaging, license | H12, M12, M13, L1, L4, L7, L9, L10, L12 | done |
| 2 | T2 harness, validation, NoSQL injection | C2, M14 | done |
| 3 | T3 isolated connection and model registry | H8, M10 | done |
| 4 | T4 PII/ledger split, random principalId | H9, H10, L11, C1 (identity) | done |
| 5 | T6 lawful basis model | H1, L5, M3 | done |
| 6 | T7 non-destructive consent writes | C3, M4, M5, M7, M9 | done |
| 7 | T9 age gate and parental consent | H4 | in review |
| 8 | T5 authentication hook, default-deny | C1 (authorisation), M8, M6 | pending |
| 9 | T8 Section 5 notice capture | H3, L6 | pending |
| 10 | T10 read path | C4 | pending |
| 11 | T11 request lifecycle transitions | H11, L3, L8 | pending |
| 12 | T12 HTTP layer | H5, H7, M1, M2, M11, L2 | pending |
| 13 | T13 browser surface | H6 | pending |
| 14 | T14 docs sync and suite completion | M15 | pending |

Not closed by this plan, and stated as such rather than quietly dropped: **H2** (cessation and erasure on withdrawal) ships as a hook plus an erasure primitive, because the library cannot notify a processor it does not know about. **M14**'s rate-limiting half is host middleware. **M13** is documented, not fixed - `npm install <git-url>` still fails while `package.json` sits in a subdirectory.

## Conventions

- **Review diffs are not committed.** They are derived from git, regenerable, and 20-80KB each. They stay in the gitignored `.superpowers/sdd/` scratch area.
- **One folder per plan**, named `YYYY-MM-DD-<slug>`, under `docs/superpowers/plans/`.
- Task briefs are extracted from `plan.md`, so `plan.md` is the single source of task requirements. If a brief and the plan disagree, the plan wins and the brief is stale - regenerate it.
