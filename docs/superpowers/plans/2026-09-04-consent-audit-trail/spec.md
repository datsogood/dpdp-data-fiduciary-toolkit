# Consent audit trail - design

Issue: [#4](https://github.com/datsogood/dpdp-data-fiduciary-toolkit/issues/4) - "Consent audit trail implementation"
Branch: `feat/consent-audit-trail`
Folder: `docs/superpowers/plans/2026-09-04-consent-audit-trail/`
Date: 2026-09-04
Status: proposed, awaiting review

---

## 1. The problem

The issue asks for two things:

> capture the audit trail of a given consent, to show the lineage of the actions
> performed by an user at various points on a timeline. This story focuses on
> capturing this lineage in the database and provide GET API to retrieve the
> consent, given a direct PII.

Today the toolkit can answer "what did this person end up consenting to". It
cannot answer "what did this person do, and what did we tell them" - which is
the question a Grievance Officer, a Section 11 access request, and the Data
Protection Board all actually ask.

## 2. What exists today, and where it stops

`ConsentRecord.events` is an append-only array of consent state changes. It has
exactly two writers: `persistPIIwithconsent` and `withdrawConsent`. Twelve of
the fourteen write sites in `src/` append nothing to it.

Verified against the code, the following leave **no trace anywhere**:

| Act | Site | What survives today |
| --- | --- | --- |
| A withdrawal refused as non-withdrawable | `withdrawConsent.js:50-56` | Nothing. `save()` is skipped entirely at `:75` |
| A withdrawal naming an unknown purpose | `withdrawConsent.js:45-48` | Nothing |
| A withdrawal of something not currently granted | `withdrawConsent.js:58-62` | Nothing |
| A re-grant submitted without `regrant:true` | `persistPIIwithconsent.js:297` | Nothing. Returns 200 with a receipt naming no event |
| A purpose refused for a child | `persistPIIwithconsent.js:186-189` | Nothing. Returned in the response, never persisted |
| A minor refused by the age gate | `persistPIIwithconsent.js:129-131` | Nothing. Thrown before any write |
| An update rejected on an erased record | `router.js:354`, `principalId.js:205` | Nothing |
| A rights request advancing `received -> in_progress -> closed` | `requestLifecycle.js:42-46` | Only the latest status. **The prior value is overwritten in place and destroyed** |
| A grievance advancing, or an escalation refused | `requestLifecycle.js:42-46`, `complaintToTheBoard.js:94,:99-102,:103-108` | Only the latest status; refusals leave nothing |
| A contact-detail correction | `principalId.js:228-239` | Nothing. **The old `emailHash` is overwritten and destroyed** |
| Someone else's email submitted on `PUT /consent` (the C1-with-an-account attempt) | `router.js:269-279` | Nothing |
| A back-office disclosure of a principal's record | n/a | Nothing. There is no access log of any kind |

And on every event that *is* written: no actor, no channel. `consentEventSchema`
is declared `{_id: false}` (`ConsentRecord.js:24`), so an event is not
addressable, indexable or citable either.

## 3. Settled decisions

These were decided with the maintainer before design and are not reopened here.

- **D1 - Hybrid storage.** `ConsentRecord.events` stays exactly as it is. It is
  the legal consent ledger with a documented charter (`ConsentRecord.js:3-13`),
  a three-value status enum, and 23 existing tests asserting on it. A new
  collection holds what the ledger cannot.
- **D2 - Two surfaces ship.** An unmounted service function, and a separate
  back-office router factory.
- **D3 - Raw PII never appears in a URL.** Contact values travel in a POST body.
- **D4 - The HTTP lookup is email-only.** It refuses the phone branch, matching
  what `router.js:311-317` already does for signup.
- **D5 - Full lineage including refusals and silent no-ops.**
- **D6 - The trail stores no free text and no direct PII.**
- **D7 - Operator identity and an access record are in scope, not follow-ups.**

## 4. The partition rule

This is the load-bearing idea of the design, and everything else falls out of it.

> **The trail stores only facts that are destroyed, or never written, anywhere
> else. Everything a read can recover from a primary collection is derived at
> read time, never copied.**

A first draft of this design stored a trail row for every act, then ran a dedup
pass over the merged read to avoid double-reporting. That dedup layer was about
120 lines and existed purely because the design had never decided whether an act
the ledger records also writes a trail row. Deciding it deletes the layer:
double-reporting becomes impossible by construction.

**Derived at read time** (a real, observed timestamp already exists):

| Act | Source of truth |
| --- | --- |
| Consent granted / denied / withdrawn | `ConsentRecord.events[].timestamp` |
| Which notice was in force for an event | `ConsentRecord.events[].noticeVersion` |
| Rights request filed | `RightsRequest.createdAt` |
| Grievance filed | `Grievance.createdAt` |
| Grievance escalated to the Board | `Grievance.escalatedAt` |
| Consent-manager handoff requested | `ConsentManagerRequest.createdAt` |
| PII erased | `Principal.erasedAt` |

**Stored in the trail** (nothing survives otherwise):

| Act | Why it cannot be derived |
| --- | --- |
| Consent refusals and silent no-ops | No document is written at all |
| Withdrawal refusals and no-ops | `save()` is skipped |
| Request status transitions | `requestLifecycle.js:43` destroys the prior status; `updatedAt` holds only the last change |
| Escalation refusals | Nothing is written |
| Contact corrections | The old hash is overwritten |
| Age-gate refusals | Thrown before any write |
| The `assertOwnContact` 403 | Throw only |
| Back-office lookups and trail reads | Nothing records a disclosure |

We do **not** reconstruct a fact whose timestamp nobody observed. A status that
moved `received -> in_progress -> closed` cannot have its middle transition
inferred from `updatedAt`; that is why transitions are stored rather than
derived. Inventing a timestamp would be manufacturing evidence, which is the one
thing an audit trail must never do.

## 5. Data model

New file `src/models/TrailEntry.js`, model `TrailEntry`, collection
`trailentries`. One hand-added line in `src/models/index.js`.

**On the name.** Not `AuditEvent`: `ConsentRecord.js:3-4` already says of the
ledger "this is the audit trail DPDP expects a fiduciary to be able to produce",
and a second collection claiming that word contradicts a comment that ships
today. `README.md:565-566` also disclaims being "a certified/audited compliance
product". A *trail entry* is a part of the trail, not the trail; the trail is the
merged read across six collections - this one, plus `ConsentRecord`,
`Principal`, `RightsRequest`, `Grievance` and `ConsentManagerRequest`.

```js
const trailEntrySchema = new Schema({
  // Absent - not null - on the two kinds that have no subject: an age-gate
  // refusal is thrown before findOrCreatePrincipal runs, and a back-office
  // lookup that matched nobody has no principal to file under.
  principalId: { type: String, index: true },
  at:   { type: Date, required: true, default: Date.now },
  kind: { type: String, enum: KINDS, required: true },
  // recorded - the act took effect
  // refused  - the library declined it and said so
  // no_change - the caller got a 2xx and nothing happened
  outcome: { type: String, enum: ["recorded", "refused", "no_change"], required: true },
  reasonCode: { type: String, enum: REASON_CODES },
  actor: { type: actorSchema, required: true },
  // Reference ids only, never free text. All are random and carry no PII.
  refId:     { type: String },   // RQ- / GR- / CM-
  receiptId: { type: String },   // RC-
  // A LIST, because section 6 collapses refusals: one call refusing three
  // purposes writes one row naming three. Verified - a scalar String path
  // rejects an array with "Cast to string failed ... (type Array)".
  //
  // Every element is validated against getValidConsentTypes() BY THE WRITER
  // and dropped when it does not match. A withdrawal naming an unknown purpose
  // carries caller-supplied text (withdrawConsent.js:45-48 pushes it verbatim,
  // and assertStringArray applies no content check), so an email typed into
  // consentTypes would otherwise reach a collection that survives erasure.
  consentTypes: { type: [String], default: undefined },
  // The transition requestLifecycle.js destroys in place.
  fromStatus: { type: String },
  toStatus:   { type: String },
  // Collapsed refusals: one row per (kind, reasonCode) per call.
  count: { type: Number },
  // The adopter's own ticket reference for a back-office access, so the record
  // says WHY someone was looked up and not only by whom. Host-supplied and
  // opaque; carried only on operator_lookup and operator_trail_read. Never
  // rendered back to a data principal. Guarded by assertOpaqueRef below.
  caseRef: { type: String },
});
```

`actorSchema` is `{ role, ref, channel }`, `{_id: false}`:

- `role`: `principal | operator | system | unattributed`. `unattributed` is not a
  synonym for `system` - it means the library genuinely does not know, and
  claiming otherwise would be a claim it cannot back.
- `ref`: set only for `operator`. Host-supplied and opaque. Guarded by
  `assertOpaqueRef` - see below.
- `channel`: `html | api | library`.

**`assertOpaqueRef(value, field)`**, a new helper in `src/utils/validate.js`,
guards both `actor.ref` and `caseRef`:

```js
const OPAQUE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
```

A **positive** shape, not a blocklist. An earlier draft rejected any value
containing `@`, on the theory that it would stop a host wiring its SSO subject
straight through and putting a live email on a record that outlives erasure -
H9 rebuilt in a new collection. That guard is the wrong shape twice over: it
stops an email and nothing else, so a staff member's name or a phone number
passes it unharmed, and it is a blocklist in a file whose only existing
discipline is a positive regex (`validate.js:3`, `PRINCIPAL_ID_RE`). The
character class above admits a staff id, a UUID, an LDAP uid and a ticket
reference, and admits no address, no phone number with punctuation, no spaces
and therefore no sentence. It is not a guarantee - `johnsmith` still passes -
and residual 4 says so plainly rather than implying otherwise.

**Indexes.** Field-level flags only: `principalId` and `actor.ref`. No compound
index, no unique index, no `schema.index()` call - the repo has none today, and
with the partition rule the per-principal volume is single digits, so a compound
index would be the first deviation in the repo bought with nothing.

**Ordering.** `(at desc, _id desc)`. No sequence number, no ordinal, no
`dedupeKey`. Within one millisecond the order between two rows is insertion
order by ObjectId, which is honest and adequate; a monotonic per-principal
sequence would need a unique index plus retry-on-collision, and it buys ordering
precision nobody reads.

**There is no contact-hash field, at all.** This is the strongest form of the
invariant and it is why the schema above has no `lookupHash`. A matched
back-office lookup files under `principalId`; a lookup that matched nobody stores
no subject whatsoever, only that an operator searched and found nothing.

Two separate hazards are closed by the field's absence:

- A row carrying `lookupHash` *and* `principalId` would rebuild the email-to-person
  index erasure exists to destroy. The fiduciary holds `PRINCIPAL_ID_SECRET`, so
  it could recompute `lookupHash("asha@...")` at any time and rejoin an erased
  person to their surviving record forever - the precise reversal of
  `erasure.js:11-13`.
- A row carrying `lookupHash` on a *miss* would create a permanent
  contact-derived identifier for someone who is not a data principal of this
  fiduciary at all: no notice, no consent, no erasure path, no lawful basis for
  retaining it.

An earlier draft closed the first hazard with a schema validator enforcing mutual
exclusion. That does not hold: verified against mongoose 8.24.2, `updateOne` does
not run document validators, so a later `$set` would co-store both silently. A
field that does not exist cannot be set.

The accountability D7 asks for is unharmed. Detecting insider enumeration is a
question of per-operator volume, which the `actor.ref` index answers. *Which*
addresses were probed is forensics, not accountability, and it is the only part
that manufactures a new category of personal data.

## 6. Event vocabulary

Eleven kinds. Every one exists because something is otherwise destroyed.

| Kind | Outcome(s) | Reason codes |
| --- | --- | --- |
| `consent_not_applied` | `no_change` | `regrant_not_requested`, `already_in_state` |
| `consent_refused` | `refused` | `prohibited_for_child`, `unknown_consent_type`, `record_erased` |
| `withdrawal_not_applied` | `refused`, `no_change` | `not_withdrawable`, `unknown_consent_type`, `not_granted` |
| `age_gate_refused` | `refused` | `parental_consent_required` |
| `request_status_changed` | `recorded` | - |
| `escalation_refused` | `refused` | `already_resolved`, `already_escalated`, `sla_not_lapsed` |
| `contact_corrected` | `recorded` | - |
| `contact_mismatch_refused` | `refused` | `not_own_contact` |
| `withdrawal_hook_not_fired` | `recorded` | - |
| `operator_lookup` | `recorded` | `no_match` |
| `operator_trail_read` | `recorded` | - |

`consent_refused` also carries reason code `record_erased`, for the 409 at
`router.js:355` and the matching guard in `updatePrincipalContact`
(`principalId.js:204`). Section 2's table lists that refusal and an earlier
draft accounted for it nowhere - neither stored, derived, nor cut.

`withdrawal_hook_not_fired` is the one kind whose justification is not obvious,
so it is argued in full. `PUT /consent` can withdraw a purpose by omission
(`decide`, `persistPIIwithconsent.js:305`), but `persistPIIwithconsent` has no
`onWithdrawal` parameter and `router.js:360-371` passes none - so on that path
the host's cease-processing pipeline is never told. The withdrawal itself is in
the ledger and is therefore derived, not stored. **That the hook did not fire is
recorded nowhere at all**, which is exactly what the partition rule says to
store. It is also the fact a fiduciary most needs: it names a Section 6(6)
cessation duty that may have gone undischarged.

**There is no marker row.** An earlier draft wrote a single `trail_opened` row
per deployment to carry `coverageFrom`. Four independent reviews rejected it and
they were right on the facts: the row could not be written against this schema
at all, because `actor` and `outcome` are both `required: true` and the marker
was specified as having neither - verified, `ValidationError: Path 'actor' is
required`. Under the fail-open rule of section 8.2 that failure would have been
silent, so `coverageFrom` would have been permanently absent and the one device
stopping an empty trail from implying nothing happened would have quietly not
existed. It also bought a singleton-write path, a boot-time race and one query
per trail read. `coverageFrom` is instead a module constant in
`src/services/consentTrail.js`, set to the release date and returned verbatim.

**Refusals are never mistakable for successes.** `outcome` is a required field
and a refusal is `refused`; there is no kind whose name reads as a state change
without one.

**Collapsing.** A submission naming 200 consent types must not write 200 rows.
The writer emits at most one row per `(kind, reasonCode)` per call, carrying
`count` and, only for catalog-valid types, the type list. An authenticated
principal can otherwise force roughly 17,000 inserts from one 100kb request.

## 7. What is deliberately not captured

Each of these was proposed and cut, with the reason.

- **The signup 409** (`router.js:317-320`). Recording it against the resolved
  principal would let an unauthenticated stranger who knows an email append rows
  to *that person's* trail, unthrottled - `README.md:612-618` rules out shipping
  rate limiting. Because reads are newest-first and bounded, that is also an
  evidence-burial primitive.
- **The anonymous notice render** (`GET /consent/new`, `router.js:292-295`). It
  is the one deliberately unauthenticated page in the toolkit and GET is exempt
  from `checkOrigin` (`router.js:160`), so instrumenting it makes a cross-site
  `<img>` or a crawler into a database write.
- **The 401 and the cross-origin 403.** Neither has an identity by definition.
- **The principal's own reads of `GET /consent`.** Logging them would make the
  Section 11 right of access a write path and change its cost profile.
- **IP address and user-agent.** They are personal data the library has no basis
  to retain, and the host already has them in its own access logs.
- **A minor-to-adult transition.** It partially reconstructs a date of birth that
  erasure deliberately destroys, and the retained `isMinor` boolean already
  serves the purpose (`erasure.js:61-66`).
- **Any free text.** `Grievance.description`, `RightsRequest.details` and
  `ConsentManagerRequest.message` survive erasure by documented decision
  (`erasure.js:21-29`, `README.md:605-611`). Copying them into a collection that
  also survives erasure would surface PII on a record the system reports as
  `pii: null`.

## 8. Read and write contracts

### 8.1 The trail read

New file `src/services/consentTrail.js`.

```js
getConsentTrail({ models, principalId, limit = 500 })
  -> { principalId, docRef, coverageFrom, timeline: [...], truncated, totalEntries }
```

It merges the stored entries with the derived events of section 4, sorts by `at`
descending, and returns them. **No cursor.** `sanitizeFilter`
(`db/connection.js:29`) rewrites `{at: {$lt: c}}` into `{at: {$eq: {$lt: c}}}`
which CastErrors - verified empirically, and the query-builder forms
`.where("at").lt(c)` and `.lt("at", c)` are broken by it too. The only escapes
are `mongoose.trusted()` and `aggregate()`, and `trusted()` is a total bypass of
the connection's one structural injection guard. Under the partition rule a
normal principal has single-digit stored entries, so a bounded read with an
explicit `truncated` flag and a `totalEntries` count is honest and needs neither.

`coverageFrom` is a module constant in `src/services/consentTrail.js`, set to
this feature's release date and returned verbatim. It exists so a trail with
nothing in it can say "we were not recording before this date" rather than
implying nothing happened. See section 6 for why it is not a stored row.

**The timeline element.** Every entry, stored or derived, has the same shape, so
a consumer never branches on where it came from:

```js
{
  at,                  // Date
  kind,                // string - section 6 for stored, the table below for derived
  source,              // "stored" | "derived"
  outcome,             // "recorded" | "refused" | "no_change"
  actor: { role, channel },   // derived entries are always { role: "principal", channel: "library" }
  reasonCode,          // stored refusals only, else undefined
  refId, receiptId, consentTypes, fromStatus, toStatus, count,  // undefined when not applicable
}
```

`actor.ref` and `caseRef` are **withheld from this shape** on the
principal-facing read - see 8.5. They are present on the back-office read.

The derived `kind` vocabulary, one per row of section 4's derived table:

| Derived kind | Source | `at` |
| --- | --- | --- |
| `consent_granted` / `consent_denied` / `consent_withdrawn` | `ConsentRecord.events[]` | `event.timestamp` |
| `rights_request_filed` | `RightsRequest` | `createdAt` |
| `grievance_filed` | `Grievance` | `createdAt` |
| `grievance_escalated` | `Grievance` | `escalatedAt` |
| `consent_manager_requested` | `ConsentManagerRequest` | `createdAt` |
| `principal_erased` | `Principal` | `erasedAt` |

**Ordering.** `at` descending. Ties are broken by `source` (stored before
derived) and then by insertion order - `_id` descending for stored rows, array
position descending for ledger events. A tiebreak is genuinely needed rather
than theoretical: `persistPIIwithconsent.js:146` stamps every event of one
submission with the same `now`, so a signup granting three purposes produces
three derived entries with identical timestamps, and `consentEventSchema` is
`{_id: false}` (`ConsentRecord.js:24`) so they have no id to fall back on.

`limit`, `truncated` and `totalEntries` count **merged entries**, not stored
rows. `truncated: true` means the timeline was cut and the caller has not seen
everything; `totalEntries` is the full count so the caller knows by how much.

### 8.2 The failure policy

Two rules, with different reasoning.

**Instrumentation writes fail open.** A trail write that fails logs `err.name`
and `err.code` (never `err.message`, which can quote a caller-supplied value
back) and the underlying act proceeds. The trail must never take down consent
capture, withdrawal, or the refusal message a principal needs to read - turning
`persistPIIwithconsent`'s 422 into a 500 would leave a minor with no explanation,
which is the exact class of defect the audit remediation already fixed. The
precedent is in the repo: `onGrievanceFiled` throws do not fail the request
(`router.js:80-83`).

Consequently the design makes **no completeness claim**. The README will say
plainly that the trail is evidence of what was recorded, not proof that nothing
else happened - the same register as "recorded", never "sent"
(`README.md:353-365`).

**Back-office disclosure writes fail closed.** If the access record cannot be
written, the disclosure does not happen: 503, no data. This is the whole point of
D7 - an unaudited people-search is worse than no people-search. No record, no
disclosure. The precedent is the other half of the same pair: `onWithdrawal`
throws *do* fail the request (`router.js:76-79`).

### 8.3 The unmounted library function

```js
findConsentTrailByContact({ models, email, phone })
```

Exported from `src/index.js`, mounted on nothing, documented in the repo's
existing "deliberately NOT mounted, and here is why" voice. Internally
`findPrincipalByContact` (unchanged, 409-on-ambiguous-phone intact) then
`getConsentTrail`. It keeps the phone branch because a direct library caller is
already inside the host's trust boundary.

### 8.4 The back-office router

New file `src/http/backOfficeRouter.js`, plus `src/http/shared.js` extracting
`{ errorMapper, wrap, makeCheckOrigin }` from `router.js` - one shared file, not
two, because duplicating a security check across two routers is worse than
sharing it.

```
POST /principals/lookup      { email, caseRef? }  -> { principalId }
POST /principals/trail       { principalId, caseRef? } -> the trail
```

Both are POST. The lookup is POST because of D3. The trail read is POST because
under D7 it performs a database write, and GET is exempt from `checkOrigin`
(`router.js:160`) - a cross-site-triggerable write into the accountability
record, attributed to a signed-in operator, is not acceptable. It also keeps the
principalId out of access logs and `Referer`.

**`principalId` in a request body is a deliberate carve-out from a rule this
branch otherwise treats as absolute,** and it is named here rather than left for
a reviewer to find. The audit-remediation plan's Global Constraints say
"`principalId` is never read from `req.body` or `req.query` on any route", and
`README.md:122-124` states it as an unqualified property of the library. That
rule exists because on the principal-facing router `principalId` would be a
**credential**: reading it from a payload is the C1 attack, letting anyone who
knows an id act as that person.

On `POST /principals/trail` it is not a credential, it is a **query subject**.
Four things have to hold for that distinction to be sound, and all four do:

1. Operator identity still comes only from `resolveOperator(req)`, never from the
   payload. The rule is unchanged for the thing it protects.
2. The operator is not the subject, so there is no privilege to escalate by
   naming a different id - an operator authorised to read one principal's trail
   is authorised to read any, which is what a back office is.
3. `assertPrincipalId` runs before the value reaches any filter, so the
   injection half of the rule is enforced exactly as elsewhere.
4. The route is gated by operator auth AND a fail-closed access record, so every
   use of the carve-out is attributable.

The rule stays absolute where it was written to apply: `createRouter`'s
principal-facing routes. `README.md:122-124` must be rewritten to say so rather
than left as an absolute sentence the library no longer satisfies - see section
9.

`resolveOperator(req) => { actorRef }` mirrors `resolvePrincipal`: fails closed
with 401 when absent. The entire shape check sits **inside** the try/catch, and
the value is copied out defensively, so a hostile or throwing hook 401s rather
than crashing the process.

`caseRef` is an optional host-supplied opaque reference to the ticket the access
is for. Without it the log records who looked someone up but never why, which is
the one distinction it exists to make - answering a Section 11 request versus
browsing.

**The factory refuses to build without an explicit acknowledgement:**

```js
createBackOfficeRouter({ db, resolveOperator, rateLimitedByHost: true })
```

Omitting it throws at startup, the way `assertConfigured` does. This ships a
people-search over a guessable keyspace in a package that does not ship rate
limiting by documented decision; the repo's own answer to that class of hazard is
to fail at boot rather than in front of a data principal (`catalog.js:39-51`).

### 8.5 The principal's own trail

`GET /consent/trail` on the existing router: `requireAuth`, `noStore`, scoped to
`req.principalId`. It includes the operator-access rows with `actor.ref`
withheld, so a data principal exercising Section 11 can see **who looked at their
record**. This is the headline of the feature, not the back office.

## 9. Erasure, and the documentation this work falsifies

The trail survives erasure as pseudonymous evidence, exactly as `ConsentRecord`
does. Section 5's invariant plus the section 7 exclusions are what make that
true, and a test asserts the property directly rather than field by field.

`erasePrincipalPII` writes nothing new and edits nothing: erasure is derived from
`Principal.erasedAt` per section 4.

Shipping this feature makes several sentences that are true today false. Each is
a required edit, not a nice-to-have, and each is its own line item in the plan.
An adopter following documented procedure must not be left acting on a sentence
this branch invalidated.

| Location | What it says today | Why it becomes false | Required edit |
| --- | --- | --- | --- |
| `README.md:122-124` | `principalId` "is never read from a request body or query string on any route" | `POST /principals/trail` reads it from a body | Scope the claim to `createRouter`'s principal-facing routes; state the back-office carve-out and the four conditions in 8.4 |
| `README.md:387-390` | The same claim, restated for the read path | Same | Same |
| `erasure.js:21-29` | Names three collections holding free text that erasure does not reach | A fourth collection now survives erasure | Name the trail; state that erasure writes nothing to it, edits nothing in it, and deletes nothing from it, and that it holds no free text by construction |
| `README.md:605-611` | The same three-collection list in the erasure checklist | Same | Same |
| `README.md` obligation 7 | The audit trail must be available "at any point in time" | The trail is not retroactive | State that this closes obligation 7 forward from the release date only, and that no backfill is possible or permitted |
| `README.md:612-618` | Rate limiting is host middleware's job, stated as an informational residual | It becomes a hard prerequisite for the back-office mount | Upgrade it from a residual to a stated prerequisite for that mount specifically, and name the `rateLimitedByHost` acknowledgement |
| `README.md` "What this is not" | No entry for the trail | The feature needs its own limits stated in the house register | Add a paragraph covering: not retroactive, best-effort writes, no completeness claim, and that the back-office surface processes the adopter's own staff's personal data under the adopter's own basis |

The `PUT /consent` implicit-withdrawal gap (residual 7) also needs a plain
statement in the register of `README.md:598-604`: that path can withdraw a
purpose by omission, no hook fires, and the trail now records that it did not.

## 10. Test plan

Two new files, `test/trail.test.js` and `test/backoffice.test.js`, plus additions
to existing files. Roughly 40 cases, not 144 - the suite is 158 tests today and a
91% growth is not proportionate to the change.

The cases that catch real defects, and would each have caught a bug found during
design review:

1. **The twelve-act timeline.** One principal signs up, updates consent, is
   refused a withdrawal, files a grievance, escalates, is advanced twice, and is
   erased. `deepEqual` the whole returned timeline. This is the feature's
   executable documentation and it is written first.
2. **The PII scan.** After that timeline, walk every document in `trailentries`
   and assert every string value matches an allow-list of known-safe shapes,
   plus the non-vacuity inverse so the scan cannot pass by finding nothing.
3. **`lookupHash(erasedEmail)` appears in zero documents** anywhere in the
   database after erasure.
4. **An email submitted as a consent type appears nowhere in the trail.**
5. **`GET /consent/new` grows the trail by exactly 0**, and 20 duplicate-signup
   409s grow the victim's trail by exactly 0.
6. **A submission naming 200 consent types writes at most `getCatalog().length`
   rows.**
7. **No disclosure without a record**: force the access write to fail, assert 503
   and that no principal data was returned.
8. **A back-office route is not reachable on `createRouter`.**
9. Operator payloads (`{"email": {"$ne": null}}`) at every new entry point,
   following `injection.test.js`'s existing pattern.
10. One principal cannot read another's trail; 404 never 403.

## 11. Rejected alternatives

| Alternative | Why not |
| --- | --- |
| Extend `ConsentRecord.events` with new statuses | Its enum is three values with a documented charter, events have no `_id`, 23 tests assert on it, and activity-driven growth puts the 16MB BSON ceiling on the one document that must never fail to write |
| `GET /consent/audit?email=...` | Raw PII in access logs, browser history, `Referer` and CDN cache keys; `req.query` is not covered by the router's `extended:false` hardening, so `?email[$ne]=` yields an operator object on an Express 4 host; GET is exempt from `checkOrigin` |
| A principal-facing PII lookup | Either redundant (must equal your own) or a cross-principal read by construction, and it contradicts `principalId.js:84` |
| Cursor pagination | Needs `mongoose.trusted()`, which bypasses the connection's only structural injection guard, to buy ordering nobody reads over single-digit result sets |
| A monotonic sequence number | Needs a unique index plus retry-on-collision; `(at, _id)` is sufficient |
| Mongo transactions | The harness runs a standalone `mongod`; verified: "Transaction numbers are only allowed on a replica set member or mongos" |

## 12. Residual risks, stated not implied

1. **The trail is not retroactive.** It covers from the deploy date forward.
   `coverageFrom` says so explicitly. No backfill is possible or permitted.
2. **A trail write can be lost.** Instrumentation fails open, so the trail is
   evidence of what was recorded, not proof that nothing else happened.
3. **`actor.ref` is an employee's personal data**, retained in a collection
   nothing deletes from, under the adopter's own employment basis. The adopter
   owes their staff duties this library does not discharge.
4. **`assertOpaqueRef` bounds the shape of `actor.ref` and `caseRef`, not their
   meaning.** A host passing a staff member's login name, or a ticket id that
   happens to be a person's initials, produces a value that is structurally
   opaque and semantically identifying. The regex admits `johnsmith`. What it
   rules out is an address, a phone number with punctuation, and anything
   containing a space - so free text and contact details cannot arrive by
   accident, but a determined integrator can still put personal data there.
5. **The back-office lookup is still an existence oracle for staff.** A 200
   against a 404 tells an operator whether an address is registered, and with
   the fiduciary in the shipped catalog being a lender, "registered" means
   "applied for credit". The access record makes that *detectable after the
   fact* per operator; it does not prevent it. Volume limits are the host's.
6. **The existing `VersionError` hazard is untouched.** A concurrent
   array-modifying save on `ConsentRecord` still surfaces as a generic 500 with a
   lost append (`persistPII:249` catches only `err.code === 11000`). It is a real
   bug adjacent to this work and out of its scope; it is named here so it is not
   discovered as a surprise.
7. **`PUT /consent` can withdraw a purpose by omission without firing
   `onWithdrawal`,** so the host's cease-processing pipeline is never told
   (`persistPIIwithconsent.js:305`; `router.js:360-371` passes no hook). This
   spec records that fact as `withdrawal_hook_not_fired`, which means the trail
   produces written proof that a Section 6(6) cessation duty may have gone
   undischarged. That is the honest outcome and the README must say so plainly.
   An earlier draft claimed the trail recorded this as a side effect of
   recording the withdrawal. It did not and could not: the withdrawal is in the
   ledger and is therefore derived, so nothing distinguished a withdrawal that
   told the host from one that did not.
8. **The implicit-withdrawal path still has no hook.** Recording that it did not
   fire is not the same as firing it. Closing that gap means adding an
   `onWithdrawal` parameter to `persistPIIwithconsent`, changing the signature
   of an exported function on the consent write path - a change this feature
   should not be making.
