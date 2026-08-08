# dpdp-fiduciary-toolkit

A reference implementation of a data fiduciary's obligations under India's
Digital Personal Data Protection Act, 2023 (DPDP Act): capturing consent,
honouring withdrawal, letting a data principal exercise their rights, routing
grievances, and handing off to a Consent Manager.

The following is a summary of all the responsibilities of a data fiduciary (the organization collecting PII data) towards a data principal (the user) that we intend to codify as part of this toolkit - 

1. Consent must be requested through a clear, plain-language notice, and the
   data principal must be able to read that notice in English or in any
   language listed in the Eighth Schedule to the Constitution.
2. Information to be provided to the Data Principal on the personal data collected, purpose for collection and how data will be processed.
3. Information to be provided to the Data Principal on how consent can be revoked, their rights can be exercised and complaints to the board can be raise.
4. Ease of consent withdrawal by a Data Principal should be the same as accepting consent.
5. Data Fiduciary shall ask data processors to cease processing the data principal's PII data, within reasonable time on consent revocation.
6. Data Principal may engage with a designated consent manager to liaise with a Data Fiduciary.
7. Audit trail of the consent should be available at any point in time.
8. Technical and organizational measures to ensure effective adherence of the policies
9. Data breaches to be intimated on time and mitigated promptly with established SLAs.
10. Prior collected personal data needs to be erased on revocation of consent. Data processor (3rd party data processing entity, if any) should also be intimated on the erasure of data.
11. Data Protection Officer contact should be provided and be valid at all times.
12. Consent from parents are required when personal data is collected, concerning children.
13. A Significant Data Fiduciary is one the Central Government notifies as
    such, based on factors including the volume and sensitivity of personal
    data processed and the risk to data principals - it is a notification,
    not a threshold an organisation self-assesses. An SDF must appoint a
    Data Protection Officer based in India, appoint an independent data
    auditor, and carry out periodic data protection impact assessments and
    audits.


We're in the process of creating APIs that encapsulate the obligations above so that each data fiduciary can adhere to the DPDP act completely and with ease.
See "What this is not" and "Breaking changes in 0.2.0" below for exactly where that process currently stands and what changed getting here.

## Breaking changes in 0.2.0

A 0.1.0 integration will not boot against 0.2.0 without changes:

- `createRouter` now requires a `db` handle and an injected `resolvePrincipal`
  - every mutating route denies without the latter.
- Startup config assertions: an unset or placeholder `FIDUCIARY_DPO_EMAIL` now
  refuses to boot, and so does a **set but malformed** one (`"tbd"`,
  `"not-an-email"`, a bare hostname). A deployment with a malformed address
  booted on 0.1.0 and served it to data principals on the grievance page.
- A non-positive-integer `GRIEVANCE_SLA_DAYS` or `RIGHTS_SLA_DAYS` now refuses
  to boot rather than becoming `NaN` at runtime.
- `principalId` is no longer derivable from an email, so 0.1.0 identifiers
  cannot be carried over - see "Migrating from 0.1.0" below.
- `ConsentRecord.lastNotice` changed shape - see "Migrating from 0.1.0" below.
- HTML responses on the negotiating routes (`POST /rights/exercise`,
  `POST /grievance`, `POST /consent-manager`, and now `POST /consent`) return
  `201` where they previously returned `200`.
- A cross-origin state-changing request is now refused with `403` unless its
  origin is the request's own host or is listed in the new `allowedOrigins`
  option.

## Setup

```bash
npm install
cp .env.example .env   # then set MONGO_URI and PRINCIPAL_ID_SECRET
```

```js
const express = require("express");
const { connect, createRouter } = require("dpdp-fiduciary-toolkit");

async function main() {
  const db = await connect(process.env.MONGO_URI);

  const app = express();
  app.use("/dpdp", createRouter({
    db,
    // Functionally required: the router still builds without it, but every
    // mutating route - and every read route - answers 401. See "Identity
    // and authentication" below.
    resolvePrincipal: (req) => req.session?.principalId ?? null,
  }));
  app.listen(4000);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

`express` is a peer dependency - install it in your own project.

The snippet above assumes `req.session.principalId` is already populated by
your own auth, which it has nothing to sign a session in with - every
authenticated route will 401 until you wire that up. For a complete, runnable
version, see `examples/server.js`: it adds a deliberately-labelled demo
sign-in (`POST /demo/login`) so the authenticated routes are actually
reachable end to end. Run it with `npm run example` (needs a Mongo instance
at `MONGO_URI`) and read the file's header comment for the full curl
sequence.

### Configuration is checked at boot

`createRouter` calls `assertConfigured()` before it builds a single route, so
a deployment carrying the `dpo@example.com` placeholder, or a
`FIDUCIARY_DPO_EMAIL` that is set but not a plausible address (`"tbd"`,
`"not-an-email"`, a bare hostname), or a `GRIEVANCE_SLA_DAYS` /
`RIGHTS_SLA_DAYS` that is not a positive integer, throws at startup instead of
reaching `listen()`. A placeholder or malformed Grievance Officer address is
worse than none: the grievance page publishes it, so the fiduciary looks like
it has met the duty to publish valid contact details while every complaint
sent there goes nowhere.

### Identity and authentication

`principalId` is a random 32-byte value (`crypto.randomBytes(32)`), never
derived from an email, a phone number, or anything else an attacker could
already know. It is minted server-side the first time someone signs up
(`POST /consent`), and it is never read from a request body or query string
on any route - the only source of identity on every other route is
`resolvePrincipal(req)`, which you supply.

`resolvePrincipal` may be synchronous or return a `Promise`; it should
resolve your own session (a cookie, a bearer token, whatever your host
already does) to the `principalId` you returned from an earlier
`POST /consent`, or return `null` (or reject) when there is no session. If it
is missing, throws, or resolves to anything that is not a 64-character hex
string, the route answers `401` rather than proceeding - a misconfigured
deployment fails closed, not open.

`POST /consent` is the one deliberate exception: it is how a `principalId`
comes to exist at all, so it does not require a session. It does, however,
refuse (`409`) to touch an existing principal's record - correcting your own
details afterwards is `PUT /consent`, authenticated, and it reads the
*stored* PII rather than the request body, so no payload can redirect the
write onto someone else's record.

### Cross-site request forgery

`resolvePrincipal` means the host supplies the credential, and in most
deployments that credential is a session cookie - which a browser attaches to a
cross-site form POST as readily as to your own. This router therefore refuses
any non-GET request whose `Origin` (or, failing that, `Referer`) names a host
other than the one the request arrived on. A request carrying neither header is
allowed through, because `curl` and server-to-server clients send neither and a
browser cannot omit `Origin` on a state-changing method.

Two things this does not do, and you must:

- **Set `SameSite=Lax` or `SameSite=Strict` on your session cookie.** The
  origin check is a second line, not a replacement. This library owns no
  session store - by design - so it cannot issue CSRF tokens.
- **Set `allowedOrigins` if your browser origin is not the `Host` this router
  sees** - a reverse proxy that rewrites `Host`, or a front end served from a
  separate origin. The host the request arrived on is *always* allowed;
  anything you list is permitted **in addition**, never instead, so naming a
  partner origin cannot quietly stop your own forms working. Entries may be
  full origins or bare hosts:

  ```js
  createRouter({ db, resolvePrincipal, allowedOrigins: ["https://portal.example", "localhost:3000"] })
  ```

## The APIs

Every route below is mounted relative to wherever you `app.use(path,
createRouter(...))` it - the rendered forms build their own `action` from
`req.baseUrl`, so mounting at `/dpdp` (or anywhere else) just works. Routes
marked **auth** deny with `401` unless `resolvePrincipal` resolves the
request to a `principalId`; routes marked **public** do not.

### 1. `persistPIIwithconsent` - signup: `POST /consent` (public); update: `PUT /consent` (auth)

Saves PII plus the consent decisions made, timestamped, and confirms with a
per-principal receipt (`docRef`, stable for the life of the record) and a
per-submission one (`receiptId`, new every call). Writes are
**non-destructive**: only a purpose whose state actually changes gets a new
event, and:

- Omitting `consentTypes` means "no consent decision this time" (e.g. a
  PII-only update) - existing consent is left exactly as it was.
- Submitting `consentTypes: []` means "I decline everything offered" - every
  optional purpose not already `withdrawn` gets a `denied` event.
- A purpose you already granted and list again is untouched (no duplicate
  event appended to the ledger).
- A purpose you already withdrew and list again **stays withdrawn** unless
  you also pass `regrant: true` - reversing a withdrawal is a separate,
  auditable act, not a side effect of re-submitting a form.
- A purpose resting on a Section 7 legitimate use (`kyc_reporting` in the
  shipped catalog) is not a choice - it is recorded once, automatically, on
  signup, and never appears as a checkbox.
- `pii.dob` is **required** - see "Age gate and parental consent" below.

```js
POST /consent
{
  "pii": { "name": "Asha Rao", "email": "asha@example.com", "dob": "1990-01-01" },
  "consentTypes": ["marketing"]
}
-> 201 {
  docRef: "CN-...", receiptId: "RC-...", principalId: "<64-char hex>",
  created: true,
  events: [ { type, status, basis, lawfulBasisKind, receiptId, timestamp, noticeVersion }, ... ],
  state: { marketing: { status: "granted", ... }, analytics: { status: "denied", ... }, ... },
  refusedForChild: []
}
```

`principalId` is a random opaque identifier, never derivable from the PII you
submitted. Save it, or better, put it behind your own session - see "Identity
and authentication" above.

```js
PUT /consent            // auth
{ "consentTypes": ["marketing"], "regrant": true }
-> 200 { docRef, receiptId, events, state, refusedForChild }   // no `created`
```

### 2. `withdrawConsent` - `PUT /consent/withdraw` (auth; `POST` too, for the HTML withdrawal form)

Appends a `withdrawn` event per purpose - it never edits or deletes history.

```js
PUT /consent/withdraw   // auth
{ "consentTypes": ["marketing"] }
-> 200 {
  docRef, receiptId,
  withdrawn: ["marketing"],
  rejected: [],   // e.g. a Section 7 purpose: { type, reason }
  noChange: [],   // already withdrawn, declined, or never granted - not an error
  effectiveFrom,  // null when withdrawn is empty
  contact: { dpoName, dpoEmail }
}
```

Withdrawing a `granted` purpose that rests on a Section 7 legitimate use
(`kyc_reporting`) is refused, landing in `rejected` with a reason naming the
clause it rests on - the statute does not let you withdraw a legitimate use,
so the toolkit does not pretend to honour a request it cannot grant.

### 3. Data principal rights (Chapter III) - `GET /rights` (public), `POST /rights/exercise` (auth)

`GET /rights` renders the rights catalog as HTML for a browser or JSON for an
API client - content negotiation lists JSON first, so `Accept: */*` (curl and
`fetch`'s default) gets JSON, not an HTML fragment. Submitting a request
against one of them creates a trackable `refId`.

```js
POST /rights/exercise   // auth
{ "right": "erasure", "details": "close my account" }
-> 201 { refId: "RQ-...", right: "erasure", status: "received", contact: { dpoName, dpoEmail } }
```

`right: "withdrawal"` and `right: "grievance"` are refused (`400`) with a
pointer to the dedicated endpoint for each: neither is a manually-processed
request, so filing one as a `RightsRequest` would misrepresent what actually
happens to it.

### 4. `complaintToTheBoard` / `escalateToBoard` - `GET /grievance/new` (public), `POST /grievance` (auth), `POST /grievance/:refId/escalate` (auth)

**Legal note:** under Section 13, a complaint must first go to the
fiduciary's own Grievance Officer - the Data Protection Board only hears it
if that is not resolved in time. So `POST /grievance` records the complaint
as addressed to your DPO (`FIDUCIARY_DPO_NAME` / `FIDUCIARY_DPO_EMAIL`) and
starts an SLA clock (`GRIEVANCE_SLA_DAYS`, default 7).

```js
POST /grievance   // auth
{ "subject": "Unwanted marketing calls", "description": "..." }
-> 201 { refId: "GR-...", addressedTo: "...", dpoEmail: "...", slaDueAt, note }
```

`note` says the grievance was **recorded**, not "sent": this package has no
mailer, no queue, no webhook, so nothing actually leaves the process. Pass
`onGrievanceFiled` to `createRouter` (below) if you want a real notification
to go out.

`escalateToBoard` is for once that SLA lapses unresolved, and is blocked from
firing early or twice. **It is local bookkeeping, not a filing with the
Board**: it sets `escalatedToBoard = true` and `escalatedAt` on the document
and contacts no one, because this package has no outbound channel to the Data
Protection Board or anywhere else. Read it as "mark this escalated in our own
records" and build the actual submission to the Board as a separate,
host-owned integration - do not read a `200` here as proof the Board has been
notified.

```js
POST /grievance/:refId/escalate   // auth
-> 200 { refId, status: "escalated", escalatedAt }
```

### 5. `consentManagerRequest` - `GET /consent-manager/new` (public), `POST /consent-manager` (auth)

Opens a form to request being connected with a Consent Manager - the
independent, Board-registered entity under Section 6(7)-(9) that can manage a
principal's consent across services. This toolkit only logs and hands off the
request; it does not act as a Consent Manager itself, and nothing is sent to
one - the same "recorded, not sent" caveat as the grievance note above.

```js
POST /consent-manager   // auth
{ "message": "I'd like one consent manager for all my finance apps" }
-> 201 { refId: "CM-...", status: "received" }
```

## Reading it back

Every write above has a matching read. Every read is **auth**, scoped by
construction to the signed-in principal (there is no path to read another
principal's data - a `refId` that exists but belongs to someone else 404s,
the same as one that does not exist at all, so a guessed reference cannot be
distinguished from a wrong one), and sent with `Cache-Control: no-store` so a
shared cache or CDN, or a browser's own disk/back-forward cache on a shared
machine, cannot serve one principal's response to the next.

| Route | Returns |
| --- | --- |
| `GET /consent` | `{ docRef, principalId, state, ledger, notice, pii, erasedAt, createdAt, updatedAt }` - the Section 11 right of access: the full event ledger plus current PII (`pii` is `null` if erased). |
| `GET /rights/requests` | Every rights request this principal filed, most recent first, capped at 200. |
| `GET /rights/requests/:refId` | One rights request. |
| `GET /grievances` | Every grievance this principal filed, most recent first, capped at 200. |
| `GET /grievances/:refId` | One grievance. |
| `GET /consent-manager/requests` | Every consent-manager request this principal filed, most recent first, capped at 200. |

## Age gate and parental consent

`pii.dob` is required on every `POST /consent` and `PUT /consent`. A
principal computed to be under 18 is refused (`422`) unless the call also
carries a `parentalConsent` object - and even then, purposes the catalog
marks `prohibitedForChildren` (`marketing` and `analytics` in the shipped
catalog) are refused outright, listed in the response's `refusedForChild`,
never granted regardless of parental consent.

`parentalConsent` is a **server-side-only parameter**: `persistPIIwithconsent`
accepts it, but no route or rendered form exposes it. See "What this is not"
below for what that means for a minor trying to register at all.

## Hooks: `onWithdrawal` and `onGrievanceFiled`

Pass these to `createRouter` to react to what the router just did:

- **`onWithdrawal({ principalId, types, effectiveFrom, receiptId })`** -
  called once, only when something actually changed, after the withdrawal
  event(s) are saved. **A throw here fails the request** (the caller sees the
  error): this hook is the host's only signal that it must cease processing
  and run its own erasure and processor-notification pipeline, and
  swallowing a failure here would mean nobody ever learns that pipeline is
  down.
- **`onGrievanceFiled({ principalId, refId, addressedTo, dpoEmail, slaDueAt, note })`**
  - called after the grievance is already persisted. **A throw here is
  logged and does NOT fail the request** - the grievance already has a
  `refId` the principal has already been shown; failing the response here
  would cost them that reference and produce a duplicate filing on retry.

## Erasure - `erasePrincipalPII`

Not mounted on the router - there is no HTTP route for it. Call it directly
from your own back office once you have decided a Section 12 erasure request
should actually be carried out.

```js
const { erasePrincipalPII } = require("dpdp-fiduciary-toolkit");

async function eraseOnRequest(models, principalId) {
  return erasePrincipalPII({ models, principalId });
  // -> { principalId, erasedAt, alreadyErased }
}
```

It clears the `Principal` document's PII and lookup hashes - irreversible,
and the person can no longer be re-identified by email or phone through this
system. It does **not** touch the `ConsentRecord` ledger, which is retained,
pseudonymously, as the fiduciary's own evidence that it had a lawful basis
for the processing it already did. See "What this is not" for what else it
does not reach.

## Fiduciary-side lifecycle: `advanceRightsRequest`, `advanceGrievance`, `advanceConsentManagerRequest`

`RightsRequest`, `Grievance` and `ConsentManagerRequest` all start in an
initial status (`received` / `open` / `received`) and need something to move
them forward. These are plain functions, **deliberately not mounted on
`createRouter`**: a data principal must not be able to close their own
grievance, and staff authentication for your back office is your host's
concern, not this library's.

```js
const { advanceGrievance } = require("dpdp-fiduciary-toolkit");

async function resolveGrievance(models, refId) {
  return advanceGrievance({ models, refId, status: "resolved", resolution: "Refunded the disputed charge." });
}
```

Each enforces its own transition map and throws `409` on an invalid move -
for example a `Grievance` can go `open -> in_progress -> resolved`, but not
straight to `escalated`: only `escalateToBoard` can reach that state, because
it is the only path that checks the SLA has actually lapsed first.

## Notice - `buildNotice`

Section 5 requires an itemised notice - what personal data, for what
purpose, how to exercise rights, how to complain - to accompany or precede
the request for consent. `buildNotice({ language })` generates it from the
live catalog, so it cannot drift from what the code actually processes.
`POST /consent` and `PUT /consent` store it: the body is deduplicated into
the `NoticeVersion` collection, content-addressed by a hash of its own
contents, and every consent event records which version was in force when it
was written. Only `en` ships with this toolkit; add a language by setting
`NOTICE_LANGUAGES` and supplying your own translated catalog strings -
Section 5(3) permits English or any language in the Eighth Schedule to the
Constitution. Rule 3(c)(i) of the DPDP Rules, 2025 is the source for
withdrawal needing to be as easy as granting, which the notice also states.

## Data model

- **Principal** - one per data principal: `pii`, `isMinor`, `parentalConsent`
  (if any), `erasedAt`. Erasable; holds no consent history.
- **ConsentRecord** - one per principal, keyed by the same `principalId`.
  `events[]` is an append-only ledger (`{ type, status, basis,
  lawfulBasisKind, receiptId, timestamp, noticeVersion }`); `status` is one
  of `granted`, `denied`, or `withdrawn`. `record.currentState()` resolves
  the latest event per purpose. Holds no PII, so it survives erasure.
- **NoticeVersion** - one row per distinct notice ever shown, content-addressed
  by `version`. Storage grows with the number of distinct notices, not with
  the number of consent events.
- **RightsRequest**, **Grievance**, **ConsentManagerRequest** - one document
  per request, keyed by `principalId`, each with a `status` your own back
  office advances with the lifecycle functions above.

## Migrating from 0.1.0

- **`principalId` values from 0.1.0 cannot be carried over.** They were
  `sha256(email)` - guessable from the email alone, which is what made 0.1.0
  unsafe to run. 0.2.0 issues random, unguessable ids, and there is no
  translation between the two. Re-registering (`POST /consent`) is the only
  path forward, and it will mint a new `principalId` for every existing
  principal.
- **`ConsentRecord.lastNotice` changed shape.** It used to hold the full
  notice body; it is now a `{ version, language, shownAt }` pointer into
  `NoticeVersion`. A `ConsentRecord` document written before this change
  still physically carries `lastNotice.body` on disk, but Mongoose strict
  mode drops it silently on the next read or save - it is not migrated
  forward. If you have pre-upgrade documents you care about, copy
  `lastNotice.body` into a `NoticeVersion` document keyed by
  `lastNotice.version` **before** upgrading, or that notice text is gone.
- See "Breaking changes in 0.2.0" above for what else changes at the API
  boundary.

The package has never been published, so no deployment has actually made
this jump yet - this section exists so the first one that does knows what to
expect.

## What this is not

- Not legal advice, and not a certified/audited compliance product - it's a
  structural reference for how the pieces fit together.
- PII is stored in plain fields for clarity. A production deployment should
  encrypt PII at rest (e.g. field-level encryption) and review what's
  actually necessary to retain.
- The consent/rights catalogs in `src/config/catalog.js` are a worked
  example (a fictional lender, "Kavach Finance") - replace them with your
  own purposes, retention periods, and DPO details before using this for
  real.
- `principalId` is a random opaque identifier, not a hash of anything. Earlier
  versions derived it from the data principal's email, which made it guessable
  by anyone who knew the address. Lookup hashes are keyed with
  `PRINCIPAL_ID_SECRET`, so they are pseudonymous - and pseudonymous data is
  still personal data under the Act.
- The consent ledger records three states per purpose: `granted`, `denied`
  (offered and declined), and `withdrawn` (previously granted, then revoked).
  A purpose that was never offered has no event at all.
- No verifiable parental consent mechanism. The toolkit detects that a data
  principal is under 18 and refuses to process their data, but it cannot verify
  a parent's identity, so there is no HTTP path for a minor to be registered
  even with genuine parental consent. An adopter serving minors must build that
  verification and call `persistPIIwithconsent` with a `parentalConsent` object
  from trusted server-side code. Do not expose that parameter to a form.
- **Withdrawal does not itself stop or erase anything.** What ships is the
  `onWithdrawal` hook - which tells your own code that a withdrawal happened -
  and `erasePrincipalPII`, an erasure primitive you call yourself. Neither one
  notifies a third-party processor: the library cannot tell a processor it
  does not know about to cease processing. Ceasing processing and erasing
  downstream are duties your integration has to complete; this toolkit gives
  you the signal and the primitive, not the pipeline.
- **`erasePrincipalPII` clears the `Principal` document only.** Free text a
  data principal typed into a grievance description, a rights-request
  `details` field, or a consent-manager `message` is not touched - deciding
  what in a block of prose is personally identifying is a judgement call an
  automated pass gets wrong. A deployment that treats `erasePrincipalPII` as
  completing a Section 12 erasure request, without also reviewing those three
  collections by hand, has not completed it.
- **No rate limiting on any route.** The nearer-term risk this toolkit closes
  is storage exhaustion via unbounded free text: every free-text field has a
  Mongoose `maxlength` cap, and the request body itself is capped at 100kb.
  Request-volume rate limiting (e.g. `express-rate-limit` in front of this
  router) is host middleware's job and is not shipped here.
- Not yet published to npm, and `npm install <git-url>` does not work, because
  `package.json` lives in the `data-fiduciary-toolkit/` subdirectory rather than
  at the repository root. Until it is published, vendor the `src/` directory or
  add it as a path dependency. The `require("dpdp-fiduciary-toolkit")` in the
  examples above is the name it will publish under.

Four items above - withdrawal/erasure not reaching your processors, erasure
not reaching free text, no rate limiting, and the install-from-git failure -
are closed **by this documentation, not by code**: an integrator who needs
any of them should plan to build it, not assume it exists. The
`escalateToBoard` note earlier in "The APIs" (it contacts no one) and the
parental-consent limitation above it (no minor can register over HTTP at
all) are the same kind of gap, recorded the same way. For the underlying
finding-by-finding audit this branch worked against, see
[`docs/superpowers/plans/2026-08-07-dpdp-audit-remediation/spec.md`](https://github.com/datsogood/dpdp-data-fiduciary-toolkit/blob/main/docs/superpowers/plans/2026-08-07-dpdp-audit-remediation/spec.md)
in the repository - it is not reproduced here because a fixed-in-time coverage
table next to living code drifts the moment either one changes.
