# 0001 - The consent trail stores only what is destroyed elsewhere

Date: 2026-09-04
Status: Accepted
Context: [issue #4](https://github.com/datsogood/dpdp-data-fiduciary-toolkit/issues/4), [design spec](../superpowers/plans/2026-09-04-consent-audit-trail/spec.md)

## Context

The toolkit could answer "what did this person end up consenting to". It could
not answer "what did this person do, and what did we tell them" - which is the
question a Grievance Officer, a Section 11 access request, and the Data
Protection Board all actually ask.

`ConsentRecord.events` had exactly two writers. Twelve of the fourteen write
sites in `src/` appended nothing to it. So a filed rights request, an escalation
to the Board, an erasure, a contact correction, and every refusal and silent
no-op left no trace on any timeline. Worse, three of those destroy their own
history: `requestLifecycle.js` overwrites `status` in place, `updatePrincipalContact`
overwrites the stored `emailHash`, and `lastNotice.shownAt` is a single mutable
field.

The obvious design is a second collection that records everything, with a
deduplication pass over the merged read so an act recorded in two places is not
reported twice. We wrote that first. The dedup layer came to about 120 lines and
existed entirely because the design had never decided whether an act the ledger
already records should also write a trail row.

## Decision

**The trail stores only facts that are destroyed, or never written, anywhere
else. Everything a read can recover from a primary collection is derived at read
time and never copied.**

Derived, because each already has a real observed timestamp: consent grants,
denials and withdrawals from `ConsentRecord.events[].timestamp`; a filed rights
request from `RightsRequest.createdAt`; a filed grievance from
`Grievance.createdAt`; an escalation from `Grievance.escalatedAt`; a
consent-manager handoff from `ConsentManagerRequest.createdAt`; an erasure from
`Principal.erasedAt`.

Stored, because nothing else survives: consent and withdrawal refusals, silent
no-ops, request status transitions, escalation refusals, contact corrections,
age-gate refusals, the contact-mismatch 403, and back-office access records.

We do not reconstruct a fact whose timestamp nobody observed. A request that
moved `received -> in_progress -> closed` cannot have its middle transition
inferred from `updatedAt`, which is why transitions are stored rather than
derived. Inventing a timestamp would be manufacturing evidence, which is the one
thing an audit trail must never do. The same rule was later applied to actors:
a derived entry carries `role: "unattributed"`, because its source collection
recorded what happened and not who did it.

## Consequences

Double-reporting is impossible **by construction** rather than by a pass. The
120-line dedup layer was deleted. A reviewer verified the stronger claim by
set-intersecting the eleven stored kinds against the eight derived kinds - empty -
and then checking the one call that can fire both halves, a partially-refused
withdrawal, where the per-purpose loop makes them mutually exclusive.

Volume stays bounded by state change rather than by activity, so the embedded
`ConsentRecord.events` array is never at risk of the 16MB BSON ceiling, and no
cursor, sequence number or compound index is needed. The read is a plain
equality filter with `.sort()` and `.limit()`, which matters because
`sanitizeFilter` makes `{at: {$gte: d}}` and the query-builder spellings
`.where("at").gt(d)` and `.gt("at", d)` all CastError - verified empirically. The
only escapes are `mongoose.trusted()` and `aggregate()`, and `trusted()` is a
total bypass of the connection's one structural injection guard.

The cost: a trail read touches six collections rather than one, and the merge
and its ordering tiebreak live in application code. The tiebreak is real rather
than theoretical - `persistPIIwithconsent` stamps every event of one submission
with the same instant and `consentEventSchema` is `{_id: false}`, so a signup
granting three purposes produces three entries with identical timestamps and no
id to fall back on.

One input is not bounded by the rule: operator access rows are filed under the
**subject's** `principalId`, so a principal's stored rows scale with back-office
activity rather than with their own acts.

## Alternatives rejected

**Extend `ConsentRecord.events` with new statuses.** Its enum is three values
with a documented charter, its subdocuments are `{_id: false}` so an event is not
addressable, 23 tests assert on it, and `test/auth.test.js` byte-compares
`JSON.stringify` of it. Activity-driven growth would also put the BSON ceiling on
the one document that must never fail to write.

**Record everything, dedup on read.** Rejected for the reason above: the dedup
layer is the cost of an unmade decision, and a dedup bug reports an act twice or
hides one, both of which corrupt evidence.

**Reconstruct history from `updatedAt` and current state.** Rejected as
manufacturing evidence.
