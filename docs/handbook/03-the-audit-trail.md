# 3. The consent audit trail, and why it is a separate collection

File paths in this chapter are relative to `data-fiduciary-toolkit/` unless they
start with `docs/`.

## The question the toolkit could not answer

`GET /consent` tells you what Asha ended up consenting to. Marketing: yes.
Analytics: no. Underwriting: yes, granted on the 14th.

That is a useful answer, and it is not the answer anyone actually asks for.

A Grievance Officer gets a call: "I withdrew that months ago." A Section 11
access request arrives: "send me everything you have about what I did on your
site." The Data Protection Board writes and asks why a complaint sat for
sixty days. All three are asking the same thing, and it is not the current
state:

> **What did this person do, and what did we tell them?**

The consent ledger cannot answer that, because it only records the things that
worked. Asha's withdrawal request that we refused is not in it. The re-grant
she submitted that we quietly ignored is not in it. The moment her grievance
went from "open" to "in progress" is not in it - and worse, that moment is not
anywhere, because the code overwrote it.

This chapter is about the collection and the read that close that gap.

## The problem, concretely

`ConsentRecord.events` is the consent ledger. It is append-only and it is good
at its job, but it has exactly two writers: `persistPIIwithconsent` and
`withdrawConsent`. Twelve of the fourteen write sites in `src/` appended
nothing to it.

Here is what that meant in practice, before this work. Each row is a real act
by a real person that produced no timeline entry anywhere:

| What happened | Where | What survived |
| --- | --- | --- |
| Asha asks to withdraw `kyc_reporting`. It rests on a Section 7(d) legal obligation, so we refuse. | `src/services/withdrawConsent.js` | Nothing. `save()` is skipped entirely, so not one byte changes. |
| Asha withdraws a purpose she never granted. | `src/services/withdrawConsent.js` | Nothing. |
| Asha re-submits consent for marketing without `regrant: true`. She gets a `200` and a receipt. | `src/services/persistPIIwithconsent.js` | Nothing. The receipt names no event, because there was no event. |
| A 16-year-old's submission asks for `marketing`, which the catalog prohibits for children. We refuse that purpose. | `src/services/persistPIIwithconsent.js` | Nothing. It came back in the response body and was never persisted. |
| A minor with no verifiable parental consent is refused outright with a `422`. | `src/services/persistPIIwithconsent.js` | Nothing. It is thrown before any write, by design, so no `Principal` exists to hang it off. |
| Asha's grievance goes `open -> in_progress -> resolved`. | `src/services/requestLifecycle.js` | **Only `resolved`.** `row.status = status` overwrites in place and `updatedAt` remembers only the last change, so a grievance that was worked on looks identical to one that jumped straight to closed. |
| Asha corrects her email address. | `src/utils/principalId.js` | **The new address only.** The old `emailHash` is overwritten and destroyed. |
| Someone signs in as Asha and submits a different person's email on `PUT /consent`. We refuse with a `403`. | `src/http/router.js` | Nothing. |
| Asha escalates her grievance to the Board, and we refuse because the SLA has not lapsed yet. | `src/services/complaintToTheBoard.js` | Nothing. |
| Back-office staff look up a data principal and read their whole record. | nowhere | Nothing. There was no access log of any kind. |

Two of those are worth separating out, because they behave differently.

A grievance **escalated** to the Board and a principal's PII **erased** were
not lost. `Grievance.escalatedAt` and `Principal.erasedAt` were both being
written, with real timestamps. What was missing was any read that put them on a
timeline beside everything else. That distinction turns out to be the whole
design.

## The partition rule

Everything in this feature falls out of one sentence:

> **The trail stores only facts that are destroyed, or never written, anywhere
> else. Everything a read can recover from a primary collection is derived at
> read time, and is never copied.**

An escalation already has an observed timestamp on the grievance document, so
the trail reads it from there. A refused withdrawal has no timestamp anywhere,
so the trail stores one.

### Why this matters more than it sounds

The obvious design is the other one: a second collection that records
everything, plus a pass over the merged read that removes an act appearing
twice. We wrote that first. The deduplication layer came to about 120 lines,
and it existed entirely because nobody had decided whether an act the ledger
already records should also write a trail row.

Deciding it deletes the layer. Under the partition rule, **double-reporting is
not prevented, it is impossible** - not because a check catches duplicates, but
because there is nowhere for a duplicate to come from. The eleven stored kinds
and the eight derived kinds are disjoint sets. Nothing writes into both halves
for the same act.

That is a much stronger property than "we dedupe carefully". A dedup bug either
reports an act twice or hides one, and both corrupt evidence. A partition has
no bug to have.

### The other half of the rule

We do not reconstruct a fact whose timestamp nobody observed.

A grievance that moved `open -> in_progress -> resolved` cannot have its middle
transition inferred from `updatedAt`. You could guess. You must not. Inventing
a timestamp is manufacturing evidence, which is the one thing an audit trail
must never do. That is why transitions are **stored** rather than derived -
storing them at the moment they happen is the only honest option.

The same reasoning applies to actors. Every derived entry carries
`actor: { role: "unattributed", channel: "library" }`, because its source
collection recorded what happened and never recorded who did it.
`unattributed` is not a polite synonym for "system". It means the library
genuinely does not know, and saying anything else would be a claim it cannot
back.

The full argument is in
`docs/adr/0001-consent-trail-partition-rule.md`.

## What is stored, and what is derived

Read these against `src/services/consentTrail.js` - `getConsentTrail` is the
single function that does both halves.

### Derived at read time (never copied)

| Act | Source of truth | Kind on the timeline |
| --- | --- | --- |
| Consent granted | `ConsentRecord.events[].timestamp` | `consent_granted` |
| Consent denied | `ConsentRecord.events[].timestamp` | `consent_denied` |
| Consent withdrawn | `ConsentRecord.events[].timestamp` | `consent_withdrawn` |
| Rights request filed | `RightsRequest.createdAt` | `rights_request_filed` |
| Grievance filed | `Grievance.createdAt` | `grievance_filed` |
| Grievance escalated to the Board | `Grievance.escalatedAt` | `grievance_escalated` |
| Consent-manager handoff requested | `ConsentManagerRequest.createdAt` | `consent_manager_requested` |
| PII erased | `Principal.erasedAt` | `principal_erased` |

One `Grievance` document can produce two entries: filing and escalating are
separate acts with separate observed moments, and the document stores both.

### Stored in `trailentries` (nothing else survives)

| Act | Why it cannot be derived |
| --- | --- |
| Consent refusals and silent no-ops | No document is written at all |
| Withdrawal refusals and no-ops | `save()` is skipped entirely |
| Request status transitions | The prior status is overwritten in place; `updatedAt` holds only the last change |
| Escalation refusals | Nothing is written |
| Contact corrections | The old contact hash is overwritten and destroyed |
| Age-gate refusals | Thrown before any write, so no subject document exists |
| The own-contact `403` on `PUT /consent` | Throw only |
| Back-office lookups and trail reads | Nothing anywhere records a disclosure |

The trail read touches six collections rather than one - `ConsentRecord`,
`Principal`, `TrailEntry`, `RightsRequest`, `Grievance` and
`ConsentManagerRequest`, all in parallel. That is the price of the rule, and it
is cheap: under the partition rule a principal's stored rows are single digits.

## The eleven kinds

The stored vocabulary is closed. The schema in `src/models/TrailEntry.js`
enforces it, so a host cannot invent a twelfth. Here is what each one means to
a person reading a timeline.

| Kind | In plain words | Outcome | Written by |
| --- | --- | --- | --- |
| `consent_not_applied` | You submitted consent for a purpose you already had, without asking us to re-grant it. We returned `200` and changed nothing. | `no_change` | `persistPIIwithconsent.js` |
| `consent_refused` | We would not record a consent decision: the purpose is prohibited for a child, or the record has been erased and erasure is terminal. | `refused` | `persistPIIwithconsent.js`, `router.js`, `principalId.js` |
| `withdrawal_not_applied` | You asked to withdraw something and it did not happen: the purpose does not rest on consent, or you never had it, or you named a purpose we do not recognise. | `refused` or `no_change` | `withdrawConsent.js` |
| `age_gate_refused` | We turned away a submission for someone under 18 because there was no verifiable parental consent. | `refused` | `persistPIIwithconsent.js` |
| `request_status_changed` | A rights request, grievance or consent-manager request moved from one status to another. **This row is the only place the previous status still exists.** | `recorded` | `requestLifecycle.js` |
| `escalation_refused` | You tried to take a grievance to the Board and we stopped you: it was already resolved, already escalated, or the Grievance Officer's SLA had not lapsed. | `refused` | `complaintToTheBoard.js` |
| `contact_corrected` | Your email or phone was changed. The row says *which field* moved, never the value and never a hash of it. | `recorded` | `principalId.js` |
| `contact_mismatch_refused` | A signed-in session submitted contact details belonging to somebody else. We refused with `403`. | `refused` | `router.js` |
| `withdrawal_hook_not_fired` | You withdrew a purpose by leaving it out of a `PUT /consent` submission, and our cease-processing hook was never called, so downstream systems were not told. See "honest limits" below. | `recorded` | `persistPIIwithconsent.js` |
| `operator_lookup` | Someone in the back office searched for a data principal by email address. | `recorded` on a hit, `refused` with `no_match` on a miss | `backOfficeRouter.js` |
| `operator_trail_read` | Someone in the back office read a data principal's whole trail. | `recorded` on a hit, `refused` with `no_match` on a miss | `backOfficeRouter.js` |

Three things to notice.

**`outcome` is required on every row.** It is the field that stops a refusal
from ever being read back as a state change. There is no kind whose *name*
reads as a success without one.

**One call, one row.** A submission naming three purposes we refuse for a child
writes one row naming all three, with `count: 3` - not three rows. Without that
collapse, a single 100kb request could force roughly 17,000 inserts.

**`consentTypes` is filtered against the live catalog by the writer.**
`withdrawConsent` passes caller-supplied strings through verbatim, so without
that filter an email address typed into a consent type would land in a
collection that survives erasure. The count survives the filter; the unknown
strings do not.

## What a timeline entry looks like

Every entry has the same shape whether it was stored or derived, so nothing
consuming the timeline has to branch on where it came from. `source` says
which. Fields that do not apply are absent, not `null`.

A full response from `GET /consent/trail`:

```json
{
  "principalId": "3c1f...64 hex chars...9a",
  "docRef": "CN-9F2A1B4C6D8E0F31",
  "coverageFrom": "2026-09-04",
  "timeline": [
    {
      "at": "2026-09-14T11:02:17.431Z",
      "kind": "withdrawal_not_applied",
      "source": "stored",
      "outcome": "refused",
      "actor": { "role": "principal", "channel": "api" },
      "reasonCode": "not_withdrawable",
      "receiptId": "RC-4B7E2C9A1D3F5068",
      "consentTypes": ["kyc_reporting"],
      "count": 1
    },
    {
      "at": "2026-09-12T09:41:02.115Z",
      "kind": "consent_granted",
      "source": "derived",
      "outcome": "recorded",
      "actor": { "role": "unattributed", "channel": "library" },
      "receiptId": "RC-1A2B3C4D5E6F7081",
      "consentTypes": ["underwriting"]
    }
  ],
  "truncated": false,
  "totalEntries": 12
}
```

| Field | What it is for |
| --- | --- |
| `at` | When the act happened. Observed, never inferred. On a stored row it is the moment the writer recorded it; on a derived row it is the source collection's own timestamp. |
| `kind` | One of the eleven stored kinds or the eight derived ones. |
| `source` | `"stored"` or `"derived"`. Present so a consumer can tell where an entry came from without having to guess from `kind`. |
| `outcome` | `recorded`, `refused` or `no_change`. Derived entries are always `recorded`. |
| `actor` | `{ role, channel }`, plus `ref` on the back-office read only. `role` is `principal`, `operator`, `system` or `unattributed`; `channel` is `html`, `api` or `library`. |
| `reasonCode` | Why, from a closed list of twelve values. Absent when the kind has only one meaning. |
| `refId` | The `RQ-`, `GR-` or `CM-` reference of the request this entry is about. |
| `receiptId` | The `RC-` receipt of the submission that produced this entry - including a submission we then refused, so the row cites what the person was handed. |
| `consentTypes` | The purposes this entry covers. Always a list, even when it holds one. |
| `fromStatus` / `toStatus` | The transition a `request_status_changed` row records. `contact_corrected` reuses `toStatus` to name which field moved: `"email"`, `"phone"` or `"email+phone"`, never a value. |
| `count` | How many purposes or fields a collapsed row covers. |
| `caseRef` | The adopter's own ticket reference for a back-office access. Never shown to a data principal. |

And around the timeline:

- **`coverageFrom`** is the release date, returned verbatim from a module
  constant. It exists so an empty trail says "we were not recording before this
  date" instead of implying nothing happened.
- **`docRef`** is the consent record's reference, or `null` if a principal
  exists with no consent record at all.
- **`truncated` and `totalEntries`** say honestly whether you have seen
  everything. There is no cursor and no offset. `?limit=` only sizes the
  newest-first window (1 to 1000), so anything past the limit cannot be paged
  to through this route at all - `truncated` and `totalEntries` are how a
  caller learns that; see the limits section for why.

Ordering is newest first: by `at` descending, then stored before derived at the
same instant, then insertion order descending. That tiebreak is real rather
than theoretical - `persistPIIwithconsent` stamps every event of one submission
with the same instant, and consent events are declared `{_id: false}`, so a
signup deciding five purposes produces five entries with identical timestamps
and no id to fall back on.

## The two ways to read a trail

### The data principal's own: `GET /consent/trail`

On `createRouter`, behind `requireAuth`, scoped to the session principal, served
`no-store` like every other read. Nothing in the request names a subject: the
subject is whoever is signed in.

```
GET /consent/trail?limit=50
```

`?limit=` is optional, an integer from 1 to 1000, default 500. A query string
arrives as text, so the router coerces it to a `Number` before the same
`assertLimit` guard `getConsentTrail` uses internally runs, which means
`?limit[$ne]=1` becomes `NaN` and is refused as a `400`.

**The point of the whole feature sits on this route, not in the back office.** The
trail a data principal reads includes the `operator_lookup` and
`operator_trail_read` rows filed against them. Asha can see *that* someone in
the fiduciary's back office searched for her and read her record, with the
ticket reference and the individual member of staff withheld.

That withholding is deliberate and it goes both ways. Which operator looked is
the adopter's own employee's personal data, held under the adopter's employment
basis, and the case reference is the adopter's internal ticketing data. Neither
is Asha's to receive. That someone looked, is.

The mechanism is one flag: `getConsentTrail({ ..., includeOperatorRefs })`.
`false` on this route strips `actor.ref` and `caseRef`; `true` in the back
office keeps them.

**A principal's own read of their trail is not recorded.** Logging it would
turn the Section 11 right of access into a write path.

### Your back office: `createBackOfficeRouter`

This is a **second router factory**, in `src/http/backOfficeRouter.js`, mounted
on its own path behind your own staff authentication.

```js
const { createBackOfficeRouter } = require("dpdp-fiduciary-toolkit");

app.use(
  "/back-office",
  yourStaffAuthMiddleware,
  yourRateLimiter,                      // required, see below
  createBackOfficeRouter({
    db,
    resolveOperator: (req) => ({ actorRef: req.staff.id }),
    rateLimitedByHost: true,
    allowedOrigins: ["https://back-office.example"],
  })
);
```

```
POST /principals/lookup   { "email": "asha@example.com", "caseRef": "TKT-90210" }
-> 200 { "principalId": "..." }            // 404 if nobody matches

POST /principals/trail    { "principalId": "...", "caseRef": "TKT-90210" }
-> 200 { principalId, docRef, coverageFrom, timeline, truncated, totalEntries }
```

**Why a separate router rather than a role check on the existing one.**
`createRouter`'s routes are principal-facing and public-mountable. These two
routes are a people-search: `POST /principals/lookup` answers whether an email
address belongs to a registered data principal, and for the shipped catalog's
lender that means answering whether someone has applied for credit. If those
routes lived on `createRouter` behind a role check, one wrong `app.use` would
put a people-search on the public mount. A separate factory cannot be
misconfigured that way. The structural separation is the control; the
documentation is not.

Two further guards live in the factory itself. It **refuses to build** unless
you pass `rateLimitedByHost: true` - a plain `Error` at construction, not an
`AppError`, so it cannot be mapped to an HTTP response. This package ships no
rate limiting by documented decision, and shipping a read oracle over a
guessable keyspace without saying so would be irresponsible. And
`resolveOperator` is the exact counterpart of `resolvePrincipal`: absent,
throwing, or returning the wrong shape, and every route here answers `401`. A
misconfigured mount fails closed.

**Why the contact value travels in a POST body.** Issue #4 asked, literally,
for a `GET` API keyed on direct PII. Taken literally that is
`GET /consent/audit?email=asha@example.com`, and it is wrong four times over:

- A raw email in a URL lands in access logs, browser history, `Referer`
  headers and CDN cache keys. `Cache-Control: no-store` does not reach any of
  them, because the cache *key* is the PII.
- `req.query` is not governed by the router's
  `express.urlencoded({ extended: false })` hardening. That setting is
  app-level and a library cannot set it, so on an Express 4 host
  `?email[$ne]=` yields an operator object and reopens exactly the injection
  path `extended: false` was chosen to close.
- The same-origin check exempts `GET`, so a URL-borne lookup is reachable from
  a cross-site `<img>` or a browser prefetch.
- And the trail read *performs a write* - the access record - so a `GET` would
  make that write cross-site triggerable and attributed to a signed-in
  operator.

The HTTP lookup is **email only**, refusing the phone branch that the library
function keeps. One handset belongs to a household, so a phone number
identifies nobody on its own, and the "more than one data principal matches"
error is itself a disclosure that two people share a phone.

`POST /principals/trail` reads `principalId` from a request body, which is a
named carve-out from a rule this library otherwise treats as absolute. It is
sound because operator identity still comes only from `resolveOperator(req)`,
the operator is not the subject so naming a different id escalates nothing,
`assertPrincipalId` runs before the value reaches any filter, and every use is
gated by operator authentication and a fail-closed access record.

The full argument, including what the access record deliberately does *not*
store, is in `docs/adr/0002-pii-keyed-retrieval-surfaces.md`.

### The third way: an unmounted function

`findConsentTrailByContact({ models, email, phone })` is exported from
`src/index.js` and mounted on nothing, the same pattern the repo already uses
for `erasePrincipalPII` and `updatePrincipalContact`. It keeps the phone
branch, because a direct library caller is already inside the host's trust
boundary. It writes no access record - there is no operator to attribute the
read to - so a host that calls this instead of mounting the router owes its own
`operator_trail_read` row.

## What happens when a trail write fails

If the trail write fails, does the underlying act fail with it?

Both answers are wrong somewhere. Fail closed everywhere, and a consent grant
that cannot be audited gets refused - the audit feature can now take down
consent capture, which is the one thing that must always work. Fail open
everywhere, and an operator can disclose a named person's entire lineage with
no counter-record, which is an unaudited people-search.

So the policy splits along that seam:

| | Function | On failure |
| --- | --- | --- |
| **Instrumentation** - every trail write inside a service | `recordTrail(models, entry)` | Logs and returns. Never throws. The underlying act proceeds. |
| **Back-office disclosure** - the two access records | `recordTrailStrict(models, entry)` | Throws `AppError(..., 503)`. No record, no disclosure. |

The failure log carries `err.name` and `err.code` and nothing else. Never
`err.message` - Mongoose's cast and duplicate-key messages quote the offending
value back, which is how a caller-supplied email address reaches a log file.

The asymmetry is visible in the code and has to stay that way. `recordTrail`
builds its document *inside* the `try`, so a malformed `caseRef` is swallowed
along with everything else. `recordTrailStrict` builds it *outside*, so the
same malformed value surfaces as a `400` to the caller who supplied it rather
than being masked as a `503` write failure. Only a genuine write failure
produces the `503`, which is what makes "no record, no disclosure" mean
something.

On the back-office routes, the ordering is load-bearing and separately tested:
look the principal up, write the record with an outcome derived from what the
lookup found, and only then answer - **including when the answer is a 404**. An
operator who probes an id with nothing behind it has still used the surface,
and a 404 that left no trace would be the one way to use it unrecorded. Reading
the principal is not itself a disclosure; it is what lets the record say
truthfully whether an operator saw a lineage or merely probed.

### The honest consequence

Instrumentation fails open. So:

> **The trail is evidence of what was recorded. It is not proof that nothing
> else happened.**

Say it that way. An earlier draft of the spec shipped both a fail-open policy
and a "complete by iteration" read contract. They cannot both be true, and the
completeness claim is the one a consumer would act on, so it was deleted. This
is the same register the README already uses for "recorded", never "sent": a
`200` is not proof the Board was notified.

`docs/adr/0003-split-failure-policy.md` has the reasoning.

## What it deliberately does not record

Each of these was proposed and cut, with a reason.

| Not recorded | Why |
| --- | --- |
| The signup `409` (an email that is already registered) | Recording it against the resolved principal would let an unauthenticated stranger who knows an email append rows to *that person's* trail, unthrottled. Reads are newest-first and bounded, so that is also a way to bury evidence. |
| The anonymous notice page, `GET /consent/new` | It is the one deliberately unauthenticated page in the toolkit, and `GET` is exempt from the same-origin check. Instrumenting it turns a cross-site `<img>` or a crawler into a database write. |
| The `401`, and the cross-origin `403` | Neither has an identity, by definition. |
| A data principal's own reads of `GET /consent` and `GET /consent/trail` | Logging them would make the right of access a write path and change its cost profile. |
| IP address and user-agent | Personal data the library has no basis to retain, and the host already has both in its own access logs. |
| A minor turning 18 | It partially reconstructs a date of birth that erasure deliberately destroys, and the retained `isMinor` boolean already serves the purpose. |
| Any free text at all | `Grievance.description`, `RightsRequest.details` and `ConsentManagerRequest.message` survive erasure by documented decision. Copying them into a collection that *also* survives erasure would surface PII on a record the system reports as `pii: null`. |
| Any hash of a contact detail | There is no field on `TrailEntry` to write one to, and no task may add one. A row carrying a contact hash beside a `principalId` would rebuild the email-to-person index that erasure exists to destroy - the fiduciary holds `PRINCIPAL_ID_SECRET` and could recompute it at any time. On a lookup that matched nobody, it would mint a permanent contact-derived identifier for a person who is not a data principal of this fiduciary at all. A field that does not exist cannot be set. |

That last row is why the trail survives erasure without reversing it. Erasure
writes nothing to `trailentries`, edits nothing in it, and deletes nothing from
it. The rows stay as pseudonymous evidence, exactly as the consent ledger does,
and an erased principal is unreachable by PII permanently and by design.

## Its honest limits

Four of these belong in any conversation you have about this feature. State
them plainly; do not let a reader infer more than the code does.

**1. It is not retroactive.** It covers forward from the release date only. No
backfill is possible or permitted, because backfilling would mean inventing
timestamps for acts nobody observed. `coverageFrom` in every response says so
explicitly, so an empty timeline reads as "we were not recording before this
date" rather than "nothing happened".

**2. Instrumentation writes are best-effort.** See the split failure policy
above. A lost write leaves a hole and the act proceeds. The trail is evidence
of what was recorded, not proof that nothing else happened.

**3. There is no completeness claim, and nothing in the docs may imply one.**
This follows directly from 2. If you find a sentence anywhere in this
repository that promises a complete trail, it is a bug in the sentence.

**4. Operator access rows are the one input the partition rule does not
bound.** `operator_lookup` and `operator_trail_read` are filed under the
**subject's** `principalId`, not the acting operator's. So a data principal
whom the back office has looked up two hundred times carries two hundred stored
rows, no matter how few acts of their own they performed. Everything else is
bounded by state change; this is bounded by your staff's activity. That
unbounded input is the entire reason `?limit=` exists on the principal-facing
read, and it is why the read reports `truncated` and `totalEntries` instead of
pretending the window is the whole story.

Two more that are worth knowing:

**`actor.ref` is your employee's personal data**, held in a collection nothing
deletes from, under your own employment basis. This library does not discharge
the duties you owe your staff for it. `assertOpaqueRef` bounds the *shape* of
`actor.ref` and `caseRef`, not their meaning: it rules out an address, a phone
number with punctuation, and anything containing a space, so contact details
cannot arrive by accident - but it admits `johnsmith`, and a determined
integrator can still put personal data there.

**`withdrawal_hook_not_fired` records a gap; it does not close it.**
`PUT /consent` can withdraw a purpose by omitting it from the submission.
`persistPIIwithconsent` has no `onWithdrawal` parameter and the router passes
none, so on that path the host's cease-processing pipeline is never told. The
withdrawal itself is in the ledger and is therefore derived. What the trail
*adds* is a row saying the hook did not fire - which means the trail produces
written proof that a Section 6(6) cessation duty may have gone undischarged.
That is the honest outcome, and recording that the hook did not fire is not the
same as firing it. If you are the person who closes that gap, you will be
changing the signature of an exported function on the consent write path.

## Where to look in the code

| File | What is in it |
| --- | --- |
| `src/models/TrailEntry.js` | The schema. The eleven kinds, the twelve reason codes, the actor sub-schema, and the argument for every field that is *not* there. |
| `src/services/consentTrail.js` | `recordTrail`, `recordTrailStrict`, `getConsentTrail`, `findConsentTrailByContact`, `COVERAGE_FROM`, and the merge and ordering. |
| `src/http/backOfficeRouter.js` | The separate factory, `requireOperator`, and both access-recorded routes. |
| `src/http/router.js` | `GET /consent/trail`, plus the two instrumentation sites on `PUT /consent`. |
| `test/trailread.test.js` | Start here. The twelve-act timeline is a single `deepEqual` over a whole trail, played through the real services, and it is the feature's executable documentation. |
| `test/trail.test.js` | The schema and the two writers, including what the writer drops. |
| `test/backoffice.test.js` | The factory's refusals, the access records, and "no disclosure without a record". |

Read `test/trailread.test.js` before you change anything here. It pins the
element shape, both sources, the derived vocabulary, the descending order and
the identical-timestamp tiebreak in one assertion, and it plays every act
through the service a host would actually call - so deleting an instrumentation
site fails the test rather than quietly weakening it.

---

None of this is legal advice, and this package is not a certified compliance
product. It is a reference implementation of obligations under the Digital
Personal Data Protection Act, 2023, and everything above describes what the
code records - not what your organisation has done.
