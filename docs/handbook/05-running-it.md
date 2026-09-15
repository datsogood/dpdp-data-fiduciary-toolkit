# 5. Running it, and what it will not do for you

This chapter is for whoever puts this package into a deployment and gets paged
when it misbehaves. Two halves. The first is mechanical: install it, set nine
environment variables, mount two routers. The second is the important one - the
list of things this package deliberately does not do, each of which is work
that lands on you.

Read the second half before you plan the integration, not after. Several of the
gaps are duties under the Digital Personal Data Protection Act, 2023 that a
deployment can fail while every request returns `200`.

One house rule that runs through everything below: this package records. It
never sends. There is no mailer, no queue, no webhook, no outbound HTTP client
anywhere in `src/`. When a response says a grievance was recorded, that is the
whole of what happened: a document was written and nothing left the process.

---

## Getting it running

### What you need

- **Node 20 or newer.** `package.json` sets `"engines": { "node": ">=20" }`.
- **A MongoDB you can reach.** Any version Mongoose 8 speaks. The test suite
  runs against an in-memory mongod 7.0.24.
- **Express in your own project.** It is a peer dependency
  (`^4.19.2 || ^5.0.0`), not a dependency - this package does not choose your
  Express version for you.

### Installing

The package is **not published to npm yet**, and `npm install <git-url>` does
not work either, because `package.json` lives in the `data-fiduciary-toolkit/`
subdirectory rather than at the repository root. Until that changes, vendor the
`src/` directory into your project or add it as a path dependency. The
`require("dpdp-fiduciary-toolkit")` in every example below is the name it will
publish under.

```bash
npm install                # inside data-fiduciary-toolkit/
cp .env.example .env       # then fill in PRINCIPAL_ID_SECRET and FIDUCIARY_DPO_EMAIL
                            # (MONGO_URI already points at localhost; the shipped
                            #  dpo@example.com placeholder refuses to boot)
```

`.env.example` ships `PRINCIPAL_ID_SECRET` **empty**, on purpose - there is no
safe default for a secret. Filling it in is step one, not a later chore. See
the table below for how to generate one.

### A minimal host application

```js
const express = require("express");
const { connect, createRouter } = require("dpdp-fiduciary-toolkit");

async function main() {
  const db = await connect(process.env.MONGO_URI);

  const app = express();
  app.use(
    "/dpdp",
    createRouter({
      db,
      // Your session lookup. Without it, every authenticated route answers 401.
      resolvePrincipal: (req) => req.session?.principalId ?? null,
      // Called when a withdrawal actually changed something. A throw here
      // fails the request - see "The hooks you must supply".
      onWithdrawal: async ({ principalId, types }) => {
        await yourQueue.publish("dpdp.cease-processing", { principalId, types });
      },
      // Called after a grievance is persisted. A throw here is logged only.
      onGrievanceFiled: async ({ refId, dpoEmail }) => {
        await yourMailer.notifyDpo(dpoEmail, refId);
      },
    })
  );

  app.listen(4000);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
```

Three things about that snippet.

**Mount path is yours.** Every rendered form builds its own `action` from
`req.baseUrl`, so `/dpdp`, `/privacy`, or `/` all work without configuration.

**The router owns no connection.** `connect()` returns an isolated Mongoose
connection created with `mongoose.createConnection` - deliberately not
`mongoose.connect`, which mutates the global default connection and the global
model registry. If your host application already uses Mongoose, this library
will not disturb it. The flip side: **you own that connection's lifetime**, so
close it on shutdown.

**`resolvePrincipal` is not optional in practice.** The router builds without
it. Then `POST /consent` (signup) and the four public pages still work, and
every other route answers `401` forever. That is the failure mode you get from
the snippet above if `req.session` is never populated, because this package has
nothing to sign anyone in with.

### The runnable example

`examples/server.js` is the complete version, including a deliberately-labelled
demo sign-in so the authenticated routes are actually reachable:

```bash
npm run example        # needs a Mongo at MONGO_URI
```

```bash
curl -s localhost:4000/consent -X POST -H 'Content-Type: application/json' -d '{
  "pii": {"name":"Asha Rao","email":"asha@example.com","dob":"1990-01-01"},
  "consentTypes": ["marketing"]
}'

curl -s localhost:4000/demo/login -X POST -H 'Content-Type: application/json' \
  -d '{"email":"asha@example.com"}'

curl -s localhost:4000/consent -H 'x-demo-session: <token from above>'
```

`POST /demo/login` is an in-memory `Map`, not a session store, and it is
labelled as such in the file. Read it as a shape, not a starting point. The one
piece of it worth copying is the call to `findPrincipalByContact` - that is the
supported way to turn "I have just verified this email belongs to this person"
into a `principalId`.

### Running the tests

```bash
npm test
```

Not `node --test`. The suite starts exactly one in-memory mongod in a global
setup hook (`scripts/test-setup.js`) and passes its URI to every forked test
process through `MONGO_TEST_URI`. Run the files directly and the helper throws
with that explanation. The first run downloads the pinned mongod binary.

---

## Every environment variable

`src/config/catalog.js` calls `require("dotenv").config()` on its first line, so
a `.env` file in the process working directory is picked up by the library
itself, whether or not your host also loads dotenv.

| Variable | What it does | If missing or wrong |
| --- | --- | --- |
| `MONGO_URI` | The connection string `connect()` opens. | Not checked at boot by the config gate. `connect()` throws `AppError("MONGO_URI is not set - pass one explicitly or set it in the environment", 500)` when it is absent or not a string. You can also pass a URI to `connect(uri)` directly and skip the variable. |
| `PRINCIPAL_ID_SECRET` | HMAC key for the lookup hashes of a data principal's email and phone. | **Refuses to boot** if unset, blank, whitespace, or shorter than 32 characters after trimming. Generate with `openssl rand -hex 32`. Treat it as permanent once you hold data: changing it orphans every existing lookup, because `emailHash` and `phoneHash` on file were derived under the old key. |
| `FIDUCIARY_NAME` | Your organisation's name, shown to data principals in the notice. | **Not validated.** Defaults to `"Kavach Finance"`, the fictional lender in the shipped catalog. A deployment that forgets this boots cleanly and shows a real person a fictional company's name. |
| `FIDUCIARY_DPO_NAME` | Grievance Officer / Data Protection Officer name, published on the grievance page and returned in every contact block. | **Not validated.** Defaults to the generic string `"Data Protection Officer"`. |
| `FIDUCIARY_DPO_EMAIL` | The address a data principal is told to complain to. | **Refuses to boot** on the placeholder `dpo@example.com`, and separately on anything that is not shaped like an address (`"tbd"`, `"not-an-email"`, a bare hostname, a value with stray whitespace). |
| `GRIEVANCE_SLA_DAYS` | Days the Grievance Officer has before a data principal may escalate. Defaults to 7. | **Refuses to boot** unless it is a positive integer. `"seven"` and `"7.5"` both fail. |
| `RIGHTS_SLA_DAYS` | Days a Chapter III rights request is expected to take. Defaults to 30. | **Refuses to boot** on the same rule. |
| `NOTICE_LANGUAGES` | Languages the Section 5 notice is offered in. | **Refuses to boot** unless the resolved list is exactly `["en"]`. A stray comma or a blank value resolves to `[]` and is refused too. Only English ships - see below. |
| `PORT` | Read by `examples/server.js` only. Nothing in `src/` looks at it. | Defaults to 4000 in the example. Irrelevant to a real deployment, which listens on its own port. |

### Generating the one secret

```bash
openssl rand -hex 32
```

That is 64 hex characters, comfortably over the 32-character floor. Put it in
your secret manager, not in the repository. `.env.example` ships it empty so
that a copied file cannot accidentally become a shared production key.

### A load-order trap worth knowing

`FIDUCIARY` (in `catalog.js`) and `SUPPORTED_NOTICE_LANGUAGES` (in `notice.js`)
are both snapshots taken when the module is first required. Setting
`process.env.FIDUCIARY_DPO_EMAIL` after you have required the library changes
nothing. `PRINCIPAL_ID_SECRET` is the exception - it is read live from
`process.env` on every check and every hash. If you are writing tests that
manipulate configuration, the notice-language tests in `test/catalog.test.js`
show the only reliable approach: a fresh subprocess per configuration.

---

## What fails at boot, on purpose

`createRouter` and `createBackOfficeRouter` each call `assertConfigured()`
before they build a single route. A misconfigured deployment therefore dies at
startup and never reaches `listen()`.

**The principle, stated once.** Failing to boot is loud, immediate and fixed by
one environment variable. The alternative is a deployment that boots clean,
passes its health check, renders `GET /consent/new` - and then fails the first
`POST /consent` with a `500`, or publishes an unreachable Grievance Officer
address to someone trying to complain. Loud at boot beats silent at boot and
loud in front of a data principal. Every gate below exists because the second
failure mode was actually shipped at some point.

| What you did | What you get | The fix |
| --- | --- | --- |
| Left `FIDUCIARY_DPO_EMAIL` as `dpo@example.com` (or unset - `\|\|` collapses that to the same placeholder) | Startup throw naming the placeholder and the duty to publish valid contact details | Set a real Grievance Officer address |
| Set it to something that is not an address - `"tbd"`, `"not-an-email"`, `" "` | Startup throw quoting the value back | Same |
| `GRIEVANCE_SLA_DAYS=seven` or `RIGHTS_SLA_DAYS=0` | `GRIEVANCE_SLA_DAYS must be a positive integer, got: seven` | A positive integer |
| `PRINCIPAL_ID_SECRET` unset, blank, or 31 characters | Startup throw naming the 32-character floor and `openssl rand -hex 32` | Generate one |
| `NOTICE_LANGUAGES=en,hi` | Startup throw explaining that only English has a catalog | `NOTICE_LANGUAGES=en`, or do the translation work |
| Built the back-office router without `rateLimitedByHost: true` | Startup throw explaining that `POST /principals/lookup` is a people-search | Put a limiter in front, then pass the flag |

Three of those deserve their reasoning spelled out.

**The DPO address.** A placeholder is worse than nothing. The grievance page
renders it, so the organisation looks like it has published Grievance Officer
contact details while every complaint sent there goes nowhere. The shape check
is deliberately not RFC 5322 - that grammar accepts addresses no mail system
routes, and wrongly rejecting a real officer's address would be the worse
failure. It catches what actually gets committed to a `.env`: blank, no domain,
no dot in the domain, copy-paste whitespace.

**A non-integer SLA.** `Number("seven")` is `NaN`. Every `slaDueAt` built from
it becomes an Invalid Date, and the request fails at the moment someone tries to
file a grievance or exercise a right - which is exactly when it must not.

**The notice language.** This one surprises people, because it looks like a
feature flag waiting to be switched on. It is not. There is no translation map
anywhere in this package: every notice string comes from one English catalog,
while `buildNotice` validates the requested language and stamps it onto the
body. So `NOTICE_LANGUAGES=en,hi` plus `?lang=hi` produced an **English notice
labelled `hi`**, stored under its own content hash and cited by every consent
event written under it. That is affirmative false evidence of Section 5(3)
compliance, written to an append-only ledger that cannot be corrected. Section
5(3) does permit any Eighth Schedule language; supplying one means writing a
translated catalog and having someone who reads the language review it, then
relaxing this check deliberately.

**The back office acknowledgement.** `createBackOfficeRouter` refuses to build
unless you pass `rateLimitedByHost: true` - the literal boolean, not a truthy
value. It is a plain `Error`, never an `AppError`, precisely so it cannot be
mapped to an HTTP response: this must kill the process, not become a `500`.
Passing the flag is an acknowledgement, not a configuration - the router does no
limiting either way. It is asking you to confirm you have put
`express-rate-limit` or equivalent in front of a route that answers whether an
email address belongs to a registered data principal. With the shipped catalog's
lender, "registered" means "applied for credit".

### The gate only runs when you build a router

`assertConfigured` is called from `createRouter` and `createBackOfficeRouter`,
and nowhere else. It is not exported from the package entry point. If your
integration skips the HTTP layer and calls the service functions directly -
`persistPIIwithconsent`, `withdrawConsent`, `exerciseRight` - **nothing checks
your configuration at all**, and you get the runtime failures the gate exists to
prevent: a `500` from `lookupHash` on the first hashed contact detail, an
Invalid Date on the first rights request, an unreachable DPO address in every
contact block. A direct-service host should validate its own environment at
startup, or build a router it never mounts purely to get the check.

---

## The hooks you must supply

Four functions, all injected. The library holds no session store, no staff
directory, and no outbound channel, so each of these is a place where the host
supplies something the library structurally cannot.

| Hook | Passed to | Called when | A throw |
| --- | --- | --- | --- |
| `resolvePrincipal(req)` | `createRouter` | Every authenticated route, before the handler | Answers `401`, request stops |
| `resolveOperator(req)` | `createBackOfficeRouter` | Every back-office route | Answers `401`, request stops |
| `onWithdrawal({ ... })` | `createRouter` | After a withdrawal is saved, only when something changed | **Fails the request** |
| `onGrievanceFiled({ ... })` | `createRouter` | After a grievance is persisted | Logged, request still succeeds |

### `resolvePrincipal(req)` - who is this data principal

Returns a `principalId`, or `null` when there is no session. May be
synchronous or return a Promise; the router awaits it either way.

The value is checked against `/^[a-f0-9]{64}$/`. Anything else - `null`, a
number, a Promise you forgot to await, an object - produces `401`. So does a
throw. So does the hook being absent. **The router fails closed in every
direction**, which is the point: a misconfigured deployment denies access rather
than granting it.

`principalId` is never read from a request body or query string on any route
`createRouter` mounts. It is a database key, not a credential, and an earlier
version derived it from the data principal's email - which meant anyone who knew
an address could act as that person. The identifier is now 32 random bytes.

Building the hook usually starts from a contact detail you have just verified:

```js
const { findPrincipalByContact } = require("dpdp-fiduciary-toolkit");

// After your own OTP or emailed one-time link has succeeded:
const principal = await findPrincipalByContact({ models, email: verifiedEmail });
req.session.principalId = principal ? principal.principalId : null;
```

One caveat carried over from the identity chapter: a phone number alone does not
identify a person here. `findPrincipalByContact` refuses with `409` when a
number matches more than one principal rather than guessing between household
members.

### `resolveOperator(req)` - which member of staff is this

Returns `{ actorRef }`, or a Promise for it. `actorRef` is your own opaque staff
reference - a staff id, a UUID, an LDAP uid. It is validated by
`assertOpaqueRef`, a positive allow-list admitting letters, digits, dot,
underscore, colon and hyphen. No space, so no free text; no `@`, so no address.

Absent, throwing, or returning anything else and every back-office route answers
`401` in JSON. Operator identity is never read from the payload, because
`actorRef` is the entire content of the accountability record, and one the
caller chooses is not accountability.

### `onWithdrawal({ principalId, types, effectiveFrom, receiptId })`

Called once per withdrawal request, **only if something actually changed**, and
only after the ledger events are saved.

**A throw here fails the request.** That is deliberate. This hook is the host's
only signal that it must cease processing and run its own erasure and
processor-notification pipeline, and swallowing the failure would mean nobody
ever learns that pipeline is down.

Two consequences you have to design around.

The withdrawal is **already durable** when the hook runs. A throw produces a
`500` for the data principal, but the ledger event is saved and the withdrawal
took effect. You have failed the response, not the withdrawal.

And a retry does not re-fire the hook. On the second attempt the purposes are
already `withdrawn`, so nothing changes, `withdrawn` is empty, the save is
skipped and the hook is never called. The trail records the retry as a
`withdrawal_not_applied` row with `reasonCode: "not_granted"`, which is how you
would find it afterwards - but the cease-processing signal is gone.

So make the hook cheap and reliable: enqueue the work, do not do it inline.
Publishing to a queue you own is a good hook. Calling three processors'
APIs synchronously is not.

### `onGrievanceFiled({ principalId, refId, addressedTo, dpoEmail, slaDueAt, note })`

Called after the grievance is already persisted.

**A throw here is logged and does not fail the request.** The opposite answer to
`onWithdrawal`, for a reason worth internalising: the grievance already has a
`refId`, and failing the response would cost the data principal that reference
and produce a duplicate filing on retry for the Grievance Officer to reconcile.
Notification is not the filing.

That asymmetry is written down as [ADR
0003](../adr/0003-split-failure-policy.md), and the same seam runs through the
trail: instrumentation writes fail open, back-office disclosure writes fail
closed.

### The withdrawal path with no hook at all

`PUT /consent` can withdraw a purpose **by omission** - submit a shorter consent
list and whatever is missing gets withdrawn. On that path **no `onWithdrawal`
hook fires**, because `persistPIIwithconsent` takes no such parameter and the
router passes none.

The withdrawal itself is in the ledger. What the trail adds is a
`withdrawal_hook_not_fired` entry recording that your cease-processing pipeline
was never told. Read that as written proof that a Section 6(6) cessation duty
may have gone undischarged. Recording that the hook did not fire is not the same
as firing it - closing that gap is yours.

---

## What this package deliberately does not do

This is the section to read twice. Every item is a decision, not an omission,
and every one of them is work that lands on your integration.

### Session management

**What ships:** the `resolvePrincipal` hook, and `findPrincipalByContact` to
turn a verified contact detail into a `principalId`.

**What you must do:** everything else. Sign-in, session issuance, session
storage, expiry, revocation, cookie flags. Also **set `SameSite=Lax` or
`SameSite=Strict` on your session cookie** - the router's same-origin check on
state-changing requests is a second line, and this library cannot issue CSRF
tokens because it owns no session store.

**The harm if you assume otherwise:** there is no default. Nothing signs anyone
in, so an integration that skips this has a privacy portal where every
authenticated route returns `401` - visible immediately. The dangerous version
is the half-built one: trusting a client-supplied `principalId`. Do not. It is a
database key, and treating it as a credential is the exact bug an earlier
version shipped.

### Staff authentication

**What ships:** the `resolveOperator` hook, and a router that answers `401` on
every route without it.

**What you must do:** authenticate your own staff, in front of the back-office
mount, with your own middleware.

**The harm:** nothing on the back-office router is scoped to a session
principal, because an operator authorised to read one data principal's trail is
authorised to read any - that is what a back office is. Mount it without staff
auth in front and you have published a people-search over your customer base.

### Rate limiting

**What ships:** nothing. Free-text fields have Mongoose `maxlength` caps and the
request body is capped at 100kb, which closes storage exhaustion. Request-volume
limiting is not here.

**What you must do:** put a limiter (for example `express-rate-limit`) in front
of both mounts. For `createRouter` that is advice. For
`createBackOfficeRouter` it is a hard prerequisite, backed by the boot-time
refusal described above.

**The harm:** `POST /principals/lookup` answers whether an address belongs to a
registered data principal. Unlimited, that is a membership oracle over a
guessable keyspace - and for a lender, membership means "has applied for
credit". On the principal-facing router the risk is lower but real: `POST
/consent` is unauthenticated by necessity.

### Sending anything to anyone

**What ships:** records. There is no mailer, no queue, no webhook, no outbound
HTTP client in `src/`.

**What you must do:** build every notification you need, from the hooks and the
stored documents.

**The harm:** the specific traps are named in the code because they are easy to
misread.

- `POST /grievance` responds "Recorded for <officer>", not "sent". Nothing left
  the process. Your DPO learns about it when `onGrievanceFiled` tells them, or
  when someone reads the collection.
- `escalateToBoard` sets `escalatedToBoard = true` and `escalatedAt` on a
  document and **contacts no one**. It is local bookkeeping. Do not read a `200`
  as proof that the Data Protection Board has been notified; building the actual
  submission is a separate, host-owned integration.
- `POST /consent-manager` logs a handoff request. Nothing is sent to a Consent
  Manager, and this package does not act as one.

### Reaching your processors on a withdrawal

**What ships:** the `onWithdrawal` signal, and `erasePrincipalPII` as a
primitive you call yourself.

**What you must do:** the pipeline. Tell your processors to cease, run your own
downstream deletions, and reconcile when the hook throws.

**The harm:** withdrawal does not itself stop or erase anything. The library
cannot tell a processor it does not know about to cease processing, and a
deployment that treats a successful withdrawal response as "we have stopped"
has a Section 6(6) duty outstanding with a green dashboard.

### Redacting free text on erasure

**What ships:** `erasePrincipalPII` clears the `Principal` document - name,
email, phone, dob, PAN, address, both lookup hashes, and the guardian's contact
details on a child's record. Irreversibly.

**What you must do:** review, by hand, the free text a data principal typed into
three other collections - a grievance `description`, a rights request `details`
field, a consent-manager `message`. Nothing automated touches them.

**The harm:** a deployment that treats `erasePrincipalPII` as completing a
Section 12 erasure request, without that review, has not completed it. Someone
who typed their own address into a complaint still has it on file.

A fourth collection survives erasure and is deliberately **not** on that review
list: `trailentries`, the consent audit trail. It holds no free text and no
contact detail by construction, so there is nothing in it to review. More on
that below.

### Verifying parental consent

**What ships:** an age gate. `pii.dob` is required on every consent write, and a
data principal computed to be under 18 is refused with `422` unless the call
carries a verified `parentalConsent` object. Purposes the catalog marks
`prohibitedForChildren` - `marketing` and `analytics` in the shipped catalog -
are refused outright even with parental consent, and listed in
`refusedForChild`.

**What you must do:** if you serve minors, build the verification yourself and
call `persistPIIwithconsent` with a `parentalConsent` object from trusted
server-side code.

**The harm:** `parentalConsent` is a server-side parameter only. No route and no
rendered form exposes it, and none may - a form field a child can fill in is not
verification of a parent. So **there is no HTTP path for a minor to register at
all**, even with genuine parental consent. A `422` and a stated reason is the
honest answer here; silently accepting the registration would not be. Do not
wire that parameter to a request body.

### A few smaller ones, stated for completeness

- **There are no database transactions on the write path.** `persistPIIwithconsent`
  saves the `Principal` document and then the `ConsentRecord` document,
  sequentially. If the process dies or the connection drops between the two
  saves, you get a `Principal` with no `ConsentRecord` - a half-written signup.
  `GET /consent` reads `ConsentRecord` first and 404s when it is missing, even
  though the `Principal` exists, so this failure looks identical to "never
  signed up" from every read this package offers. Detecting it means querying
  for a `Principal` with no matching `ConsentRecord` directly; nothing here
  does that for you.
- **PII is stored in plain fields.** Clear to read, and not what a production
  deployment should do. Add field-level encryption at rest, and review what is
  actually necessary to retain.
- **The catalogs are a worked example.** `src/config/catalog.js` describes a
  fictional lender. Replace the purposes, lawful bases, retention periods and
  DPO details with your own before this is anywhere near real data. Getting a
  lawful basis wrong is not cosmetic: a purpose wrongly marked
  non-withdrawable makes this toolkit refuse a withdrawal the statute
  guarantees.
- **Correcting contact details is not a route.** `updatePrincipalContact` is
  exported and does the real work, but wiring it to a route is a verification
  decision, not a wiring decision - changing a stored email rewrites the hash
  signup matches on, and only your host can prove someone controls a new
  address.

**This section is the gap between this package and the Act, not the gap
between your deployment and the Act.** It does not cover every duty Section 8
places on a data fiduciary. Personal data breach notification to the Board and to
affected data principals (Section 8(6)) is not modelled at all - nothing here
detects a breach or notifies anyone. Neither is Section 16's restriction on
transferring personal data to a country the Central Government has not
notified. Both are your integration's responsibility in full, the same as
everything above.

None of this is legal advice, and this package is not a certified or audited
compliance product. It is a structural reference for how the pieces fit
together.

---

## Mounting the back office safely

```js
const { createBackOfficeRouter } = require("dpdp-fiduciary-toolkit");

app.use(
  "/back-office",              // a DIFFERENT path from createRouter's mount
  yourStaffAuthMiddleware,     // your own - the library has none
  yourRateLimiter,             // required, and acknowledged below
  createBackOfficeRouter({
    db,
    resolveOperator: (req) => ({ actorRef: req.staff.id }),
    rateLimitedByHost: true,
    allowedOrigins: ["https://back-office.example"],
  })
);
```

Four rules, in order of how badly it goes if you break them.

**Separate mount, never the same path as `createRouter`.** These are two
routers with two different audiences and two different notions of identity.
Nothing on the back-office router is scoped to a session principal.

**Staff auth in front, and `resolveOperator` inside.** The middleware decides
who gets in; the hook says who they are for the record. Without the hook, every
route answers `401` - fails closed - but that is a safety net, not a design.

**A rate limiter in front, then `rateLimitedByHost: true`.** The flag changes no
behaviour. It is an acknowledgement, enforced by a boot-time refusal.

**`allowedOrigins` if your back-office front end is served from a different
origin than the `Host` this router sees.** The host a request arrived on is
always allowed; this list is a union with it, never a replacement, so naming a
partner origin cannot quietly stop your own pages working.

### Two routes, both POST

```js
POST /principals/lookup   { "email": "asha@example.com", "caseRef": "TKT-90210" }
-> 200 { principalId: "..." }      // 404 if nobody matches

POST /principals/trail    { "principalId": "...", "caseRef": "TKT-90210" }
-> 200 { principalId, docRef, coverageFrom, timeline, truncated, totalEntries }
```

Both are POST, for the four reasons in Chapter 3.

The lookup is **email only**. It refuses the phone branch that a direct library
caller still gets, for the household reason above.

### Why access records make browsing detectable, not impossible

This is the part to explain to whoever asks why staff can read any trail.

An operator authorised to answer one Section 11 request is, structurally,
authorised to read any data principal's record - that is what a back office is.
Scoping cannot fix that. So the control is **attribution** instead:

- Every access is recorded **before anything is returned**, on every path
  including the `404`. An operator who probes an id that does not exist has
  still used the surface.
- The write **fails closed**. If the record cannot be written you get a `503`
  and no data at all. No record, no disclosure.
- `outcome` says what actually happened. A hit is `recorded`; a miss is
  `refused` with `reasonCode: "no_match"`. A row that always said "recorded"
  would make a probe indistinguishable from reading someone's whole lineage.
- `caseRef` is your own ticket reference, so the record says **why** - answering
  a Section 11 request, rather than browsing.
- `actor.ref` is indexed, because detecting insider enumeration is a question of
  per-operator volume and that index is the whole answer to it.
- The data principal's own `GET /consent/trail` includes those rows, with the
  individual operator's reference withheld. They can see **that** someone in
  your back office looked at them. That is the headline of the feature, not the
  back office itself.

What the access record deliberately does **not** hold is any hash of the address
that was searched for. On a hit it files under `principalId` alone; on a miss it
stores no subject at all. Storing the hash beside the `principalId` would
rebuild the email-to-person index that erasure exists to destroy - you hold
`PRINCIPAL_ID_SECRET`, so you could recompute it and rejoin an erased person to
their surviving record forever. Storing it on a miss would mint a permanent
contact-derived identifier for someone who is not your data principal at all.
The schema has no field either could be written to, so a later edit cannot
reintroduce the hazard.

One duty this creates for you: `actor.ref` and `caseRef` are **your own staff's
personal data**, retained in a collection nothing deletes from, under your own
employment basis. `assertOpaqueRef` bounds their shape, not their meaning -
`johnsmith` passes it unharmed. You owe your staff duties this library does not
discharge.

---

## Operating the trail

### It grows, and nothing deletes from it

There is no `deleteOne`, `deleteMany`, `findOneAndDelete` or TTL index anywhere
in `src/`. Not for the trail, not for anything else. Retention is entirely your
operational decision, made outside this library.

Size it with the partition rule in mind: the trail stores only facts that are
destroyed or never written anywhere else, and everything a read can recover from
a primary collection is derived at read time. So an ordinary data principal
produces **single-digit** stored rows over their whole relationship with you.

The exception is the one to watch. `operator_lookup` and `operator_trail_read`
rows are filed under the **subject's** `principalId`, not the acting operator's.
A person your back office looks up often accumulates far more stored rows than
their own activity would predict. That unbounded input is why the read is
bounded: `?limit=` defaults to 500, accepts 1 to 1000, and each of the four
collections the read queries with `find()` - `trailentries`, `rightsrequests`,
`grievances` and `consentmanagerrequests` - is scanned to a ceiling of 5000
rows. The consent ledger is not capped: it is a single `findOne()`, and every
event on it becomes a derived entry. `truncated` and `totalEntries` say
honestly whether the caller has seen everything.

Two indexes exist: `principalId` and `actor.ref`. No compound index, no unique
index.

### It holds no PII, and it survives erasure

By construction, not by convention. The schema has no free-text field, no
contact field and no contact-hash field. Reference ids (`refId`, `receiptId`)
are random. `consentTypes` elements are validated against the live catalog by
the writer and dropped when they do not match, so caller-supplied text typed
into a consent type cannot reach a collection that outlives erasure.

`erasePrincipalPII` writes nothing to the trail, edits nothing in it, and
deletes nothing from it. The erasure is read back from `Principal.erasedAt` and
appears in the timeline as a derived entry. So unlike the three free-text
collections, there is nothing here for you to review by hand - it is retained
pseudonymously as evidence, the same way the consent ledger is.

### Trail writes fail open. Watch the log.

`recordTrail` never throws. A failed write logs and the underlying act
proceeds, because the trail must never take down consent capture, a withdrawal,
or the refusal message a data principal needs to read. The log line is
deliberately thin - `err.name` and `err.code`, never `err.message`, because
Mongoose cast and duplicate-key messages quote the offending value back and that
is how a caller-supplied email reaches a log file:

```
[dpdp] trail write failed { name: 'MongoServerError', code: 11000 }
```

Alert on it. It is your only signal that the trail has a hole. Two other lines
worth a rule in your log pipeline:

```
[dpdp-toolkit] onGrievanceFiled threw after the grievance was filed: <error>
[dpdp-toolkit] unhandled error: <error>
```

The back office is the one place that fails the other way: `recordTrailStrict`
throws `AppError(..., 503)` and no disclosure happens.

### What to tell an auditor about coverage

Say this, and say it plainly:

> The consent audit trail covers acts from **2026-09-04** forward. Entries are
> written as acts happen. Acts before that date left no entry, and no backfill
> is possible or permitted, because reconstructing a timestamp nobody observed
> would be manufacturing evidence.

You do not have to remember the date. Every trail read returns it as
`coverageFrom`, so an empty timeline reads as "we were not recording before this
date" rather than as "nothing happened". It is a module constant returned
verbatim, not a stored marker row.

Then say the second half, which matters just as much:

> The trail is evidence of what was recorded. It is not proof that nothing else
> happened. Instrumentation writes are best-effort, so an entry can be missing,
> and this package makes no completeness claim. Only the back office's own
> access records fail closed.

That is the same register as "recorded", never "sent". Do not let a report built
on this data drift into stronger language than the data supports.

---

## A pre-deploy checklist

- [ ] `PRINCIPAL_ID_SECRET` generated with `openssl rand -hex 32`, stored in a
      secret manager, and understood to be permanent.
- [ ] `FIDUCIARY_NAME`, `FIDUCIARY_DPO_NAME`, `FIDUCIARY_DPO_EMAIL` are yours,
      not `Kavach Finance` and not `dpo@example.com`. Two of those three are not
      checked at boot.
- [ ] Both SLA variables are positive integers you can actually meet.
- [ ] `NOTICE_LANGUAGES=en`, unless you have written and reviewed a translated
      catalog.
- [ ] The catalog in `src/config/catalog.js` describes your purposes, your
      lawful bases and your retention periods.
- [ ] `resolvePrincipal` is wired to a real session, and the session cookie is
      `SameSite=Lax` or stricter.
- [ ] `allowedOrigins` set if your browser origin differs from the `Host` the
      router sees.
- [ ] `onWithdrawal` enqueues work rather than doing it inline, and you have
      decided what happens when it throws.
- [ ] `onGrievanceFiled` actually reaches your Grievance Officer, because
      nothing else will.
- [ ] The back office is on its own path, behind staff auth, behind a rate
      limiter.
- [ ] Your erasure runbook includes a manual review of grievance descriptions,
      rights-request details and consent-manager messages.
- [ ] Log alerts exist for `[dpdp] trail write failed`.
- [ ] Someone owns the connection lifecycle and closes it on shutdown.
