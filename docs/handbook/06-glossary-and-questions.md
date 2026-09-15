# 6. Glossary, and questions people actually ask

Two halves. The first is a dictionary you can skim when a word in a pull request
or a standup does not land. The second is the set of questions every new person
on this codebase asks in their first fortnight, answered properly.

A standing caution before either: this package is **not legal advice and not a
certified compliance product**. It is a reference implementation. Where a
question below touches what the law requires, it tells you what the code does
and what the repository's own reasoning is - your own counsel decides whether
that is enough for your deployment.

The statute is the **Digital Personal Data Protection Act, 2023**. The DPDP
Rules, 2025 are a separate instrument and are cited by their own name.

---

## Part 1 - Glossary

Alphabetical. Statutory terms and codebase terms are mixed together, because in
conversation they are.

**actor** - The `{ role, ref, channel }` object on a trail entry saying who did
the thing. `role` is one of `principal`, `operator`, `system` or `unattributed`;
`channel` is `html`, `api` or `library`. `ref` is set only for an operator. It
is required on every stored entry, including the ones whose honest answer is
"we do not know" - see **unattributed**. Defined in
`data-fiduciary-toolkit/src/models/TrailEntry.js`.

**back-office surface** - See **principal-facing vs back-office**.

**Board, the** - The Data Protection Board of India. Under Section 13 a data
principal must complain to the fiduciary's own Grievance Officer first; the
Board hears it only if that goes unresolved. In this codebase `escalateToBoard`
is **local bookkeeping only**: it sets `escalatedToBoard = true` and
`escalatedAt` on a `Grievance` document and contacts nobody. Not the same shape
of body as a GDPR supervisory authority - it is an adjudicating and
penalty-imposing body, not a general-purpose regulator you register with.

**caseRef** - Your own ticket reference, passed on a back-office request so the
access record says *why* someone was looked up and not only by whom. Optional,
host-supplied, shape-checked by `assertOpaqueRef`, stored on `operator_lookup`
and `operator_trail_read` rows, and never shown to the data principal.

**consent manager** - Under Section 6(7) to 6(9), an independent
Board-registered entity through which a data principal can give, manage and
withdraw consent across several fiduciaries. This toolkit is **not** one. It
records a request to be connected with one (`POST /consent-manager`, refIds
prefixed `CM-`) and hands off nothing, because it has no outbound channel.
There is no GDPR equivalent.

**coverageFrom** - A date string returned by every trail read, currently the
constant `"2026-09-04"` in `src/services/consentTrail.js`. It is the date the
trail feature shipped. It exists so an empty timeline reads as "we were not
recording before this date" rather than "nothing happened". There is no
backfill and none is permitted.

**data fiduciary** - The organisation that decides why and how personal data is
processed. Roughly the GDPR controller. This toolkit is written from the
fiduciary's side.

**data principal** - The person the data is about. Roughly the GDPR data
subject. Where the principal is a child, the Act treats the parent or lawful
guardian as acting for them.

**data processor** - Someone who processes personal data on the fiduciary's
behalf, under contract. Close to the GDPR processor, with one difference that
matters here: under the Act the fiduciary stays answerable to the data principal
for what its processors do. This library knows nothing about your processors and
cannot reach them - see the last question in Part 2.

**derived vs stored** - The two halves of a trail timeline, and the single most
important distinction in this repo. A **derived** entry is read at request time
out of a primary collection that already observed the fact with a real
timestamp: a consent event, a rights request, a grievance, an escalation, a
consent-manager handoff, an erasure. A **stored** entry is a row in the
`trailentries` collection, written because nothing else keeps the fact at all.
Every timeline element carries `source: "stored" | "derived"` so you can tell,
but both halves have the same shape, so nothing consuming the timeline has to
branch on it. See **the partition rule**.

**docRef** - The reference for a consent record, prefix `CN-`, minted once and
stable for the life of that record. Contrast **receiptId**, which is per
submission.

**DPDP Rules, 2025** - Subordinate rules made under the Act. A separate
instrument, cited by name, never folded into "the Act". Rule 3(c)(i) is the one
this codebase quotes most: withdrawal must be as easy as giving consent.

**erasure** - `erasePrincipalPII({ models, principalId })`, exported from
`src/index.js` and deliberately not mounted on any route. It clears the
`Principal` document's `pii`, both lookup hashes, and the guardian's contact
details, and stamps `erasedAt`. It retains `isMinor` and
`parentalConsent.verifiedAt` by decision, and it does not touch the consent
ledger, the free-text collections, or the trail. Irreversible.

**fail-open vs fail-closed** - The two halves of ADR 0003. `recordTrail` is
**fail-open**: a failed write is logged and the underlying act proceeds, so the
trail can never take down consent capture. `recordTrailStrict` is
**fail-closed**: a failed write throws a `503` and the back-office disclosure
does not happen. No record, no disclosure.

**kind** - What a stored trail entry is about, from a closed enum of eleven
values in `src/models/TrailEntry.js`: `consent_not_applied`, `consent_refused`,
`withdrawal_not_applied`, `age_gate_refused`, `request_status_changed`,
`escalation_refused`, `contact_corrected`, `contact_mismatch_refused`,
`withdrawal_hook_not_fired`, `operator_lookup`, `operator_trail_read`. Derived
entries carry a `kind` too (`consent_granted`, `consent_withdrawn`,
`grievance_filed` and so on), but those are computed at read time and are not in
the schema enum. The two sets do not overlap, which is what makes
double-reporting impossible.

**lawful basis** - The reason you are allowed to process someone's personal
data. Under this Act there are exactly **two**: the data principal's consent
(Section 6), and the enumerated "certain legitimate uses" in Section 7. This is
the biggest single trap for anyone arriving from GDPR, where there are six
grounds including legitimate interests and contractual necessity. Neither of
those exists here. In the code, `lawfulBasis.kind` on a catalog entry is either
`"consent"` or `"legitimate_use"`, and nothing else.

**ledger, the** - `ConsentRecord.events`, an append-only array of consent state
changes, one per real change, each with `{ type, status, basis, lawfulBasisKind,
receiptId, timestamp, noticeVersion }`. `status` is `granted`, `denied` or
`withdrawn` and nothing else. It holds no PII, so it survives erasure. When
someone in this repo says "the ledger" they mean this array, not the trail.

**legitimate use** - A Section 7 ground. Enumerated and narrow. The shipped
catalog has exactly one, `kyc_reporting`, resting on Section 7(d) - the
obligation to disclose information to the State - and modelled as covering the
reporting limb only. A purpose on a legitimate use is not a choice: it is
recorded once on signup, never rendered as a checkbox, and cannot be withdrawn.
**Not** GDPR's "legitimate interests", which does not exist under this Act.

**lookupHash** - `HMAC-SHA256(PRINCIPAL_ID_SECRET, value.trim().toLowerCase())`,
in `src/utils/principalId.js`. Stored as `Principal.emailHash` (unique, sparse)
and `Principal.phoneHash` (deliberately **not** unique). Keyed, so knowing
someone's email does not let an outsider compute the stored value. It is
pseudonymous, not anonymous, and pseudonymous data is still personal data.

**notice** - The Section 5 itemised statement that must accompany or precede a
request for consent: what data, what purpose, how to exercise rights, how to
complain. `buildNotice()` generates it from the live catalog so it cannot drift
from what the code actually processes, and content-addresses it by a SHA-256 of
its own body. Only English ships.

**noticeVersion** - The 16-hex-character content hash of the notice that was in
force when a given consent event was written. Stored on the event itself, not
just on the record, so an old event stays evidenced after a later submission
changes the notice. The bodies live in the `NoticeVersion` collection.

**outcome** - Required on every stored trail entry, one of `recorded` (the act
took effect), `refused` (the library declined and said so), or `no_change` (the
caller got a 2xx and nothing happened). This is the single field that stops a
refusal from ever being read back as a state change.

**partition rule, the** - ADR 0001, and the load-bearing idea of the trail
design: *the trail stores only facts that are destroyed, or never written,
anywhere else; everything a read can recover from a primary collection is
derived at read time and never copied.* An earlier draft recorded everything and
deduplicated on read, which needed about 120 lines of dedup that only existed
because nobody had made this decision. Deciding it deleted the layer.

**principal-facing vs back-office** - Two separate Express router factories that
must never share a mount. `createRouter` is principal-facing: every route is
scoped to the session principal, identity comes only from `resolvePrincipal`,
and there is no path to another person's data. `createBackOfficeRouter` is
operator-facing: nothing on it is scoped to a session principal, because staff
who may read one trail may read any. Its control is attribution, not scoping.

**principalId** - A random 32-byte value rendered as 64 lowercase hex
characters, minted server-side on first signup. **Never derived from an email
or anything else guessable** - an earlier version used `sha256(email)`, which
let anyone who knew an address act as that person. It is a database key, not a
credential: on every route `createRouter` mounts, it is resolved from the
session by `resolvePrincipal(req)` and never read from a body or query string.
On `POST /principals/trail` in the back office it is a **query subject**,
passed in the body, because the operator's own identity is established
separately; that is the one deliberate carve-out.

**reasonCode** - Why a stored entry has the outcome it has, from a closed enum:
`regrant_not_requested`, `prohibited_for_child`, `unknown_consent_type`,
`record_erased`, `not_withdrawable`, `not_granted`,
`parental_consent_required`, `already_resolved`, `already_escalated`,
`sla_not_lapsed`, `not_own_contact`, `no_match`. It is an enum precisely so it
can never carry free text.

**receiptId** - Prefix `RC-`, minted fresh on every consent submission or
withdrawal call. Every event that call writes carries it, so you can group the
events of one act. Contrast **docRef**, which is per record.

**refId** - The reference a data principal is given for something they filed:
`RQ-` for a rights request, `GR-` for a grievance, `CM-` for a consent-manager
request. Eight random bytes in hex, uppercase. Scoped reads use it inside the
filter, never as an afterthought, so someone else's refId 404s exactly like one
that does not exist.

**regrant** - The boolean you must pass to reverse a prior withdrawal. Listing a
withdrawn purpose again without it leaves it withdrawn and writes a
`consent_not_applied` / `regrant_not_requested` entry. Un-withdrawing is a
separate deliberate act, not a side effect of resubmitting a form.

**resolveOperator** - The function you pass to `createBackOfficeRouter` that
turns your staff session into `{ actorRef }`. Missing, throwing, or returning
anything else and every back-office route answers `401`.

**resolvePrincipal** - The function you pass to `createRouter` that turns your
own session into a `principalId`. This library owns no session store by design,
so this hook is the only source of identity on the principal-facing routes.
Missing, throwing, or resolving to anything that is not 64 hex characters and
the route answers `401`.

**significant data fiduciary** - A fiduciary the **Central Government notifies**
as such, based on factors including the volume and sensitivity of data processed
and the risk to data principals. It is a notification, not a threshold you
self-assess against. An SDF must appoint an India-based Data Protection Officer,
appoint an independent data auditor, and carry out periodic impact assessments
and audits. Nothing in this codebase detects or enforces SDF status.

**stored** - See **derived vs stored**.

**trail, the** - Not a collection. It is the merged, newest-first read across
six collections that `getConsentTrail` produces: the stored `trailentries` rows
plus what it derives from `ConsentRecord`, `Principal`, `RightsRequest`,
`Grievance` and `ConsentManagerRequest`. Answers "what did this person do, and
what did we tell them", which is a different question from the ledger's "what
did they end up consenting to".

**trail entry** - One row in the `trailentries` collection, or one element of a
trail timeline. The model is called `TrailEntry` and deliberately not
`AuditEvent`, because `ConsentRecord` already calls itself the audit trail and
two things in one repo claiming that word is how confusion starts.

**unattributed** - An `actor.role`, and **not** a synonym for `system`. `system`
is reserved in the enum for a *host* that has a genuine automated actor to
name; nothing in this library ever writes it, and the library deliberately
exports no constant for it, so a ready-made `SYSTEM` cannot sit beside
`UNATTRIBUTED` inviting the swap. `unattributed` means the library genuinely
does not know who acted - typically a direct call from host code. Every
derived entry carries `{ role: "unattributed", channel: "library" }`, because
the collection it was derived from recorded what happened and not who did it.
Naming a role nobody observed would be a claim the library cannot back.

---

## Part 2 - Questions people actually ask

### Why is there no "legitimate interests" basis? Can we add one?

Because the Act does not have one. Under the DPDP Act, 2023 there are exactly
two lawful bases: the data principal's consent under Section 6, and the
enumerated "certain legitimate uses" in Section 7. Legitimate interests is GDPR
Article 6(1)(f). Contractual necessity is Article 6(1)(b). Neither exists here.
The long comment at the top of the consent catalog in
`data-fiduciary-toolkit/src/config/catalog.js` says this in the code itself, and
it is there because getting it wrong is not cosmetic.

Can you add one? Mechanically, yes, and that is the danger. A catalog entry is a
plain object. Writing `lawfulBasis: { kind: "legitimate_use", clause: "..." }`
and `withdrawable: false` compiles fine and the library will honour it: when the
data principal later asks to withdraw that purpose, `withdrawConsent` puts it in
`rejected` with a message naming the clause, and refuses. You will have built a
machine that turns down a withdrawal the statute guarantees, and the refusal
will look principled because it quotes a section number.

So the rule is: a purpose is on `kind: "legitimate_use"` only if you can name the
specific Section 7 clause and defend that the clause actually covers what you are
doing. The shipped catalog does this once, for `kyc_reporting`, and even then
splits the purpose in two - the *disclosure* to the Financial Intelligence Unit
rests on Section 7(d), while verifying a customer's identity for the lender's own
records is a separate consent-based purpose (`identity_verification`). If your
lawyer cannot point at the clause, the answer is `kind: "consent"` and
`withdrawable: true`.

### Why can't I look someone up by phone number?

Over HTTP, you cannot, and that is deliberate. `POST /principals/lookup` in
`src/http/backOfficeRouter.js` reads `req.body.email` and nothing else.

The reason is not squeamishness about phone numbers, it is that in this
toolkit's stated audience a handset is shared across a household. `phoneHash`
on the `Principal` schema is explicitly **not unique**, with a comment saying
so. Two legitimate data principals sharing a number is normal here, not a
conflict. That has three consequences you will meet:

- Signup matches on `emailHash` only. A registration with no email **always
  creates a new principal**, so a mother and her daughter who both lack an email
  can both register. An earlier version matched on the shared number and 409'd
  the second person out of the system permanently.
- `findPrincipalByContact`'s phone branch does `.limit(2)` and throws `409` if
  two rows come back, rather than returning an arbitrary one. Returning a guess
  would issue a daughter who completed an OTP a session for her mother.
- The back-office HTTP surface refuses the phone branch outright, because that
  `409` is itself a disclosure: it tells the operator that two people share a
  handset.

If you are inside the host's trust boundary and can disambiguate a household
yourself, `findConsentTrailByContact({ models, phone })` keeps the phone branch,
409 included. It is exported from `src/index.js` and deliberately mounted on
nothing.

### Why is the audit trail a separate collection instead of just more events on the ledger?

This is ADR 0001. Four reasons, in rough order of how much they mattered.

`ConsentRecord.events` has a documented charter and a three-value status enum
(`granted`, `denied`, `withdrawn`). Twenty-three tests assert on it, and
`test/auth.test.js` byte-compares `JSON.stringify(ledger.events)` before and
after an attack to prove nothing moved. Widening that enum to carry refusals and
operator reads would break the one artefact whose stability is the point.

Consent events are subdocuments declared `{ _id: false }`, so an event is not
addressable, indexable or citable. That is fine for a ledger you always read
whole; it is not fine for rows you want to file under an operator and index.

Growth. Ledger entries are bounded by state change. Trail entries would be
bounded by activity, including back-office activity nobody's own behaviour
controls. Putting activity-driven growth inside a single document puts MongoDB's
16MB BSON ceiling on the one document that must never fail to write.

And the trail needs fields the ledger has no business carrying: `actor`,
`outcome`, `caseRef`. A ledger event says what was decided. A trail entry says
who tried, on what surface, and what happened to them.

### If someone is erased, why do we keep anything at all? Is that legal?

What erasure actually does, in `src/services/erasure.js`: it clears the
`Principal` document's `pii` (name, email, phone, dob, PAN, address), both lookup
hashes, and the **guardian's** contact details on a child's record, then stamps
`erasedAt`. After that the person cannot be re-identified through this system by
email or phone at all, permanently.

What survives, and why:

| Survives | Why |
| --- | --- |
| `ConsentRecord` and its whole ledger | The fiduciary's own evidence that it had a lawful basis for processing it already did. Holds no PII; keyed only by the random `principalId`. |
| `trailentries` rows | Same reasoning. Holds no free text and no contact detail by construction. |
| `isMinor` | A bare boolean on a now-pseudonymous record. Without it, a child's ledger with no marketing events is indistinguishable from an adult who declined. |
| `parentalConsent.verifiedAt` | A fact about the fiduciary's own verification process, not personal data about the guardian. The only surviving evidence that a child's events had the basis Section 9 requires. |

Is it legal? The honest answer is that this is the repository's reasoning, not a
ruling. The Act gives a right to erasure under Section 12, and the toolkit's own
rights catalog states the shape of the limit: "We must comply unless the law
requires us to keep it - we will tell you which, and why." The design's position
is that the retained material is pseudonymous evidence of a completed lawful
process, not a live record about a person. Whether that holds for your
deployment, your retention periods and your sector regulator is a question for
your counsel, and this package is not legal advice.

Two practical notes. Pseudonymous data is still personal data under the Act, so
"we hashed it" is not an exit. And erasure does **not** reach free text - see
the grievance-description question below.

### Why does a refused withdrawal get recorded but a successful one does not?

This one confuses everybody for about a day, and then becomes obvious. It is the
partition rule, and it is about **where the fact already lives**, not about how
interesting the fact is.

Walk through one call. Asha asks to withdraw `marketing` and `kyc_reporting` in
a single request to `withdrawConsent`:

- `marketing` rests on her consent, and she has it granted. The function pushes a
  `{ status: "withdrawn", timestamp: now }` event onto `ConsentRecord.events` and
  calls `record.save()`. **A real, observed timestamp now exists in a primary
  collection.** Copying it into `trailentries` would create a second copy of the
  same fact, which is exactly how an audit trail starts reporting one act twice.
  So nothing is stored. The trail read derives it at request time as
  `kind: "consent_withdrawn", source: "derived"`.
- `kyc_reporting` rests on Section 7(d), so it cannot be withdrawn. The loop puts
  it in `rejected` and `continue`s. No event is pushed. If she had named *only*
  that purpose, `withdrawn.length` would be zero and `record.save()` would never
  run at all. **Nothing anywhere would remember that she asked and was told no.**
  So it is stored, as `kind: "withdrawal_not_applied", outcome: "refused",
  reasonCode: "not_withdrawable", source: "stored"`.

Both appear on her timeline, in the same shape, newest first. She sees the
withdrawal that worked and the one that was refused. `source` tells you which
half it came from, and nothing consuming the timeline has to care.

The property that makes this safe is that the eleven stored kinds and the eight
derived kinds are **disjoint sets**. Nothing can be both, so nothing can be
double-reported, and no dedup pass is needed. There is a test in
`test/trailread.test.js` that fires exactly the mixed call above and asserts the
two halves name no purpose in common.

The same rule explains the other cases that surprise people. A grievance being
filed is derived (`Grievance.createdAt`). A grievance being escalated is derived
(`Grievance.escalatedAt`). An escalation being *refused* is stored, because
`escalateToBoard` throws before touching the document. A rights request moving
`received -> in_progress -> closed` is stored per transition, because
`requestLifecycle.js` overwrites `status` in place and `updatedAt` only holds the
last change - the middle transition would otherwise be destroyed, and inferring
it from `updatedAt` would be inventing a timestamp nobody observed.

### Why does the back-office trail read use POST when it is a read?

Two reasons, and either alone would be enough.

**A `principalId` must not enter a URL.** A path segment or a query string lands
in access logs, browser history, `Referer` headers and CDN cache keys. None of
those is reachable by `Cache-Control: no-store`, because on a CDN the value *is*
the cache key. The same argument applies with more force to
`POST /principals/lookup`, which carries a raw email address.

**The read performs a write.** Under ADR 0003 every back-office disclosure
writes a fail-closed access record before it answers. Meanwhile the same-origin
check in `src/http/shared.js` exempts `GET` and `HEAD` by design, because a
browser cannot omit `Origin` on a state-changing method. Put those together and
a `GET` version of this route would be a database write, attributed to a
signed-in operator, triggerable from a cross-site `<img>` tag or a link
prefetch. Someone could poison your accountability record with rows blaming a
member of staff who did nothing.

So both back-office routes are POST. Yes, this makes them slightly awkward to
call from a browser address bar. That is the point.

### What happens if the trail write fails? Do we lose the consent?

No. Instrumentation writes are fail-open.

`recordTrail(models, entry)` in `src/services/consentTrail.js` never throws. It
builds the document *inside* the try, so even a malformed value is swallowed,
and on failure it logs one line naming `err.name` and `err.code` and nothing
else. It deliberately does not log `err.message`, because Mongoose's cast and
duplicate-key messages quote the offending value back, and that is how a
caller-supplied email address ends up in a log file.

The reasoning is in ADR 0003: the trail must never take down consent capture, a
withdrawal, or the refusal message a data principal needs to read. Turning
`persistPIIwithconsent`'s `422` into a `500` would leave a minor with no
explanation of why they were refused. There are tests for both directions in
`test/trailconsent.test.js` - a failed trail write does not fail the minor's
`422`, and it does not fail a successful adult's receipt either.

The exception is the back office. `recordTrailStrict` throws `AppError(..., 503)`
and both back-office routes write their access record *before* returning
anything, including on the 404 path. No record, no disclosure.

The cost is stated rather than hidden: because instrumentation is best-effort,
this package makes **no completeness claim** about the trail. See the next
question but one.

### Can a data principal see which member of staff looked at their record?

They can see **that** someone did, not **who**.

`GET /consent/trail` calls `getConsentTrail` with `includeOperatorRefs: false`.
The `operator_lookup` and `operator_trail_read` rows are included in their
timeline - this is the headline of the feature, not an accident - but the actor
is projected down to `{ role: "operator", channel: "api" }`. The `ref` key is
absent, not null, and `caseRef` is absent too. The back-office read of the same
rows passes `includeOperatorRefs: true` and gets both.

The reasoning: that an operator read your record is something a data principal is
owed under the Section 11 right of access. *Which* operator is your own employee's
personal data, retained under your own employment basis, and the ticket
reference is your internal case data. Neither is the data principal's to receive
by default.

One consequence worth knowing before it surprises you: operator rows are filed
under the **subject's** `principalId`, not the acting operator's. So a data
principal who has been looked up often by your back office accumulates stored
entries at a rate their own behaviour does not predict. That is the one input the
partition rule does not bound, and it is why `GET /consent/trail?limit=` exists
at all (1 to 1000, default 500) alongside honest `truncated` and `totalEntries`
fields.

If a specific access request genuinely requires you to name an individual, the
data is there on the back-office read. Deciding to hand it over is a judgement
about two people's rights at once, and this library deliberately does not make
it for you.

### Why does the library refuse to start sometimes?

Because a misconfiguration that boots and then fails in front of a data
principal is worse than one that never boots. `assertConfigured()` in
`src/config/catalog.js` runs before either router factory builds a single route.

| Refusal | Trigger | Why it is fatal |
| --- | --- | --- |
| `FIDUCIARY_DPO_EMAIL` unset or `dpo@example.com` | Placeholder | The grievance page publishes it. You would look like you had published valid Grievance Officer contact details while every complaint went nowhere. |
| `FIDUCIARY_DPO_EMAIL` set but implausible | `"tbd"`, `"not-an-email"`, a bare hostname | Same failure, just harder to spot in a `.env`. The check is deliberately not RFC 5322 - it catches what actually gets committed. |
| `GRIEVANCE_SLA_DAYS` / `RIGHTS_SLA_DAYS` not a positive integer | `Number("seven")` is `NaN` | Every `slaDueAt` becomes an Invalid Date and every grievance fails at the moment someone tries to file one. |
| `PRINCIPAL_ID_SECRET` unset, blank, or under 32 characters | `.env.example` ships it empty | Without it the router builds, health checks pass, `GET /consent/new` renders, and the **first** `POST /consent` returns 500. |
| `NOTICE_LANGUAGES` not exactly `["en"]` | Any other entry, or a stray comma | There is no translation map. Requesting `?lang=hi` returned an English notice labelled `hi`, content-hashed and cited by every consent event under it. That is affirmative false evidence of Section 5(3) compliance on an append-only ledger. |

Three more refusals live in the router factories themselves and are plain
`Error`s, not `AppError`s, so they can never be mapped to an HTTP response:

- `createRouter` and `createBackOfficeRouter` both require a `db` handle from
  `connect()`, and an `allowedOrigins` that is an array of strings.
- `createBackOfficeRouter` refuses to build unless you pass
  `rateLimitedByHost: true`. It is a people-search over a guessable keyspace -
  `POST /principals/lookup` answers whether an address belongs to a registered
  data principal, and for the shipped lender catalog that means answering
  whether someone has applied for credit. This package ships no rate limiting,
  so the flag is you saying you put a limiter in front of the mount.

The pattern is the same every time: loud at boot, rather than silent at boot and
loud in front of a data principal.

### Can I trust the trail to be complete?

No, and the package says so in three specific ways rather than implying
otherwise. Treat it as **evidence of what was recorded, not proof that nothing
else happened**.

**It is not retroactive.** Coverage starts at `coverageFrom` (currently
`2026-09-04`) and no backfill is possible or permitted. Reconstructing a
timestamp nobody observed would be manufacturing evidence, which is the one
thing an audit trail must never do.

**Instrumentation writes are best-effort.** A failed `recordTrail` is logged and
the act proceeds, so a stored entry can genuinely be missing. This is a
deliberate trade against the alternative, which is the trail being able to break
consent capture.

**A read is bounded.** Each of the four secondary collections is read with
`.limit(MAX_SCAN)`, currently 5000 rows, and the caller's `limit` then slices
the merged result. `truncated` and `totalEntries` tell you honestly whether you
saw everything the read loaded. Under the partition rule a normal principal has
single-digit stored entries, so this only bites on the operator rows.

A useful mental model: an entry that is present is trustworthy, and its
timestamp was really observed. An entry that is absent proves nothing. That is
the same register as the house rule about grievances being "recorded", never
"sent" - a `200` from `escalateToBoard` is not proof the Board has been
notified, because nothing left the process.

### Someone typed personal data into a grievance description. Does erasure remove it?

No. `erasePrincipalPII` clears the `Principal` document and nothing else.

Three collections hold free text a data principal typed themselves, and erasure
does not touch any of them:

| Collection | Field |
| --- | --- |
| `Grievance` | `description` (and `subject`) |
| `RightsRequest` | `details` |
| `ConsentManagerRequest` | `message` |

The reason it is not automated is stated in the code: deciding what in a block
of prose is personally identifying is a judgement call an automated pass gets
wrong, in both directions. So it is left to your own process - but **a
deployment that treats `erasePrincipalPII` as completing a Section 12 erasure
request, without also reviewing those three collections by hand, has not
completed it.** Build that review step. It is yours to build.

A fourth collection survives erasure and is deliberately **not** on that review
list: `trailentries`. Erasure writes nothing to it, edits nothing in it and
deletes nothing from it. It carries no free text and no contact detail by
construction - `consentTypes` elements are filtered against the live catalog by
the writer and dropped if they do not match, and there is no field on the schema
a contact hash could be written to at all. So it is retained pseudonymously as
evidence, exactly like the ledger, with nothing in it for a human to redact.

That absent contact-hash field is load-bearing, not an omission. A row carrying
both a hash and a `principalId` would rebuild the email-to-person index that
erasure exists to destroy, because you hold `PRINCIPAL_ID_SECRET` and could
recompute the hash at any time. And a hash stored on a lookup that matched
nobody would mint a permanent contact-derived identifier for a person who is not
your data principal at all. An earlier draft enforced this with a schema
validator; that does not hold, because `updateOne` does not run document
validators. A field that does not exist cannot be set. Do not add one.

### We need to notify our processors when someone withdraws. Does this do that?

No. The library cannot tell a processor it does not know about to cease
processing. What it gives you is a signal and a primitive, not a pipeline.

The signal is `onWithdrawal({ principalId, types, effectiveFrom, receiptId })`,
which you pass to `createRouter`. It is called once, only when something actually
changed, after the events are saved. **A throw here fails the request** - that is
deliberate, and the opposite of `onGrievanceFiled`, whose throws are swallowed.
The reasoning: this hook is how your host learns it must cease processing and
erase, so a host whose pipeline is down needs to find out. A grievance, by
contrast, is already filed, and failing the response would cost the data
principal their reference number and produce a duplicate filing.

The primitive is `erasePrincipalPII`, which you call yourself.

**Now the part that will catch you.** There are two withdrawal paths, and only
one of them fires the hook.

- `PUT /consent/withdraw` and `POST /consent/withdraw` go through
  `withdrawConsent`, which takes `onWithdrawal` and calls it. Fine.
- `PUT /consent` can withdraw a purpose **by omission**. Submitting a shorter
  consent list withdraws whatever is missing from it. That path goes through
  `persistPIIwithconsent`, which has no `onWithdrawal` parameter at all, and the
  router passes none. **Your cease-processing pipeline is never told.**

The withdrawal itself is real and in the ledger, so the trail derives it
normally. What the trail *adds* on that path is a
`kind: "withdrawal_hook_not_fired"` entry naming the purposes. That is written
proof that a Section 6(6) cessation duty may have gone undischarged - and
recording that the hook did not fire is emphatically not the same as firing it.

So if you are building the processor-notification pipeline, do at least one of:

```
1. Never let your own UI submit a shortened consentTypes list to PUT /consent -
   route every withdrawal through /consent/withdraw, where the hook fires.
2. Reconcile: watch trailentries for kind: "withdrawal_hook_not_fired" and feed
   those into the same pipeline onWithdrawal feeds.
```

Either is fine. Doing neither means some withdrawals silently never reach your
processors, and the only trace will be a trail row nobody is reading.
