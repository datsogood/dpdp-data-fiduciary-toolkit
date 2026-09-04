# 2. How this toolkit models consent

The previous chapter was about the Digital Personal Data Protection Act, 2023
and the duties it puts on a data fiduciary. This chapter is about where those
duties live in the code. By the end you should be able to open any file in
`src/` and know roughly why it exists.

Nothing here is legal advice, and this package is not a certified compliance
product. It is a reference implementation: a worked example of how the pieces
fit together.

---

## The one-paragraph tour

`dpdp-fiduciary-toolkit` is a Node library. It gives you seven Mongoose models,
a set of plain service functions that do the actual work (`persistPIIwithconsent`,
`withdrawConsent`, `getConsentState`, `erasePrincipalPII` and friends), a Section 5
notice generator built from a catalog of purposes, and two Express routers that
wrap the services in HTTP - one facing the data principal, one facing your back
office. It deliberately owns no session store, no mailer, no queue and no rate
limiter. So it cannot tell you who is calling (you inject `resolvePrincipal`),
it cannot send anything anywhere (the house word is **recorded**, never "sent"),
it cannot verify that a person controls an email address or that a stated parent
is really their parent, and it cannot stop your downstream processors from
processing after a withdrawal. Those are the host application's jobs, and the
README's "What this is not" lists them without softening.

The whole package is 30 files and about 4,400 lines of `src/`. It is small
enough to read.

---

## The split everything else rests on

Two duties in the Act point in opposite directions.

- Section 12 gives a data principal the right to have their personal data
  **erased**.
- The fiduciary must be able to show, afterwards, that it had a **lawful basis**
  for the processing it already did.

Take Asha. In March she applies for a loan, reads the notice, and ticks the
boxes for identity verification and underwriting. Through the summer Kavach
assesses her. In September she asks to be erased.

If her consent decisions and her name, email and PAN live in one document, those
two duties are mutually exclusive:

- Delete the document, and the evidence that the summer's marketing was lawful
  goes with it.
- Blank the PII fields in place, and you have either kept a document that says
  "erased" while holding live personal data, or failed schema validation trying.

So the toolkit splits them into two collections, joined only by a random
identifier:

| | `Principal` | `ConsentRecord` |
| --- | --- | --- |
| File | `src/models/Principal.js` | `src/models/ConsentRecord.js` |
| Holds | name, email, phone, dob, PAN, address, `isMinor`, `parentalConsent`, `erasedAt` | `events[]`, `lastNotice`, `docRef` |
| PII? | Yes, all of it | **None.** The schema has no field to put any in |
| Erasure | Cleared in place, `erasedAt` stamped | Untouched |
| Shape | One mutable document | Append-only ledger |

`ConsentRecord` holding no PII is not a convention anyone has to remember. Read
the schema: `principalId`, `docRef`, `events`, `lastNotice`, two timestamps.
There is nowhere for a name to go. After Asha's erasure her ledger still says
"marketing granted on 4 March under notice `a1b2c3...`, withdrawn on 2 August" -
and there is nothing left in the system that says who `4f3a...9c` was.

That is the trade in one line: **destroy the identity, keep the pseudonymous
evidence.**

Note the honest caveat that comes with it. Pseudonymous is not anonymous. The
retained ledger is still personal data under the Act; it is just data that no
longer names anybody through this system.

---

## Identity: `principalId`

```js
function newPrincipalId() {
  return crypto.randomBytes(32).toString("hex");
}
```

That is the whole thing (`src/utils/principalId.js`). Thirty-two random bytes,
rendered as 64 hex characters, minted server-side the first time someone posts
`/consent`.

**In 0.1.0 it was `sha256(email)`.** Read that again and the attack writes
itself: anyone who knew `asha@example.com` could compute Asha's identifier at a
terminal and then use it against every endpoint that took a `principalId`. There
was no secret in it and nothing to guess. That is why 0.1.0 identifiers cannot
be migrated forward - there is no translation between a hash of an email and a
random number, so every existing principal has to re-register.

Two habits follow from that history, and both are enforced in code:

1. **A `principalId` is a session-resolved identity, not a request parameter.**
   It is a database key, so a client-supplied one proves nothing. On every
   *authenticated* route `createRouter` mounts, identity comes from
   `resolvePrincipal(req)` - your session lookup - and never from a body or
   query string; if it is missing, throws, or returns something that is not 64
   hex characters, those routes answer `401`. Failing closed is the point. Five
   routes are deliberately public and never call it - `GET /consent/new`,
   `POST /consent` (signup), `GET /rights`, `GET /grievance/new` and
   `GET /consent-manager/new` - because a person has no identity until signup
   succeeds.
2. **Every id is shape-checked before it reaches a query.** `assertPrincipalId`
   in `src/utils/validate.js` tests it against `/^[a-f0-9]{64}$/`. Mongoose does
   not strip query operators during casting, so `{ $gt: "" }` on a string path
   would reach MongoDB verbatim and match every document. The regex is the
   actual control, not a nicety.

There is exactly one carve-out, in a router this chapter has not met yet: the
fiduciary's back office, where a member of staff answers a Section 11 request
for a person whose 64-hex identifier they obviously do not have. There the
`principalId` is a *query subject* passed in the request body, not something
resolved from a session - the operator's own identity is established
separately, through `resolveOperator`, and every use writes an access record
before any data is returned. Chapter 3 explains that router and why the
carve-out is safe. See also ADR 0002.

### `emailHash` and `phoneHash`

You still need to find Asha by her email at sign-in. So `Principal` carries
lookup hashes:

```js
function lookupHash(value) {
  return crypto.createHmac("sha256", secret()).update(value.trim().toLowerCase()).digest("hex");
}
```

Two things matter here.

**It is keyed, not bare.** `secret()` reads `PRINCIPAL_ID_SECRET` and refuses
anything shorter than 32 characters. If this were a plain `sha256(email)`,
anyone holding a copy of the database could take a list of email addresses,
hash them, and rebuild the entire email-to-person index - erased principals
included, since only the hash tells you who was who. With an HMAC, that attack
needs the key as well. The secret is checked at boot by `assertConfigured()`,
because a missing one used to let a deployment start, pass health checks, render
the consent form, and then fail the very first `POST /consent` with a 500.

**It is normalised.** `.trim().toLowerCase()`, so `Asha@Example.com ` and
`asha@example.com` resolve to the same person.

Their index declarations differ, and the difference is deliberate:

```js
emailHash: { type: String, index: true, unique: true, sparse: true },
phoneHash: { type: String, index: true, sparse: true },   // NOT unique
```

`emailHash` is unique because two principals answering to one email would make
`findOne({ emailHash })` return an arbitrary one of them - and it is also the
backstop for the race where two concurrent signups both pass the "does this
email exist" check before either has written. It is sparse so that erased
records (which unset it) and phone-only principals (which never set it) do not
collide on `null`.

`phoneHash` is not unique. That is the next section.

---

## Why a phone number is not an identity here

This is the design decision most worth understanding, because it is not a
technical preference. It is about who this toolkit is for.

The stated audience is social and public sector beneficiaries. Many have no
email address. A household routinely shares one handset. So "same phone number"
cannot mean "same data principal" - it means "same house".

Getting this wrong broke the system in both directions, and both failures are
written up in the docstrings in `src/utils/principalId.js`.

**Direction one: registration.** Signup used to fall back to matching on
`phoneHash` when no email was supplied. It looked like a kindness to people
without email. A mother registers phone-only. Her daughter, who also has no
email, registers on the same handset. The lookup matches the mother's document,
and the router's pre-write existence check turns that match into a `409`. The
daughter cannot register **at all**. Not "gets a confusing message" - is
permanently locked out of the service, along with anyone else in her house.

**Direction two: sign-in.** `findPrincipalByContact` used to answer a phone
lookup with `findOne` on a deliberately non-unique field, which returns an
arbitrary match. The daughter completes an OTP on the household handset and is
issued a session for her **mother** - reading her PII, reading her consent
ledger, and able to append irreversible withdrawals to it. Verifying that
somebody controls a handset is not the same as verifying which household member
is holding it, and no library can close that gap from the outside.

The rules today:

| Path | Behaviour |
| --- | --- |
| `findOrCreatePrincipal` (signup) | Email supplied: match on `emailHash` only. No email: match nothing, **always create**. |
| `findPrincipalByContact` (host sign-in helper) | Email: one lookup. Phone: `find(...).limit(2)`, and if two rows come back it throws `409` rather than guessing. |
| `POST /principals/lookup` (back office) | Email only. The phone branch is refused on HTTP entirely. |
| `findConsentTrailByContact` (unmounted library function) | Keeps the phone branch, because a direct library caller is already inside your trust boundary. |

The residual cost is stated plainly rather than argued away: **a phone-only
person who resubmits the form gets a second record**, because nothing on file
distinguishes "the same woman again" from "her sister". Your application holds
the real-world knowledge that could tell them apart; this library does not.

And the residual has a sharp edge the README spells out. Her older
`ConsentRecord` is now orphaned. The phone lookup `409`s on exactly the
ambiguity her resubmission created, so nothing in this library can reach that
record again. The purposes she granted on it stay `granted` forever, and
`withdrawConsent` only ever writes to the session's principal - so withdrawing
on the new record never touches the old one. That is a real gap against Rule
3(c)(i) of the DPDP Rules, 2025 (withdrawal must be as easy as granting) for
whichever record she cannot reach. **Merging or migrating the older ledger is
work your back end has to do; no function here does it for you.**

The trade was made with eyes open: a duplicate record is recoverable, a
permanently unregistrable beneficiary is not, and an account takeover is worse
than either.

`test/principal.test.js` pins all of this - look for "two people sharing a phone
and having NO email can both register" and "a phone number that identifies more
than one principal is refused for sign-in, not guessed".

---

## The consent catalog

`src/config/catalog.js` is where an adopter does most of their thinking. It
lists the purposes this fiduciary processes personal data for, and everything
downstream is generated from it: the notice, the checkboxes on the consent form,
which withdrawals are honoured, and which purposes a child can never be given.

Start with the statutory fact that shapes the schema. Under the Act there are
exactly **two** kinds of lawful basis: the data principal's consent (Section 6),
and the enumerated "certain legitimate uses" in Section 7. There is no general
contractual-necessity ground - that is GDPR Article 6(1)(b) and it does not
exist here. So a purpose is either consent-based and withdrawable, or it cites a
specific Section 7 clause and is not.

Here is one entry, verbatim:

```js
{
  type: "marketing",
  title: "Marketing and personalised offers",
  purpose: "Telling you about products we think you will want.",
  lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
  withdrawable: true,
  prohibitedForChildren: true,
  retentionMonths: 24,
}
```

The five shipped purposes belong to "Kavach Finance", a fictional lender. Replace
them before using any of this for real.

| `type` | Basis | Withdrawable | Prohibited for children |
| --- | --- | --- | --- |
| `kyc_reporting` | legitimate use, Section 7(d) | no | no |
| `identity_verification` | consent, Section 6 | yes | no |
| `underwriting` | consent, Section 6 | yes | no |
| `marketing` | consent, Section 6 | yes | **yes** |
| `analytics` | consent, Section 6 | yes | **yes** |

Two things in that table repay attention.

**KYC is split into two purposes on purpose.** The long comment above
`kyc_reporting` walks through the statute clause by clause. Section 7(d) covers
"fulfilling any obligation under any law ... to disclose any information to the
State", so handing prescribed information to the Financial Intelligence Unit
under the Prevention of Money-Laundering Act, 2002 fits. Verifying a customer's
identity for your **own** records goes beyond that disclosure duty and needs
consent. Modelling all of "KYC" as one non-withdrawable purpose would make the
toolkit refuse a withdrawal the statute guarantees. Marking a purpose
non-withdrawable is a claim about the law, not a product setting.

**`prohibitedForChildren` is always written out.** Section 9 restricts
behavioural advertising and tracking aimed at children, so `marketing` and
`analytics` say `true`. The other three say `false` explicitly rather than
omitting the key, so that a false is a decision somebody made rather than a
field somebody forgot. `test/catalog.test.js` asserts every entry declares it,
and asserts that `withdrawable` agrees with `lawfulBasis.kind` for every entry.

**`retentionMonths` is disclosed, not enforced.** It appears in the notice and
on the consent page ("Kept for 24 months"). Nothing in `src/` deletes anything
when it lapses. If you need retention to actually happen, you build it.

**There is no concept of consent going stale, either.** A `granted` event from
three years ago is exactly as `granted` as one from this morning; nothing here
expires it, flags it for refresh, or treats its age as meaningful. That is a
decision this package makes by omission, not one it states - if your own policy
needs consent to be refreshed periodically, that is also something you build.

One implementation detail that matters if you customise the catalog at boot:
everything is read through functions - `getCatalog()`, `getValidConsentTypes()`,
`getCatalogEntry(type)` - not through module-level snapshots. An earlier version
snapshotted, which meant a runtime change left the validator rejecting a purpose
the event writer was happily writing events for.

**Removing a `type` after people have consented to it is not reversible.**
There is no supported retirement path. Once an entry is gone from the catalog,
`getWithdrawableTypes()` no longer lists it, so a request to withdraw it is
refused with `unknown_consent_type`; `decideFor` no longer iterates it, so its
last recorded event stays exactly as it was, forever; and it is filtered out of
any trail entry's `consentTypes` list, the same way an unrecognised string
would be. If you need to retire a purpose, add its replacement as a new `type`
and leave the old one in the catalog, withdrawable, for as long as any live
ledger still references it.

---

## Notice versions

Section 5 requires an itemised notice with the request for consent: what data,
for what purpose, what your rights are, how to complain. `buildNotice()` in
`src/config/notice.js` generates it from the live catalog, so the notice and
the checkboxes can never disagree with each other. Whether the catalog
describes what your deployment actually does with the data is a separate
question nothing here checks.

The last two lines are the interesting part:

```js
const version = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
return { ...body, version, generatedAt: new Date() };
```

The version **is** a hash of the content. Same catalog and config, same version,
every time - `generatedAt` is added after the hash, so time does not change it.
Change the DPO's email address or add a purpose, and you get a different version
without anybody having to remember to bump one.

Why that matters: "we obtained consent" is only evidence if you can also show
what the person was told. So:

- `NoticeVersion` stores one row per **distinct** notice ever shown, keyed by
  that hash and upserted with `$setOnInsert`. Storage grows with the number of
  notices, not the number of submissions.
- Every consent event carries its own `noticeVersion` - the notice in force when
  **that** event was written.
- `ConsentRecord.lastNotice` is a `{ version, language, shownAt }` pointer to the
  most recent one. It is a fast "what does this person see right now" read, and
  it is explicitly **not** the evidence.

Asha again. She consents in March under notice `a1b2c3d4e5f60718`. In June the
Grievance Officer's address changes, so the next notice hashes to something
else, and her next submission moves `lastNotice`. Her March event still names
`a1b2c3d4e5f60718`, and `NoticeVersion` still holds that exact body. The old
consent stays evidenced.

**A changed notice does not, by itself, re-ask anything.** `lastNotice` moves
silently on the next submission; nothing here prompts Asha to look at it again.
A cosmetic change - a typo, the DPO's address - is one thing. A new purpose, or
a purpose whose scope changed, is another: that processing was never itemised
in what she originally saw, so Section 6's requirement that consent be specific
and informed points toward treating it as needing its own fresh consent, not a
silent update to `lastNotice`. This package does not decide that for you; it
only guarantees that whichever notice was actually shown stays evidenced.

**Only English ships.** There is no translation map anywhere in this package,
and `NOTICE_LANGUAGES` is not a way to add one. `buildNotice` validates the
requested language and stamps it onto the body while every string still comes
from the single English catalog - so configuring `hi` produced an English notice
labelled `hi`, stored under its own content hash and cited by every consent
event written under it. That is affirmative false evidence of Section 5(3)
compliance, on a ledger that cannot be edited. `assertConfigured()` therefore
refuses to boot with any entry other than `en`. Section 5(3) does permit any
Eighth Schedule language; serving one is real work (a translated catalog,
reviewed by someone who reads the language), not a setting to flip.

---

## The event ledger

A consent event is small and it is never edited:

```js
{
  type: "marketing",
  status: "granted",                    // granted | denied | withdrawn
  basis: "Your consent",
  lawfulBasisKind: "consent",           // consent | legitimate_use
  receiptId: "RC-9F2A1B4C7D8E0F31",
  timestamp: 2026-03-04T09:12:44.101Z,
  noticeVersion: "a1b2c3d4e5f60718",
}
```

Three statuses, and a fourth state expressed by absence:

| Status | Means |
| --- | --- |
| `granted` | Offered and accepted |
| `denied` | Offered and declined |
| `withdrawn` | Previously granted, then revoked |
| *(no event)* | Never offered - the purpose was not in the catalog then, or it was refused outright for a child |

Two references travel with a consent record, and they answer different questions:

- **`docRef`** (`CN-...`) identifies the record and stays put for the life of
  the principal.
- **`receiptId`** (`RC-...`) identifies one act. A fresh one is minted per
  submission, and every event that call appends carries it - so "what did this
  one form submission actually change" is a single field lookup.

Both come from `generateDocRef(prefix)`, which is 8 random bytes in uppercase
hex. It used to be 3 bytes plus a timestamp prefix, which made references
partially predictable and same-millisecond collisions plausible.

### What `currentState()` derives

```js
consentRecordSchema.methods.currentState = function currentState() {
  const latestByType = {};
  for (const event of this.events) {
    const existing = latestByType[event.type];
    if (!existing || event.timestamp >= existing.timestamp) latestByType[event.type] = event;
  }
  return latestByType;
};
```

The latest event per purpose, and nothing more. Current state is never stored -
it is always recomputed from history, which is what makes the ledger the single
source of truth. (The `>=` means that when a single submission stamps several
events with the same instant, later array position wins. That is honest
insertion order, not a guess.)

`getConsentState` in `src/services/consentState.js` is the read side: it returns
`state` (from `currentState()`), the full `ledger`, the `notice` pointer, current
`pii`, and `erasedAt`. It answers the Section 11 right of access. It is scoped by
construction - `principalId` is in the filter, so a caller naming somebody else's
id simply finds nothing, and the 404 is deliberately identical whether the id
belongs to nobody or to another person's ledger. A 403 would confirm the ledger
exists.

The shape, with one ledger entry shown:

```json
{
  "docRef": "CN-538A6980AC448706",
  "principalId": "18a11b09…",
  "state": { "underwriting": { "type": "underwriting", "status": "granted", "…": "…" } },
  "ledger": [
    { "type": "underwriting", "status": "granted", "basis": "Your consent",
      "lawfulBasisKind": "consent", "receiptId": "RC-A0CDE537EDA4014C",
      "timestamp": "2026-09-04T12:00:12.239Z", "noticeVersion": "631447db0e2c3eb1" }
  ],
  "notice": { "version": "631447db0e2c3eb1", "language": "en", "shownAt": "2026-09-04T12:00:12.230Z" },
  "pii": { "name": "Asha Rao", "email": "asha@example.com", "…": "…" },
  "erasedAt": null,
  "createdAt": "2026-09-04T12:00:12.239Z",
  "updatedAt": "2026-09-04T12:00:12.239Z"
}
```

### Writes are deltas, not overwrites

`persistPIIwithconsent` computes what actually changed and appends only that. An
earlier version appended an event for every purpose on every call, which meant a
profile update silently withdrew live consents and a re-post silently
resurrected a withdrawn one. On an append-only ledger, neither is recoverable.

The state table, worth memorising because it is the part people get wrong:

| Submission | Effect |
| --- | --- |
| `consentTypes` omitted (or `null`) | No consent decision was made. Existing consent untouched. |
| `consentTypes: []` | "I decline everything." A purpose with no event yet gets a `denied` event; one currently `granted` gets a `withdrawn` event instead (if it is withdrawable); one already `denied` or `withdrawn` gets no event at all. |
| A purpose you already granted, listed again | Nothing. No duplicate event. |
| A purpose you withdrew, listed again | Stays withdrawn - unless you also pass `regrant: true`. Reversing a withdrawal is a separate, deliberate act. |
| A purpose you granted, now omitted | Withdrawn (if withdrawable). |
| A Section 7 legitimate use | Recorded once, on first contact. Never a checkbox. |

The `null` case is not pedantry. `assertStringArray` maps both `undefined` and
`null` to `[]`, so treating `null` as a submission would let a client that
serialises an absent value as `"consentTypes": null` revoke every consent it
had, permanently.

That last row - withdrawal by omission through `PUT /consent` - is the quietest
path in the system, and the toolkit says so in writing. `persistPIIwithconsent`
has no `onWithdrawal` parameter and the router passes none, so your
cease-processing pipeline is never told. The withdrawal itself is in the ledger;
what gets written additionally is a `withdrawal_hook_not_fired` trail entry
recording that the hook did not fire. Recording that is not the same as firing
it, and closing that gap is the host's job.

Refusals and silent no-ops are not in the ledger at all. They live in
`TrailEntry`, the stored half of the consent audit trail, under a strict
partition rule: **the trail stores only facts that are destroyed, or never
written, anywhere else**; anything a read can recover from a primary collection
is derived at read time and never copied. That is ADR 0001, and it has its own
chapter.

---

## Erasure

`erasePrincipalPII` in `src/services/erasure.js` is a plain function. It is
**not** mounted on any route - you call it from your own back office once you
have decided a Section 12 request should be carried out. It is irreversible.

**What it clears:**

- every `pii` field: name, email, phone, dob, PAN, address
- `emailHash` and `phoneHash`, so the person can never again be found by contact
  detail through this system
- the **guardian's** contact details on a child's record: `parentalConsent.name`,
  `.email`, `.relationship`

That third one was a bug once, and the asymmetry was the ugly part: the child's
own email was stored as a keyed HMAC and destroyed, while the parent's was
stored in plaintext and survived - on a document stamped `erasedAt`, which
`getConsentState` reports as `pii: null`. The toolkit's own access read concealed
it.

**What it keeps, by decision:**

- `isMinor` - a bare boolean on a now-pseudonymous record, naming nobody. It is
  what keeps the retained ledger legible: a child's ledger carries no marketing
  or analytics events because Section 9 prohibits them, and without this flag
  that absence is indistinguishable from an adult who simply declined.
- `parentalConsent.verifiedAt` - a fact about the fiduciary's own process, not
  personal data about the guardian. It is the only surviving evidence that the
  retained consent events had the lawful basis Section 9 requires for a child.

**What it does not touch, and you must:** the `ConsentRecord` ledger stays (that
is the whole design), and free text does too. A data principal who typed their
own name, email or address into

- a grievance `description`,
- a rights request `details` field, or
- a consent-manager `message`

still has that text sitting in those three collections. Deciding what in a block
of prose is personally identifying is a judgement call an automated pass gets
wrong, so it is left to your own process. **A deployment that treats
`erasePrincipalPII` as completing a Section 12 erasure request, without also
reviewing those three collections by hand, has not completed it.**

A fourth collection survives erasure and is deliberately *not* on that review
list: `trailentries`. Erasure writes nothing to it, edits nothing in it, deletes
nothing from it, and by construction it holds no free text and no contact detail
- there is no field on the schema either could be written to. It is retained
pseudonymously as evidence, exactly as the ledger is, with nothing in it for you
to review.

Calling it twice is safe: the second call returns `{ alreadyErased: true }` and
changes nothing. And erasure is terminal in the other direction too -
`updatePrincipalContact` and `PUT /consent` both refuse an erased record with a
`409`, so no session issued before the erasure can write live PII back onto a
document that claims to be erased.

---

## A map of the source tree

Everything below is under
`/Users/sandeep/Workspace/datsogood/dpdp-data-fiduciary-toolkit/data-fiduciary-toolkit/`.

### `src/`

| File | What lives there |
| --- | --- |
| `src/index.js` | The public surface. Every export, each with a comment saying why it is or is not mounted on a route. Read this first. |
| `src/db/connection.js` | `connect(uri)`. Opens an isolated connection this library owns, never `mongoose.connect()`, and sets `sanitizeFilter` on it so query-operator objects cannot reach MongoDB. |

### `src/models/` - one file per collection

| File | What lives there |
| --- | --- |
| `models/index.js` | `buildModels(connection)`, binding every schema to one connection and caching the registry on it. |
| `models/Principal.js` | The erasable half: PII, lookup hashes, `isMinor`, `parentalConsent`, `erasedAt`. |
| `models/ConsentRecord.js` | The append-only ledger, `lastNotice` pointer, and `currentState()`. No PII. |
| `models/NoticeVersion.js` | One row per distinct notice ever shown, keyed by its content hash. |
| `models/RightsRequest.js` | A filed Chapter III request: `right`, `details`, `status`, `slaDueAt`. |
| `models/Grievance.js` | A Section 13 complaint to the Grievance Officer, plus `escalatedToBoard` / `escalatedAt`. |
| `models/ConsentManagerRequest.js` | A request to be connected to a Consent Manager under Section 6(7)-(9). Not the fiduciary's own consent record. |
| `models/TrailEntry.js` | The stored half of the audit trail: eleven kinds, a closed reason-code list, an `actor`, and by construction no PII and no contact hash. |

### `src/config/` - what an adopter changes

| File | What lives there |
| --- | --- |
| `config/catalog.js` | The consent catalog, the rights catalog, the `FIDUCIARY` identity block, and `assertConfigured()` - the boot-time checks that refuse to start on a placeholder DPO address, a non-integer SLA, a weak `PRINCIPAL_ID_SECRET`, or a notice language with no catalog. |
| `config/notice.js` | `buildNotice()`, the content-addressed `version`, and the Eighth Schedule language list. |

### `src/utils/`

| File | What lives there |
| --- | --- |
| `utils/principalId.js` | Id minting, keyed lookup hashes, `generateDocRef`, and the four identity-resolution functions: `findOrCreatePrincipal`, `findPrincipalByContact`, `findPrincipalById`, `updatePrincipalContact`. The longest docstrings in the repo are here and they are worth reading. |
| `utils/validate.js` | `assertPrincipalId`, `assertNonEmptyString`, `assertStringArray`, `assertOpaqueRef`. Positive shape checks, because Mongoose does not strip query operators for you. |
| `utils/age.js` | `ageInYears(dob, asOf)` and `ADULT_AGE = 18`. Reads `dob` with UTC getters and `asOf` with local ones, deliberately - the comment explains which timezone bug each half prevents. |
| `utils/errors.js` | `AppError`, an error carrying an HTTP status so the transport layer does not have to guess. Anything else thrown is treated as a 500. |

### `src/services/` - the framework-agnostic work

| File | What lives there |
| --- | --- |
| `services/persistPIIwithconsent.js` | Signup and consent update. The age gate, the delta calculation, the state table, the create-race recovery. The biggest file in the directory. |
| `services/withdrawConsent.js` | Appends `withdrawn` events, refuses a Section 7 purpose with a reason naming the clause, calls `onWithdrawal` once if anything changed. |
| `services/consentState.js` | `getConsentState` - the Section 11 read side of the ledger. |
| `services/erasure.js` | `erasePrincipalPII`, and the documented limits above. |
| `services/consentTrail.js` | The audit trail: `recordTrail` (fail-open), `recordTrailStrict` (fail-closed, back office only), `getConsentTrail` (merges stored rows with derived events from five primary collections), `findConsentTrailByContact`. |
| `services/dataPrincipalRights.js` | `listRights`, `exerciseRight`, and the per-principal reads of filed requests. `nominate` (Section 14) is filed the same way as any other right - a free-text `details` field and an `RQ-` reference - but nothing here stores a structured nominee or lets one act. Filing the request is as far as this package's support for nomination goes. |
| `services/complaintToTheBoard.js` | Files a grievance against your own DPO with an SLA clock, and `escalateToBoard` once that lapses. Local bookkeeping - it contacts no one. |
| `services/consentManagerRequest.js` | Records a Consent Manager handoff request. Recorded, not sent. |
| `services/requestLifecycle.js` | `advanceRightsRequest` / `advanceGrievance` / `advanceConsentManagerRequest`, each with an explicit transition map and a `409` on an invalid move. Back-office only, deliberately unmounted. |

### `src/http/` - the Express layer

| File | What lives there |
| --- | --- |
| `http/router.js` | `createRouter` - the principal-facing routes, `requireAuth`, and the origin check. Nothing here reads a `principalId` from a request. |
| `http/backOfficeRouter.js` | `createBackOfficeRouter` - a separate factory, so a people-search cannot be mounted on the public path by one wrong `app.use`. Refuses to build without `rateLimitedByHost: true`. |
| `http/forms.js` | The server-rendered HTML pages - consent, withdrawal, rights, grievance, consent-manager - and `escapeHtml`. |
| `http/shared.js` | `wrap`, `makeCheckOrigin`, and the error mapper that turns an `AppError` into a status and a readable message (HTML or JSON) while withholding the message on a 500. |
| `http/negotiate.js` | `wantsHtml(req)`. Twelve lines, and the comment explains why `req.accepts("html")` is a trap. |

### Everything else

| Path | What lives there |
| --- | --- |
| `examples/server.js` | A runnable end-to-end demo, including a clearly labelled demo sign-in so the authenticated routes are reachable. `npm run example`. |
| `scripts/test-setup.js` | Starts one `mongod` for the whole suite and puts its URI on `MONGO_TEST_URI`. |
| `test/` | 19 `node:test` files, plus `test/helpers/db.js`. They are the best statement of what the system actually promises - when a docstring and a test disagree, believe the test. |

Outside the package, in the repository root:

| Path | What lives there |
| --- | --- |
| `docs/adr/0001-consent-trail-partition-rule.md` | Why the trail stores only what is destroyed elsewhere, and why the 120-line dedup layer was deleted. |
| `docs/adr/0002-pii-keyed-retrieval-surfaces.md` | Why PII-keyed retrieval is an unmounted function plus a separate back-office router, and never a `GET` with an email in the URL. |
| `docs/adr/0003-split-failure-policy.md` | Why instrumentation writes fail open and disclosure writes fail closed. |
| `docs/superpowers/plans/2026-09-04-consent-audit-trail/spec.md` | The full audit-trail design the three ADRs summarise. |

---

## What to read next

If you want to trace one request end to end, follow a signup:

`src/http/router.js` (`POST /consent`)
→ `findPrincipalByContact` for the existence check
→ `buildNotice`
→ `persistPIIwithconsent`
→ `ageInYears` gate
→ `findOrCreatePrincipal`
→ `NoticeVersion` upsert
→ `decideFor` / `decide`
→ `ConsentRecord.save()`
→ the trail writes
→ `renderConsentReceipt`.

Then open `test/consent.test.js` and check that the file agrees with what you
just read.
