# Architecture decision records

One file per decision that was expensive to make and would be expensive to reverse.

An ADR is not a design doc and not a changelog. It records **why** a choice was
made, **what was rejected**, and **what it costs** - so that someone who was not
in the room can tell a deliberate decision from an accident, and can reopen it
knowingly rather than by stumbling into it.

Write one when a decision constrains future work, has a defensible alternative,
or is the kind of thing a newcomer would otherwise undo without realising what
it was load-bearing for. Do not write one for a choice with an obvious answer.

## Format

Context, Decision, Consequences, Alternatives rejected, Status. Prose over
bullets where the reasoning matters. Always a hyphen ( - ), never an em dash.

Statutory references are to the **Digital Personal Data Protection Act, 2023**.
The DPDP Rules, 2025 are a separate instrument, cited by their own name.

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-consent-trail-partition-rule.md) | The consent trail stores only what is destroyed elsewhere, and derives the rest at read time | Accepted |
| [0002](0002-pii-keyed-retrieval-surfaces.md) | PII-keyed retrieval ships as an unmounted function plus a separate back-office router, never on the principal-facing one | Accepted |
| [0003](0003-split-failure-policy.md) | Instrumentation writes fail open; back-office disclosure writes fail closed | Accepted |
