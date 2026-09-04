# 4. Six things that happen, start to finish

Meet Asha Rao. She is applying for a loan from Kavach Finance, the fictional
lender this toolkit ships a consent catalog for. Over the next six scenarios she
signs up, tries to withdraw something she cannot, withdraws something she can,
complains, gets looked up by a member of staff, and finally asks to be erased.

For each one: what she does, what the HTTP request looks like, what happens
inside, what she gets back, and - the part that ties the chapter together - what
her timeline says afterwards.

Everything below was run against the real code. The identifiers, timestamps and
response bodies are from that run.

---

## Before you follow along

**Two routers, two mounts.** `createRouter` is the data principal's surface -
Asha's. `createBackOfficeRouter` is the fiduciary's staff surface. They are
separate factories and must be mounted on separate paths; one wrong `app.use`
would otherwise put a people-search on a public mount.

```js
app.use("/", createRouter({ db, resolvePrincipal }));
app.use("/back-office", yourStaffAuth, yourRateLimiter,
        createBackOfficeRouter({ db, resolveOperator, rateLimitedByHost: true }));
```

**Running it.** `data-fiduciary-toolkit/examples/server.js` mounts `createRouter`
at `/` and adds a deliberately-labelled demo sign-in, so the authenticated routes
are reachable end to end. `npm run example`, with a Mongo instance at
`MONGO_URI`. The curls below use its `x-demo-session` header - `$TOKEN` comes
from that demo server's `POST /demo/login`, shown in Chapter 5. The example does
**not** mount the back office - scenario 5 shows what you have to add.

**Identity never comes from the payload.** `principalId` is a database key, not a
credential. On every `createRouter` route it comes from `resolvePrincipal(req)`
and nowhere else; a `?principalId=` or a body field is ignored. The one carve-out
is `POST /back-office/principals/trail`, where the id is a *query subject* rather
than a credential - scenario 5.

**One shape for the whole timeline.** A `GET /consent/trail` entry looks like
this, with every field that does not apply simply absent:

```json
{ "at": "…", "kind": "…", "source": "stored" | "derived", "outcome": "recorded" | "refused" | "no_change",
  "actor": { "role": "…", "channel": "…" },
  "reasonCode": "…", "refId": "…", "receiptId": "…", "consentTypes": ["…"],
  "fromStatus": "…", "toStatus": "…", "count": 1 }
```

`source` is the one field you need to understand before anything else makes
sense:

| `source` | Where it came from | Example |
| --- | --- | --- |
| `derived` | Read at request time off a primary collection that already recorded the fact, with its own observed timestamp. Nothing is copied. | A consent grant, read from `ConsentRecord.events[].timestamp` |
| `stored` | A row in the `trailentries` collection, because the fact is destroyed or never written anywhere else. | A refused withdrawal - the ledger never hears about it |

That split is the **partition rule**, and it is the whole design: nothing is both
stored and derived, so nothing can be reported twice. See
[ADR 0001](../adr/0001-consent-trail-partition-rule.md) for why it replaced a
120-line deduplication pass.

**Three honesty rules that show up in every scenario.**

1. `coverageFrom` is on every trail read. The trail is not retroactive and no
   backfill is possible, so an empty timeline says "we were not recording before
   this date" rather than implying nothing happened.
2. Instrumentation writes **fail open**. If a trail write fails, the act it was
   instrumenting still succeeds, and the failure is only logged with
   `err.name` and `err.code`. That is the trail's completeness limit; Chapter 3
   derives it in full.
3. This package has no outbound channel. A grievance is **recorded**, never
   "sent". This toolkit is a reference implementation - it is not legal advice
   and not a certified compliance product.

---

## 1. She signs up, and consents to some purposes but not others

Asha reads the notice at `GET /consent/new`, ticks two boxes, and submits. She
wants the identity check and the loan assessment. She does not want marketing or
product analytics.

```bash
curl -s localhost:4000/consent -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "pii": {"name":"Asha Rao","email":"asha@example.com","phone":"9876543210","dob":"1990-04-01"},
    "consentTypes": ["identity_verification","underwriting"]
  }'
```

`POST /consent` is deliberately unauthenticated. A person has no account until
this succeeds, so requiring one would make the toolkit unusable. It refuses with
`409` if the email is already registered, and that check runs **before any
write**.

### What happens inside

`src/http/router.js` → `src/services/persistPIIwithconsent.js`.

1. `pii.dob` is required, and the age gate runs before anything is written. Asha
   is an adult, so it passes. (A minor without verifiable parental consent gets a
   `422` and leaves no `Principal` and no `ConsentRecord` behind - only an
   `age_gate_refused` row.)
2. `findOrCreatePrincipal` creates a `Principal` document holding her PII plus
   keyed HMACs of her email and phone. Her `principalId` is 32 random bytes, not
   derived from anything she typed.
3. The Section 5 notice is generated from the catalog and upserted into
   `NoticeVersion`, content-addressed by a hash of its own body.
4. The service walks **the whole catalog**, not just the boxes she ticked, and
   asks `decide()` what changed for each purpose. This is Asha's first
   submission, so every purpose is a change and all five get an event. On a
   later submission only the purposes that actually moved are appended - see
   Chapter 2's state table.

### What she gets back

`201`, and the full decision for every purpose in the catalog:

```json
{
  "docRef": "CN-538A6980AC448706",
  "receiptId": "RC-A0CDE537EDA4014C",
  "principalId": "18a11b09cfd5f34fe4c63ff061479cd9feb46f316a0f13e51c1eb3e94f7b302d",
  "created": true,
  "events": [
    { "type": "kyc_reporting",         "status": "granted", "lawfulBasisKind": "legitimate_use", "basis": "Obligation under law to disclose information to the State - reporting under the Prevention of Money-Laundering Act, 2002", "receiptId": "RC-A0CDE537EDA4014C", "timestamp": "2026-09-04T12:00:12.239Z", "noticeVersion": "631447db0e2c3eb1" },
    { "type": "identity_verification", "status": "granted", "lawfulBasisKind": "consent", "basis": "Your consent", "…": "…" },
    { "type": "underwriting",          "status": "granted", "lawfulBasisKind": "consent", "…": "…" },
    { "type": "marketing",             "status": "denied",  "lawfulBasisKind": "consent", "…": "…" },
    { "type": "analytics",             "status": "denied",  "lawfulBasisKind": "consent", "…": "…" }
  ],
  "state": { "…": "current status per purpose" },
  "refusedForChild": []
}
```

Every event carries the same `receiptId` and the same `timestamp` - one
submission, one receipt, one instant. Keep that in mind; it matters in a moment.

A browser gets a receipt page instead of JSON. That page is the only way a
browser user ever sees their `principalId`, so it is served `no-store`.

### What a declined purpose records

**A decline is an event, not an absence.** `marketing` and `analytics` each get a
real ledger event with `status: "denied"`. Not ticking a box is a decision, and
the record has to be able to tell "she said no" apart from "we never asked".

### The purpose she was not asked about

`kyc_reporting` is `granted` and she never ticked it. That is not a bug, and it
is not a consent - it is the Section 7(d) legitimate use from Chapter 1,
recorded once so the notice obligation has evidence behind it. `kyc_reporting`
cites that clause specifically: an obligation under law to disclose information
to the State, which is what reporting to the Financial Intelligence Unit under
the Prevention of Money-Laundering Act, 2002 is.

So the event records the *basis actually relied on*:

| | `identity_verification` | `kyc_reporting` |
| --- | --- | --- |
| `lawfulBasisKind` | `consent` | `legitimate_use` |
| `basis` | "Your consent" | the PMLA disclosure obligation |
| catalog `withdrawable` | `true` | `false` |
| Recorded when? | Whenever she changes her mind | Once, on first submission, then never again |

That last row is `src/services/persistPIIwithconsent.js`:

```js
// A legitimate use does not depend on choice - record it once, for notice.
if (entry.lawfulBasis.kind === "legitimate_use") return current ? null : "granted";
```

It is recorded once so the notice obligation has evidence behind it: she was told
this processing happens and on what basis. It is not re-recorded on later
submissions, and **omitting it from a later submission does not withdraw it**.

Note the catalog deliberately does *not* model all of "KYC" as non-withdrawable.
Verifying her identity for Kavach's own records is wider than the Section 7(d)
disclosure duty, so it sits in a separate, consent-based, withdrawable purpose.
Marking the whole of KYC non-withdrawable would refuse a withdrawal the statute
guarantees.

### Her timeline afterwards

```bash
curl -s localhost:4000/consent/trail -H "x-demo-session: $TOKEN"
```

```json
{
  "principalId": "18a11b09…", "docRef": "CN-538A6980AC448706",
  "coverageFrom": "2026-09-04",
  "timeline": [
    { "at": "…12.239Z", "kind": "consent_denied",  "source": "derived", "outcome": "recorded", "actor": {"role":"unattributed","channel":"library"}, "receiptId": "RC-A0CDE537EDA4014C", "consentTypes": ["analytics"] },
    { "at": "…12.239Z", "kind": "consent_denied",  "source": "derived", "…": "…", "consentTypes": ["marketing"] },
    { "at": "…12.239Z", "kind": "consent_granted", "source": "derived", "…": "…", "consentTypes": ["underwriting"] },
    { "at": "…12.239Z", "kind": "consent_granted", "source": "derived", "…": "…", "consentTypes": ["identity_verification"] },
    { "at": "…12.239Z", "kind": "consent_granted", "source": "derived", "…": "…", "consentTypes": ["kyc_reporting"] }
  ],
  "truncated": false, "totalEntries": 5
}
```

Three things to notice.

- **`trailentries` is empty.** Zero rows were written. Signing up destroys
  nothing, so under the partition rule nothing is stored - all five entries are
  read straight off the ledger. An empty `trailentries` collection is not an
  empty trail.
- **Five entries share one millisecond.** They are ordered by reverse array
  position, because `consentEventSchema` is declared `{_id: false}` and the
  events have no id to fall back on. Without that tiebreak the order would be
  whatever the sort happened to do.
- **`actor` is `unattributed`, not `principal`.** The `ConsentRecord` never
  recorded who acted, so the derived entry cannot claim to know. `unattributed`
  is not a synonym for `system`; it means the library genuinely does not know.
  Stored entries are the ones that name an actor.

> **Gotcha.** Omitting `consentTypes` entirely means "this is a PII-only update,
> no consent decision was made". Sending `[]` means "I decline everything".
> Sending `null` is treated as omission, deliberately - a client that serialises
> an absent value rather than dropping the key would otherwise revoke every live
> consent, on an append-only ledger, unrecoverably.

---

## 2. She tries to withdraw the reporting purpose, and is refused

Two months later Asha reads about the right to withdraw and asks to stop the
anti-money-laundering reporting.

The HTML withdrawal page never offers this. `renderWithdrawalPage` lists only
purposes that are currently `granted` **and** `withdrawable`, so at this point it
shows her `identity_verification` and `underwriting` and nothing else. She
reaches the refusal through an API client:

```bash
curl -s localhost:4000/consent/withdraw -X PUT \
  -H 'Content-Type: application/json' -H "x-demo-session: $TOKEN" \
  -d '{"consentTypes":["kyc_reporting"]}'
```

### What happens inside

`src/services/withdrawConsent.js` loops over the requested purposes. For
`kyc_reporting` it hits this branch:

```js
if (!getWithdrawableTypes().includes(type)) {
  rejected.push({ type, reason: `This purpose rests on ${entry.lawfulBasis.clause} (…), not on your consent, so it cannot be withdrawn` });
  notWithdrawableTypes.push(type);
  continue;
}
```

Nothing is withdrawn, so `withdrawn.length` is 0, so **`record.save()` is never
called**. The ledger is not touched. Not "touched and reverted" - never opened
for writing.

### What she gets back

`200`, not an error. A purpose that cannot be withdrawn is reported in the
receipt, not as a failure status:

```json
{
  "docRef": "CN-538A6980AC448706",
  "receiptId": "RC-1D4284DC864FC040",
  "withdrawn": [],
  "rejected": [{
    "type": "kyc_reporting",
    "reason": "This purpose rests on Section 7(d) (Obligation under law to disclose information to the State - reporting under the Prevention of Money-Laundering Act, 2002), not on your consent, so it cannot be withdrawn"
  }],
  "noChange": [],
  "effectiveFrom": null,
  "contact": { "dpoName": "Data Protection Officer", "dpoEmail": "dpo@kavach.example" }
}
```

`effectiveFrom` is `null` rather than a timestamp, because reporting a moment for
a revocation that did not happen would have a host act on nothing.

### This is the important one

**Before this work, that call left no trace anywhere at all.** The ledger was
untouched by design, the response was ephemeral, and nothing on any collection
recorded that a data principal had asked to stop something and been told no. A
Grievance Officer looking at Asha's file six months later would have seen a
clean, uneventful record.

Now one row is written, after the (skipped) save, by `recordTrail`:

```json
{
  "principalId": "18a11b09…",
  "kind": "withdrawal_not_applied",
  "outcome": "refused",
  "reasonCode": "not_withdrawable",
  "actor": { "role": "principal", "channel": "api" },
  "receiptId": "RC-1D4284DC864FC040",
  "consentTypes": ["kyc_reporting"],
  "count": 1,
  "at": "2026-09-04T12:00:12.266Z"
}
```

The `receiptId` is the one the response handed her, so the row cites exactly what
she was given. `channel` is negotiated per request - had she used the browser form
it would say `html`, and an HTML refusal and an API refusal are different failures
to answer for.

### Her timeline afterwards

```json
{ "timeline": [
    { "at": "…12.266Z", "kind": "withdrawal_not_applied", "source": "stored", "outcome": "refused",
      "actor": {"role":"principal","channel":"api"}, "reasonCode": "not_withdrawable",
      "receiptId": "RC-1D4284DC864FC040", "consentTypes": ["kyc_reporting"], "count": 1 },
    { "at": "…12.239Z", "kind": "consent_denied", "source": "derived", "…": "…" }
  ],
  "truncated": false, "totalEntries": 6 }
```

Six entries: the five derived ledger decisions, plus this one stored row. And the
ledger itself is verifiably unchanged - still five events, `updatedAt` still the
signup instant.

`outcome: "refused"` is what stops this ever being misread as a state change. It
is a required field on every trail row for exactly that reason.

Other refusals on the same path, for reference:

| She asks to withdraw | `outcome` | `reasonCode` | Note |
| --- | --- | --- | --- |
| a Section 7 purpose | `refused` | `not_withdrawable` | scenario 2 |
| something already withdrawn | `no_change` | `not_granted` | `noChange` in the response, not `rejected` |
| a purpose not in the catalog | `refused` | `unknown_consent_type` | `count` survives, `consentTypes` is **dropped** - unknown types are caller text and never reach a collection that survives erasure |

---

## 3. Two purposes, one call: one withdrawn, one refused

Asha now decides she does not want Kavach assessing her for further credit, and
tries the reporting purpose again in the same request.

```bash
curl -s localhost:4000/consent/withdraw -X PUT \
  -H 'Content-Type: application/json' -H "x-demo-session: $TOKEN" \
  -d '{"consentTypes":["underwriting","kyc_reporting"]}'
```

This is the partition rule made visible, because one call runs both halves: the
branch that actually calls `record.save()` and the branch that writes a pure
refusal.

### What she gets back

```json
{
  "docRef": "CN-538A6980AC448706",
  "receiptId": "RC-62EA7F2937D81F8B",
  "withdrawn": ["underwriting"],
  "rejected": [{ "type": "kyc_reporting", "reason": "This purpose rests on Section 7(d) …" }],
  "noChange": [],
  "effectiveFrom": "2026-09-04T12:00:12.276Z",
  "contact": { "dpoName": "Data Protection Officer", "dpoEmail": "dpo@kavach.example" }
}
```

One receipt covers both halves. `effectiveFrom` is a real moment this time,
because something really was revoked.

If the host passed an `onWithdrawal` hook, it fires **once**, with
`types: ["underwriting"]` only - the purposes that actually changed. A throw from
that hook **does** fail the request, deliberately: it is how the host learns it
must cease processing and erase, and a host whose pipeline is down needs to know.

### What lands where

| Purpose | Where it went | On the timeline as |
| --- | --- | --- |
| `underwriting` | a `withdrawn` event appended to `ConsentRecord.events` | `consent_withdrawn`, **derived** |
| `kyc_reporting` | a row in `trailentries` | `withdrawal_not_applied`, **stored** |

### Her timeline afterwards

```json
[
  { "at": "…12.277Z", "kind": "withdrawal_not_applied", "source": "stored",  "outcome": "refused",
    "actor": {"role":"principal","channel":"api"}, "reasonCode": "not_withdrawable",
    "receiptId": "RC-62EA7F2937D81F8B", "consentTypes": ["kyc_reporting"], "count": 1 },
  { "at": "…12.276Z", "kind": "consent_withdrawn",     "source": "derived", "outcome": "recorded",
    "actor": {"role":"unattributed","channel":"library"},
    "receiptId": "RC-62EA7F2937D81F8B", "consentTypes": ["underwriting"] },
  { "at": "…12.266Z", "kind": "withdrawal_not_applied", "source": "stored", "…": "the scenario 2 refusal" }
]
```

Two entries from one call, sharing one `receiptId`, and **no purpose appears in
both**. `underwriting` appears exactly once, derived. `kyc_reporting` appears
exactly once, stored. That disjointness is not enforced by a deduplication pass -
it falls out of the per-purpose loop, where a purpose either changes the ledger or
is refused and can never do both. `test/trailread.test.js` asserts it by
set-intersecting the two halves.

Note also that the row written by *this* call sorts above the one from scenario 2
even though they carry the same `kind` and `reasonCode`. They are separate acts,
separately timestamped, and both survive.

> **The quieter sibling.** `PUT /consent` withdraws by omission: submit
> `consentTypes` without a purpose you currently hold and it is withdrawn. That
> withdrawal is a real ledger event and is derived like any other. What is
> recorded nowhere else is that `persistPIIwithconsent` has no `onWithdrawal`
> parameter, so the host's cease-processing pipeline never ran. That gets a
> stored `withdrawal_hook_not_fired` row, `outcome: "recorded"` - nothing was
> refused, the withdrawal took effect, the notification did not happen. It names a
> Section 6(6) duty that may have gone undischarged, and recording that the hook
> did not fire is not the same as firing it.
>
> **Re-ticking a withdrawn purpose does nothing.** `underwriting` is now
> `withdrawn`. Submitting it again through `PUT /consent` returns `200` with
> `events: []` - reversing a withdrawal needs an explicit `regrant: true`. Nothing
> else records that she asked, so a stored `consent_not_applied` /
> `regrant_not_requested` row would, with `outcome: "no_change"`. Asha did not do
> this in the run below, so no such row appears in the eighteen-row table at the
> end of the chapter - but it is the row you would find if she had.

---

## 4. She files a grievance, escalates it, and staff move it twice

Nobody answers her emails, so she complains.

```bash
curl -s localhost:4000/grievance -X POST \
  -H 'Content-Type: application/json' -H "x-demo-session: $TOKEN" \
  -d '{"subject":"No answer","description":"I asked twice and heard nothing."}'
```

```json
{
  "refId": "GR-F49B2DE57C0AA530",
  "addressedTo": "Data Protection Officer",
  "dpoEmail": "dpo@kavach.example",
  "slaDueAt": "2026-09-11T12:00:12.284Z",
  "note": "This grievance has been recorded and assigned to Kavach Finance's Grievance Officer (Data Protection Officer). If it is not resolved by 2026-09-11, you may escalate it to the Data Protection Board."
}
```

**"Recorded and assigned", never "sent".** This package has no mail transport and
no ticketing integration. The grievance is a document in a collection and nothing
left the process. Telling her it had been sent would be a false assurance that
stops her following it up - and the SLA date, which is the thing she needs in
order to escalate, would not even be in the sentence.

Under Section 13 a complaint goes to the fiduciary's own Grievance Officer first.
The Board hears it only if that is not resolved in time.

### She tries to escalate too early

```bash
curl -s localhost:4000/grievance/GR-F49B2DE57C0AA530/escalate -X POST \
  -H 'Content-Type: application/json' -H "x-demo-session: $TOKEN" -d '{}'
```

```json
409 { "error": "The Grievance Officer's SLA hasn't lapsed yet (due 2026-09-11T12:00:12.284Z)" }
```

That branch saves nothing at all - the grievance document is untouched and the
`409` is its only other output. So a stored row is the entire record that a data
principal tried to reach the Board and was stopped: `escalation_refused`,
`outcome: "refused"`, `reasonCode: "sla_not_lapsed"`, `actor.role: "principal"`.
A row saying `unattributed` here would answer nobody's question about who was
turned back.

### Staff pick it up, she escalates, staff close it

`advanceGrievance` is a fiduciary-side function. It is exported from
`src/index.js` and **deliberately not mounted on any route** - a data principal
must not be able to close their own grievance, and staff authentication is the
host's concern.

```js
const { advanceGrievance } = require("dpdp-fiduciary-toolkit");
await advanceGrievance({ models, refId, status: "in_progress",
                         actor: { role: "operator", ref: "staff-4471", channel: "api" } });
```

Once the SLA lapses, her escalation succeeds:

```json
200 { "refId": "GR-F49B2DE57C0AA530", "status": "escalated", "escalatedAt": "2026-09-04T12:00:12.294Z" }
```

Then staff resolve it, `escalated → resolved`.

`escalateToBoard` is the only path into the `escalated` state, because it is the
only one that checks the SLA and sets `escalatedAt` and `escalatedToBoard`
together. `requestLifecycle` refuses that transition on purpose - a grievance
sitting in status `escalated` with `escalatedAt: null` would be two fields
contradicting each other in the audit record.

### Derived versus stored, in one document

The `Grievance` document is the source for two entries, and destroys the source
for two others.

| Fact | Where it lives | How the trail gets it |
| --- | --- | --- |
| She filed it | `Grievance.createdAt` | **derived** → `grievance_filed` |
| She escalated it | `Grievance.escalatedAt` | **derived** → `grievance_escalated` |
| She was refused an early escalation | nowhere - the branch saves nothing | **stored** → `escalation_refused` |
| `open → in_progress` | destroyed | **stored** → `request_status_changed` |
| `escalated → resolved` | destroyed | **stored** → `request_status_changed` |

Two entries from one document, because filing and escalating are separate acts
with separate observed moments and `Grievance` stores both.

The transitions have to be stored because `requestLifecycle.advance` overwrites
`row.status` in place, and `updatedAt` holds only the moment of the *last*
change. A grievance that went `open → in_progress → escalated → resolved` would
otherwise be indistinguishable from one that went straight to `resolved`. So the
prior value is captured **before** the assignment:

```js
const fromStatus = row.status;   // captured before `row.status = status` destroys it
```

Reconstructing that middle transition from `updatedAt` would be inventing a
timestamp nobody observed, which is the one thing an audit trail must never do.

### Her timeline afterwards

```json
[
  { "at": "…12.295Z", "kind": "request_status_changed", "source": "stored",  "outcome": "recorded",
    "actor": {"role":"operator","channel":"api"}, "refId": "GR-F49B2DE57C0AA530",
    "fromStatus": "escalated", "toStatus": "resolved" },
  { "at": "…12.294Z", "kind": "grievance_escalated",    "source": "derived", "outcome": "recorded",
    "actor": {"role":"unattributed","channel":"library"}, "refId": "GR-F49B2DE57C0AA530" },
  { "at": "…12.290Z", "kind": "request_status_changed", "source": "stored",  "outcome": "recorded",
    "actor": {"role":"operator","channel":"api"}, "refId": "GR-F49B2DE57C0AA530",
    "fromStatus": "open", "toStatus": "in_progress" },
  { "at": "…12.288Z", "kind": "escalation_refused",     "source": "stored",  "outcome": "refused",
    "actor": {"role":"principal","channel":"api"}, "reasonCode": "sla_not_lapsed",
    "refId": "GR-F49B2DE57C0AA530" },
  { "at": "…12.284Z", "kind": "grievance_filed",        "source": "derived", "outcome": "recorded",
    "actor": {"role":"unattributed","channel":"library"}, "refId": "GR-F49B2DE57C0AA530" }
]
```

`totalEntries` is now 13. Every entry cites `GR-F49B2DE57C0AA530`, so she can
match each one to the reference she was given.

**Her subject line and her description are not on the timeline.** A derived entry
projects the reference and nothing else; the free text she typed stays in the
collection she typed it into. `trailentries` holds no free text at all, by
construction.

Notice too that the two `request_status_changed` rows carry
`actor: {"role":"operator","channel":"api"}` on her read - the role and the
surface, but not *which* member of staff. That is the next scenario.

---

## 5. Staff look her up by email, and read her trail

A caseworker at Kavach has Asha on the phone. He has her email address, not a
64-character hex identifier.

The back office is a separate router and the example server does not mount one.
You add it yourself:

```js
const { createBackOfficeRouter } = require("dpdp-fiduciary-toolkit");

app.use("/back-office",
  yourStaffAuthMiddleware,
  yourRateLimiter,                       // required - see below
  createBackOfficeRouter({
    db,
    resolveOperator: (req) => ({ actorRef: req.staff.id }),
    rateLimitedByHost: true,
  })
);
```

`rateLimitedByHost: true` is not optional and not a boolean flag with a
default - the factory will not build without it, a plain `Error` at
construction rather than a runtime check. Chapter 5 says why.

### The lookup

```bash
curl -s localhost:4000/back-office/principals/lookup -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -d '{"email":"asha@example.com","caseRef":"TKT-90210"}'
```

`$STAFF_TOKEN` stands in for whatever `yourStaffAuthMiddleware` needs to set
`req.staff` - without it, `resolveOperator` throws and every route on this
router answers `401`. `POST`, and the address travels in the body. A raw email in a path or query
string lands in access logs, browser history, `Referer` headers and CDN cache
keys, none of which this library can reach to clean up.

It is **email only**. It refuses the phone branch that the unmounted
`findConsentTrailByContact` still offers a direct library caller: one handset can
belong to a whole household, so a number identifies nobody on its own.

```json
200 { "principalId": "18a11b09cfd5f34fe4c63ff061479cd9feb46f316a0f13e51c1eb3e94f7b302d" }
```

A lookup answers with the identifier and nothing else. Her name, phone, dob and
PAN are not part of finding someone.

**The record is written before the answer**, through `recordTrailStrict`, which
**fails closed**: if the row cannot be written the route returns `503` and no
data at all. No record, no disclosure. An unaudited people-search is worse than
no people-search.

```json
{ "kind": "operator_lookup", "outcome": "recorded",
  "principalId": "18a11b09…",
  "actor": { "role": "operator", "ref": "staff-4471", "channel": "api" },
  "caseRef": "TKT-90210", "at": "…12.302Z" }
```

What the row deliberately does *not* hold is any hash of the address searched
for. `TrailEntry` has no field either could be written to. On a hit, storing the
hash beside the `principalId` would rebuild the email-to-person index erasure
exists to destroy - Kavach holds `PRINCIPAL_ID_SECRET` and could recompute it at
any time. On a miss it would mint a permanent contact-derived identifier for
someone who is not their data principal at all.

### The trail read

```bash
curl -s localhost:4000/back-office/principals/trail -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -d '{"principalId":"18a11b09…","caseRef":"TKT-90210"}'
```

`POST` again, for a second reason: this read performs a database write - the
access record - and `GET` is exempt from the same-origin check. A
cross-site-triggerable write into the accountability record, attributed to a
signed-in operator, would not be acceptable.

This is the one place in the library where `principalId` comes from a payload.
That is sound because operator identity still comes only from
`resolveOperator(req)`; the operator is not the subject, so naming a different id
escalates nothing; `assertPrincipalId` runs before the value reaches any filter;
and every use is gated by operator auth and a fail-closed access record. An
operator authorised to read one trail is authorised to read any - that is what a
back office is - so the control here is attribution, not scoping.

The record is written first, which means **the read's own row is the first entry
in its own response**. (`timeline` is shown alone below; the actual response is
the usual `{ principalId, docRef, coverageFrom, timeline, truncated,
totalEntries }` envelope.)

```json
[
  { "at": "…12.305Z", "kind": "operator_trail_read", "source": "stored", "outcome": "recorded",
    "actor": { "role": "operator", "ref": "staff-4471", "channel": "api" }, "caseRef": "TKT-90210" },
  { "at": "…12.302Z", "kind": "operator_lookup",     "source": "stored", "outcome": "recorded",
    "actor": { "role": "operator", "ref": "staff-4471", "channel": "api" }, "caseRef": "TKT-90210" },
  { "at": "…12.295Z", "kind": "request_status_changed", "…": "…" }
]
```

If that row were missing from its own response, the write would be happening
after the disclosure - at which point a failed write could no longer stop the
data going out.

`outcome` says what actually happened, not merely that the surface was used. A
probe of an id with nothing behind it gets `outcome: "refused"`,
`reasonCode: "no_match"`, and the `404` is thrown **after** the record - an
operator who probes a non-existent id has still used this surface, and a `404`
that left no trace would be the one way to use it unrecorded.

### And now the part that matters

Asha reads her own trail.

```bash
curl -si localhost:4000/consent/trail -H "x-demo-session: $TOKEN"
```

```
Cache-Control: no-store
Vary: Cookie
```

```json
[
  { "at": "…12.305Z", "kind": "operator_trail_read", "source": "stored", "outcome": "recorded",
    "actor": { "role": "operator", "channel": "api" } },
  { "at": "…12.302Z", "kind": "operator_lookup",     "source": "stored", "outcome": "recorded",
    "actor": { "role": "operator", "channel": "api" } },
  { "at": "…12.295Z", "kind": "request_status_changed", "source": "stored", "outcome": "recorded",
    "actor": { "role": "operator", "channel": "api" }, "refId": "GR-F49B2DE57C0AA530",
    "fromStatus": "escalated", "toStatus": "resolved" }
]
```

**The rows are present, and they arrive stripped.** She learns that someone in
the back office searched for her and read her record, and when. She does not
learn which member of staff, and she does not get the ticket reference.

That is `includeOperatorRefs`, and it is the only difference between the two
reads:

| | Her `GET /consent/trail` | Back office `POST /principals/trail` |
| --- | --- | --- |
| `includeOperatorRefs` | `false` | `true` |
| `actor.role`, `actor.channel` | present | present |
| `actor.ref` | **absent** | `"staff-4471"` |
| `caseRef` | **absent** | `"TKT-90210"` |

Withholding is not hiding. That a member of staff read her record is precisely
what she is owed under Section 11 - it is the headline of the feature. *Which*
member of staff is the adopter's own employee's personal data, retained under the
adopter's employment basis, and the ticket reference is the adopter's internal
case data. Neither is hers to receive. The fields are **absent**, not `null` - a
null `ref` is still a field where an employee's id used to be.

Her own read of her own trail is not itself recorded. Logging a data principal's
access to their own record would turn the right of access into a write path.

> **Why `?limit=` exists.** Under the partition rule a principal's own acts
> produce single-digit stored rows. But `operator_lookup` and
> `operator_trail_read` rows are filed under the **subject's** `principalId`, not
> the acting operator's - so a person the back office looks at often carries far
> more stored rows than their own activity predicts. That is the one input the
> partition rule does not bound. `?limit=` is 1 to 1000, default 500; anything
> else, including `?limit[$ne]=1`, is a `400`. `truncated` and `totalEntries` say
> honestly whether you have seen everything. There is no cursor, by decision -
> `sanitizeFilter` on this library's connections makes a range filter like
> `{at: {$lt: c}}` a `CastError`, and the only escapes bypass the connection's
> one structural injection guard.

---

## 6. She asks to be erased

Asha asks Kavach to delete what it holds about her, and its staff action the
request.

Filing that request through the toolkit is `POST /rights/exercise` with
`{"right":"erasure"}`. It returns an `RQ-` reference and adds one derived
`rights_request_filed` entry to her timeline, read off `RightsRequest.createdAt`.
Asha asked over the phone, so this run has no such entry - which is why the
eighteen-row table further down has none either.

`erasePrincipalPII` is exported and **deliberately not mounted on any route**.
Erasure is irreversible, and this library cannot verify that whoever is asking is
who they say they are.

```js
const { erasePrincipalPII } = require("dpdp-fiduciary-toolkit");
await erasePrincipalPII({ models, principalId });
// -> { principalId, erasedAt: 2026-09-04T12:00:12.312Z, alreadyErased: false }
```

### What is cleared, and what survives

The `Principal` document before and after, with `_id`, `__v`, `createdAt` and
`updatedAt` elided (erasure sets `updatedAt` to the same instant as
`erasedAt`):

```json
// before
{ "principalId": "18a11b09…",
  "pii": { "name": "Asha Rao", "email": "asha@example.com", "phone": "9876543210", "dob": "1990-04-01T00:00:00.000Z" },
  "emailHash": "3842ef2f…", "phoneHash": "aa84146f…",
  "isMinor": false, "erasedAt": null }

// after
{ "principalId": "18a11b09…",
  "isMinor": false,
  "erasedAt": "2026-09-04T12:00:12.312Z" }
```

The whole `pii` sub-document is gone. Both lookup hashes are gone. If she had
been a registered minor, her guardian's name, email and relationship would be
gone too - that asymmetry was a real defect once, since the child's own email is
a keyed HMAC and was destroyed while the parent's sat in plaintext on a document
already stamped `erasedAt`.

Two fields are retained deliberately, and neither names anybody:

- `isMinor` - a bare boolean on a now-pseudonymous record. It is what makes the
  retained ledger legible: a child's ledger has no marketing or analytics events
  because Section 9 prohibits them, and without this flag that absence cannot be
  told apart from an adult who simply declined.
- `parentalConsent.verifiedAt` - a fact about the fiduciary's own process, not
  personal data about the guardian, and the only surviving evidence that the
  retained consent events had the basis Section 9 requires.

**The consent ledger survives untouched.** That is the reason `Principal` and
`ConsentRecord` are separate documents at all: the Act requires PII to be
erasable *and* requires the fiduciary to retain proof it had a lawful basis. In
one document those duties are mutually exclusive. Split, erasure clears one while
the pseudonymous other stands.

`trailentries` survives for the same reason and is a different case from the
free-text collections. Erasure writes nothing to it, edits nothing in it and
deletes nothing from it - the erasure is read back from `Principal.erasedAt`, so
the trail needs no row of its own to report it.

### What she gets from her own reads

`GET /consent` still answers, with `pii: null` and `erasedAt` set so the caller
knows *why* it is null. Her six ledger events are all still there, including the
`underwriting` withdrawal from scenario 3.

`PUT /consent` now refuses:

```json
409 { "error": "This data principal's record has been erased and cannot be updated" }
```

Erasure is terminal. Without that guard an authenticated caller - or anyone
holding a session issued before the erasure - could write PII straight back onto
a record stamped `erasedAt`, which is the worst possible artefact to hand a
regulator. The refusal is thrown before any write, so a stored `consent_refused`
/ `record_erased` row is the last thing that will ever happen on the record.

### Her timeline afterwards

```json
[
  { "at": "…12.320Z", "kind": "consent_refused",   "source": "stored",  "outcome": "refused",
    "actor": {"role":"principal","channel":"api"}, "reasonCode": "record_erased" },
  { "at": "…12.312Z", "kind": "principal_erased",  "source": "derived", "outcome": "recorded",
    "actor": {"role":"unattributed","channel":"library"} },
  { "at": "…12.305Z", "kind": "operator_trail_read", "…": "still there" },
  { "at": "…12.302Z", "kind": "operator_lookup",     "…": "still there" }
]
```

`principal_erased` is **derived** from `Principal.erasedAt`. And its actor is
`unattributed`, not `principal` - `erasePrincipalPII` is unmounted, so erasure is
always fiduciary-side, and stamping it `principal` would attribute the
fiduciary's own act to the person it was done to.

Every earlier row survives, and no row anywhere contains her name, her email, her
phone number, or a hash of either. `test/trailread.test.js` proves the stronger
version of that: it walks every string in every trail row against an allow-list
of enums and library-generated identifiers, and separately asserts that both
lookup hashes appear in **zero documents in any collection**.

### She is now unreachable by email, permanently

Erasure unset `emailHash`. So:

```bash
curl -s localhost:4000/back-office/principals/lookup -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -d '{"email":"asha@example.com","caseRef":"TKT-90311"}'
```

```json
404 { "error": "No data principal matches that contact detail" }
```

And the row it writes has **no subject at all**:

```json
{ "kind": "operator_lookup", "outcome": "refused", "reasonCode": "no_match",
  "actor": { "role": "operator", "ref": "staff-4471", "channel": "api" },
  "caseRef": "TKT-90311" }
```

`principalId` is absent - not `null`. A lookup that matched nobody has no data
principal to file under, and a stored `null` would be a subject-shaped hole a
later read could mistake for one.

Her retained pseudonymous record is still reachable **by `principalId`**:
`POST /back-office/principals/trail` with the id returns her full trail, and her
own `GET /consent/trail` still works as long as the host's session store still
maps her session to that id - erasure does not touch the host's sessions.

**This is by design, and it is a real operational consequence.** If Asha phones
back next month and says "please show me my record", and all anyone has is her
email address, there is no supported way to find her. The email-to-person index
is the thing erasure exists to destroy. Put the `principalId` - and the `RQ-`
reference, if the request came through `POST /rights/exercise` - on the
fiduciary's own case file *before* running the erasure, or accept that the record
is unreachable by any contact detail from that moment on.

---

## The whole run, in order

Eighteen entries after six scenarios, newest first. This is what
`GET /consent/trail` returns with no `?limit=`.

| `at` | `source` | `kind` | `outcome` | scenario |
| --- | --- | --- | --- | --- |
| …12.329Z | stored | `operator_trail_read` | recorded | 6 - back office re-reads by id |
| …12.320Z | stored | `consent_refused` (`record_erased`) | refused | 6 |
| …12.312Z | derived | `principal_erased` | recorded | 6 |
| …12.305Z | stored | `operator_trail_read` | recorded | 5 |
| …12.302Z | stored | `operator_lookup` | recorded | 5 |
| …12.295Z | stored | `request_status_changed` (escalated→resolved) | recorded | 4 |
| …12.294Z | derived | `grievance_escalated` | recorded | 4 |
| …12.290Z | stored | `request_status_changed` (open→in_progress) | recorded | 4 |
| …12.288Z | stored | `escalation_refused` (`sla_not_lapsed`) | refused | 4 |
| …12.284Z | derived | `grievance_filed` | recorded | 4 |
| …12.277Z | stored | `withdrawal_not_applied` (`not_withdrawable`) | refused | 3 |
| …12.276Z | derived | `consent_withdrawn` (`underwriting`) | recorded | 3 |
| …12.266Z | stored | `withdrawal_not_applied` (`not_withdrawable`) | refused | 2 |
| …12.239Z | derived | `consent_denied` (`analytics`) | recorded | 1 |
| …12.239Z | derived | `consent_denied` (`marketing`) | recorded | 1 |
| …12.239Z | derived | `consent_granted` (`underwriting`) | recorded | 1 |
| …12.239Z | derived | `consent_granted` (`identity_verification`) | recorded | 1 |
| …12.239Z | derived | `consent_granted` (`kyc_reporting`) | recorded | 1 |

Nine of those are derived, nine are stored. Ordering is `at` descending, then
stored ahead of derived at the same instant, then insertion order descending.

If you want to see all of this asserted rather than narrated, the executable
version of exactly these six stories is:

| File | Covers |
| --- | --- |
| `test/trailread.test.js` | the merged read, the partition rule, ordering, `limit`, erasure, the operator-ref gate |
| `test/trailconsent.test.js` | scenario 1's refusals and no-ops, the fail-open policy, the writes deliberately *not* made |
| `test/backoffice.test.js` | scenario 5 - operator auth, record-before-disclose, fail-closed, the two surfaces staying apart |
| `test/readpath.test.js` | `GET /consent/trail` over HTTP - scoping, caching headers, withholding |
| `test/auth.test.js` | who a refusal is attributed to, and on which channel |

---

## What none of this promises

- **It is not retroactive.** Acts before the coverage date left no entry, and no
  backfill is possible or permitted. `coverageFrom` says where the record begins.
- **It is not a completeness claim.** Instrumentation writes fail open, so a
  failed trail write leaves the act intact and the trail with a hole. It is
  evidence of what was recorded, not proof that nothing else happened.
- **Erasure reaches the `Principal` document only.** If Asha typed her own name
  or address into the free text of a grievance, a rights request or a
  consent-manager request, that text is still in those three collections.
  Redacting free text is a judgement call an automated pass gets wrong, so it is
  left to the fiduciary's own process. A deployment that treats
  `erasePrincipalPII` as completing a Section 12 request without also reviewing
  those three collections has not completed it.
- **`actor.ref` bounds shape, not meaning.** `assertOpaqueRef` admits
  `"johnsmith"`. A host that wires its SSO subject straight through puts its own
  staff member's personal data on a collection nothing deletes from, under the
  host's own basis.
- **This is a reference implementation.** Not legal advice, and not a certified
  compliance product. The statute is the **Digital Personal Data Protection Act,
  2023**; the DPDP Rules, 2025 are a separate instrument.
