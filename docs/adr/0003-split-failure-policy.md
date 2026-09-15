# 0003 - Instrumentation writes fail open; back-office disclosure writes fail closed

Date: 2026-09-04
Status: Accepted
Context: [design spec](../superpowers/plans/2026-09-04-consent-audit-trail/spec.md) section 8.2

## Context

When a trail write fails, does the underlying act fail with it?

Both answers are defensible and both are wrong somewhere. Fail closed everywhere
and a consent grant that cannot be audited is refused - so the audit feature can
take down consent capture, which is the one thing that must work. Fail open
everywhere and the act succeeds while the trail silently has a hole, which makes
it unreliable as evidence, which is the whole point of building it.

The repository already answers this question twice, in opposite directions, with
its reasoning attached. A throw from `onWithdrawal` **does** fail the request,
because that hook is how the host learns it must cease processing and erase, and
a host whose pipeline is down needs to know. A throw from `onGrievanceFiled`
**does not**, because the grievance is already filed and failing the response
would cost the data principal their reference number and produce a duplicate
filing - notification is not the filing.

## Decision

Split the policy along the same seam, and let each half inherit the existing
precedent.

**Instrumentation writes fail open.** `recordTrail(models, entry)` never throws.
A failure logs `err.name` and `err.code` - never `err.message`, which quotes a
caller-supplied value back - and the underlying act proceeds. The trail must
never take down consent capture, a withdrawal, or the refusal message a data
principal needs to read. Turning `persistPIIwithconsent`'s 422 into a 500 would
leave a minor with no explanation of why they were refused, which is precisely
the class of defect the earlier audit remediation existed to close.

**Back-office disclosure writes fail closed.** `recordTrailStrict(models, entry)`
throws `AppError(..., 503)`. Both back-office routes write their access record
*before* returning anything, on every path including the 404. If the record
cannot be written, the disclosure does not happen. No record, no disclosure.

## Consequences

**The design makes no completeness claim, and the documentation must not either.**
The trail is evidence of what was recorded, not proof that nothing else happened.
That is the same register the README already uses for "recorded", never "sent" -
a `200` is not proof the Board was notified. An earlier draft of the spec shipped
both a fail-open policy and a "complete by iteration" read contract; they cannot
both be true, and the completeness claim is the one a consumer would act on, so
it was deleted.

The asymmetry is visible in the code and has to stay that way. `recordTrail`
builds its document *inside* the try, so a malformed `caseRef` is swallowed;
`recordTrailStrict` builds it *outside*, so the same malformed value surfaces as
a 400 to the caller who supplied it rather than being masked as a 503 write
failure. Only a genuine write failure produces the 503, which is what makes "no
record, no disclosure" mean something.

Ordering on the back-office routes is load-bearing and separately tested. Reading
the principal is not a disclosure; it is what lets the record say truthfully
whether an operator saw a lineage or merely probed an id that matched nobody. So
the lookup happens first, the record is written with an outcome derived from it,
and only then does the route answer - including when the answer is a 404.

## Alternatives rejected

**Fail closed everywhere.** Makes the audit feature capable of taking down
consent capture and of replacing an informative 4xx with an opaque 500 in front
of a data principal.

**Fail open everywhere.** Would leave the back office able to disclose a named
person's entire lineage with no counter-record - an unaudited people-search,
which is worse than no people-search. The irony of an unaudited read of the audit
trail is the reason this half exists at all.

**A host-supplied `onTrailWrite` hook, mirroring `onWithdrawal`.** Tempting given
the precedent, but the hook is fire-and-forget from the library's view: a host
that forgets to implement it leaves no record and no signal that none exists.
