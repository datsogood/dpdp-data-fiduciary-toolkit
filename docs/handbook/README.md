# The `dpdp-fiduciary-toolkit` handbook

This handbook is for a new teammate joining the team that maintains this
toolkit - a Node/Express/Mongoose reference implementation of a data
fiduciary's obligations under India's **Digital Personal Data Protection Act,
2023**. It assumes you can read JavaScript. It does not assume you have ever
read the Act, so it starts there. Six chapters, each written to be read on its
own once you have the vocabulary from Chapter 1, covering the law in plain
words, how the code models it, why the audit trail is a separate collection,
six worked scenarios run against the real code, how to deploy and operate it,
and a glossary plus the questions a newcomer actually asks.

This handbook documents package version **0.2.0** (`data-fiduciary-toolkit/package.json`).

## The chapters

| # | Title | Covers | Reading time |
| --- | --- | --- | --- |
| 1 | [What consent actually means here](01-what-is-consent.md) | The Act's vocabulary and rules - lawful basis, notice, withdrawal, rights, children - with no code at all. | ~20 min |
| 2 | [How this toolkit models consent](02-how-the-toolkit-models-it.md) | Where each duty from Chapter 1 lives in `src/`: identity, the consent catalog, notices, the event ledger, erasure. | ~30 min |
| 3 | [The consent audit trail](03-the-audit-trail.md) | What the trail is, the partition rule that shapes it, and why it is a collection separate from the ledger. | ~25 min |
| 4 | [Six things that happen, start to finish](04-walkthroughs.md) | Six scenarios - signup, a refused withdrawal, a mixed one, a grievance, a back-office lookup, an erasure - run end to end against the real code, with real request and response bodies. | ~35 min |
| 5 | [Running it, and what it will not do for you](05-running-it.md) | Installing, configuring, mounting both routers, the hooks you must supply, and the deliberate gaps that become your integration's job. | reference |
| 6 | [Glossary, and questions people actually ask](06-glossary-and-questions.md) | An alphabetical dictionary of terms, and the questions every newcomer asks in their first fortnight, answered properly. | reference |

## Start here

Read chapters 1 through 4 in order on day one. Chapter 1 needs no code
background at all - read it first even if you are mid-onboarding and have not
opened `src/` yet. Chapters 2 through 4 build on it directly and are easiest to
follow in sequence, ending with Chapter 4's six scenarios, which is the fastest
way to see the whole system work.

Chapters 5 and 6 are not meant to be read straight through. Chapter 5 is the
one to open when you are deploying this, debugging a boot failure, or writing
an integration - come back to it then. Chapter 6 is the one to open mid-task
when a term in a pull request or a standup does not land, or when you want the
short answer to a specific question ("why does the back-office trail read use
POST?", "can I trust the trail to be complete?").

## Going deeper

This handbook explains what the code does and why, at the level a newcomer
needs. For the full design reasoning behind the audit trail - the alternatives
considered, the failure-mode analysis, why it turned out to be four ADRs
instead of one - read:

- The design spec: [`docs/superpowers/plans/2026-09-04-consent-audit-trail/spec.md`](../superpowers/plans/2026-09-04-consent-audit-trail/spec.md)
- The decision records: [`docs/adr/`](../adr/)

## One rule

This handbook describes the code as it stands. If the two ever disagree, the
code is right and the handbook is a bug - open an issue or send a fix.
