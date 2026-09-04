# Consent audit trail

Everything for this piece of work lives in this folder: the spec that defines it, the plan that sequences it, and one brief and report per task.

Started 2026-09-04, against commit `befffe6`, on branch `feat/consent-audit-trail`.
Closes [issue #4](https://github.com/datsogood/dpdp-data-fiduciary-toolkit/issues/4) - the PR references it; the reviewer closes it.

## Contents

| File | What it is |
| --- | --- |
| [`spec.md`](spec.md) | The design. What the trail captures, what it deliberately does not, the data model, the read and write contracts, and the residual risks. This is the requirements document - every task implements something named here. |
| [`plan.md`](plan.md) | The implementation plan. Tasks, with the exact code and tests for each. |
| [`progress.md`](progress.md) | The ledger. Append-only record of what completed, every review finding, every ruling, and every controller error. This is the recovery map if context is lost. |
| [`tasks/`](tasks) | Per task: the brief handed to the implementer, and the report it wrote back. |

## How to read it

Start with `spec.md` section 4 - the partition rule. Everything else in the design falls out of it, and a reader who skips it will not understand why the trail stores refusals but derives grants. Then section 2 for what is broken today, and section 12 for what this work does not fix.

## The problem in one line

The toolkit can answer "what did this person end up consenting to". It cannot answer "what did this person do, and what did we tell them" - which is the question a Grievance Officer, a Section 11 access request, and the Data Protection Board all actually ask.

## Status

Design complete and adversarially reviewed. Plan not yet written.

| Stage | State |
| --- | --- |
| Design | done - `spec.md` |
| Design review | done - three adversarial lenses (DPDP fidelity, security, simplicity), then a second pass against the written spec |
| Plan | pending |
| Plan review | pending |
| Build | pending |
| Code review | pending |
| ADR | pending |
| Handbook (`docs/handbook/`) | pending |

## Conventions

Inherited from [`2026-08-07-dpdp-audit-remediation`](../2026-08-07-dpdp-audit-remediation/README.md), which established them. The ones that bind this work:

- **One folder per plan**, named `YYYY-MM-DD-<slug>`, under `docs/superpowers/plans/`.
- **Writing style:** always a hyphen ( - ). Never an em dash or en dash. Applies to code comments, prose, docs and commit messages.
- **Statute citations:** the Act is the **Digital Personal Data Protection Act, 2023**. The DPDP Rules, 2025 are a separate instrument, cited by their own name.
- **Review diffs are not committed.** They stay in the gitignored `.superpowers/sdd/` scratch area.
- **Task briefs are extracted from `plan.md`,** so `plan.md` is the single source of task requirements. If a brief and the plan disagree, the plan wins and the brief is stale.
- **Test commands:** `npm test` runs the whole suite. To run one file, invoke it directly: `node --test --test-global-setup=scripts/test-setup.js test/trail.test.js`. Never `npm test -- test/<file>` - npm appends the argument and produces a broken two-path form.
- **Working directory:** paths in `spec.md` and `plan.md` are relative to `data-fiduciary-toolkit/` unless prefixed with `repo-root:`.
