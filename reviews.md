# Code review - dpdp-data-fiduciary-toolkit

Date: 2026-08-07
Reviewed at commit: `6c98d19`
Scope: the whole repo - 20 tracked files, ~834 lines under `data-fiduciary-toolkit/`.

Method: every file read end to end, then a four-lens parallel audit (security, correctness,
DPDP legal fidelity, repo hygiene) with an adversarial refutation pass over every claim and
a completeness critic pass. 9 agents, 145 tool calls. 44 findings survived refutation, 8 new
findings came from the critic, 2 were refuted and dropped. Runtime behaviour was verified by
execution rather than asserted from memory wherever it was load-bearing; section 6 records
what was tested and what the audit corrected.

---

## 1. How the repo is put together

A Node/Express/Mongoose library that models an Indian data fiduciary's DPDP obligations as
five service functions, each with a pre-wired HTTP route.

```
config/catalog.js     the single source of truth for purposes, rights, and org identity
    |
services/*.js         framework-agnostic, no req/res, throw on bad input
    |
http/router.js        thin Express adapter; forms.js renders server-side HTML
    |
models/*.js           Mongoose; ConsentRecord is an append-only event ledger
```

| API | Route(s) | Service |
| --- | --- | --- |
| Capture consent | `POST /consent` | `persistPIIwithconsent.js` |
| Withdraw consent | `PUT /consent/withdraw` | `withdrawConsent.js` |
| Data principal rights | `GET /rights`, `POST /rights/exercise` | `dataPrincipalRights.js` |
| Grievance + escalation | `GET /grievance/new`, `POST /grievance`, `POST /grievance/:refId/escalate` | `complaintToTheBoard.js` |
| Consent manager handoff | `GET /consent-manager/new`, `POST /consent-manager` | `consentManagerRequest.js` |

### What is done well

- **The layering is real, not decorative.** Services take plain objects and throw plain
  errors; nothing in `services/` imports Express. That makes the toolkit genuinely
  embeddable, which matters for the stated audience.
- **The consent ledger has the right shape.** `events[]` is append-only and each event
  snapshots the legal `basis` at the time it was written, so a later catalog change cannot
  rewrite history. That is exactly what an auditor needs.
- **`currentState()` resolves ties correctly.** `event.timestamp >= existing.timestamp`
  (`ConsentRecord.js:37`) picks the later array element on a same-millisecond tie, which for
  a push-only ledger is the chronologically later write. This was flagged as fragile during
  review, then executed and found correct.
- **Section 13 ordering is enforced in code, not in a comment.** `escalateToBoard` refuses
  to fire before the SLA lapses (`complaintToTheBoard.js:56`).
- **Config is centralised**, and `catalog.js:5` explicitly warns against hardcoding a real
  org's details.
- **The README's "What this is not" section is honest** about the toolkit being a structural
  reference rather than a certified compliance product, and the obligation list at lines
  10-22 is framed as what the project *intends* to codify. Several findings below would be
  overstated as broken promises if that framing were ignored; they are reported as scope
  gaps where that is the honest reading.

---

## 2. Findings

Ranked by severity. Location, evidence, a concrete failure scenario, and a fix for each.

---

## CRITICAL

### C1 - No authentication on any endpoint, and `principalId` is publicly computable

**Location:** `src/utils/principalId.js:13`; every route in `src/http/router.js`;
`data-fiduciary-toolkit/README.md:66-67`; `src/services/persistPIIwithconsent.js:39-47`

**Evidence:**
```js
return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
```
Unsalted, unkeyed. There is no middleware, no session, no Authorization header, and no email
challenge anywhere in `src/` - grep for `helmet|csrf|session|Authorization|cookie` returns
nothing. The README then instructs integrators: "`principalId` is derived from the email
(SHA-256) - save it client-side, it's what every other endpoint uses to find this person's
records."

**Failure scenario:** An attacker who knows only `asha@example.com` computes the principalId
offline with `printf asha@example.com | shasum -a 256`. No server interaction, no guessing.
Then, with no credential:

1. `PUT /consent/withdraw` - appends forged `withdrawn` events to the victim's append-only
   legal ledger. By design nothing can remove them.
2. `POST /consent` with the victim's email and attacker-supplied PII - takes the
   existing-record branch at `persistPIIwithconsent.js:41` and **overwrites the victim's
   stored name, phone, PAN and address**, then appends a fresh `granted` event. An
   unauthenticated third party can forge the consent evidence the fiduciary would later
   produce to the Board as its lawful basis for processing. Note this path does not even
   need the derived hash - the raw email alone is the input.
3. `POST /rights/exercise` with `right: "erasure"` - files an account-deletion demand in the
   victim's name.
4. `POST /grievance` - files a complaint attributed to the victim, containing arbitrary text.

For social and public sector organisations - the audience named in the root README - email
addresses are frequently formulaic (`firstname.lastname@dept.gov.in`), so this is
bulk-enumerable rather than merely targetable.

**Fix:** Treat `principalId` strictly as a correlation key, never as proof of identity.
Require an authenticated session or a one-time emailed token on every write route, and derive
`principalId` server-side from the authenticated identity rather than accepting it from
`req.body`. Remove the README guidance that frames it as a client-held key. Switching to
HMAC-SHA256 with a server secret fixes reversibility but is a separate concern and is not
authentication.

---

### C2 - NoSQL operator injection in `withdrawConsent`

**Location:** `src/services/withdrawConsent.js:18-22, 38-45`; `src/http/router.js:12-13, 28`

**Evidence:** `principalId` is destructured from `req.body` and passed unchecked into a query
filter:
```js
if (!principalId) throw new Error("principalId is required");
const record = await ConsentRecord.findOne({ principalId });
```
The only guard is a truthiness check, which any non-empty object passes. Verified directly
against mongoose 8:

| Input on a `String` path | Filter mongoose actually sends |
| --- | --- |
| `"abc123"` | `{"principalId":"abc123"}` |
| `{$ne: null}` | `{"principalId":{"$ne":null}}` |
| `{$gt: ""}` | `{"principalId":{"$gt":""}}` |
| `{$regex: ".*"}` | `{"principalId":{"$regex":".*"}}` |
| `{$in: ["a","b"]}` | `{"principalId":{"$in":["a","b"]}}` |

Schema casting does **not** strip query operators. Also verified: `!({$gt:""})` is `false`,
so the guard passes; and `express.urlencoded({extended:true})` at `router.js:13` builds the
identical object from a plain form field named `principalId[$ne]`, so the payload is
deliverable by a cross-origin HTML form, not only by a JSON client.

**Failure scenario:**
```
curl -XPUT http://host/consent/withdraw -H 'Content-Type: application/json' \
  -d '{"principalId":{"$gt":""},"consentTypes":["marketing","analytics"]}'
```
The filter reaches MongoDB as `{principalId:{$gt:""}}`, matches every `ConsentRecord`, and
`findOne` returns the first one - a real, unrelated data principal whose email the attacker
has never seen. Line 38 appends `withdrawn` events to that victim's ledger, line 43 saves,
and line 45 returns their `docRef`. Repeating with `$regex` prefixes (`^0`, `^1`, ...) walks
the collection and revokes consent across the entire user base, each revocation permanently
written into the audit trail the fiduciary must produce.

**Scope:** This is ledger tampering and record enumeration, not data disclosure - no PII is
returned. It is confined to `withdrawConsent`, the only place a caller-supplied value reaches
a query *filter*. The other services pass `principalId` to `Model.create()`, which was
verified to reject an operator object with a CastError, and `escalateToBoard`'s `refId` comes
from `req.params` so it is always a string.

**Fix:** Validate shape before the value reaches the query:
```js
if (typeof principalId !== "string" || !/^[a-f0-9]{64}$/.test(principalId)) {
  throw new Error("invalid principalId");
}
```
Add `mongoose.set("sanitizeFilter", true)` in `src/db/connection.js` as defence in depth.

---

### C3 - `POST /consent` unconditionally rewrites every purpose, in both directions

**Location:** `src/services/persistPIIwithconsent.js:32-37, 41-47`

**Evidence:** For a returning principal the function appends an event for *every* catalog
purpose, with no reference to current state:
```js
status: entry.required || consentTypes.includes(entry.type) ? "granted" : "withdrawn"
...
record.events.push(...events);
```

**Failure scenario:** Two symmetrical failures from one line.

- **A withdrawal is silently reversed.** Principal grants marketing, later withdraws it via
  `PUT /consent/withdraw`, then updates their phone number through a screen that re-posts
  `POST /consent` with the marketing box ticked. A new `granted` event is appended and
  `currentState()` reports marketing as granted again. Consent was resurrected without a
  fresh, deliberate consent act.
- **A live consent is silently withdrawn.** The same profile-update post that omits
  `consentTypes` writes `withdrawn` for every optional purpose the principal still wanted.

There is no way for the caller to avoid this, because there is no endpoint that reports the
current state to pre-populate the form with (see C4).

**Fix:** Make `persistPIIwithconsent` non-destructive with respect to existing state - skip
purposes whose current state already matches, and require an explicit flag to reverse a
withdrawal so the reversal is a separately auditable act.

---

### C4 - The toolkit is write-only: nothing can read the ledger back

**Location:** `src/index.js:11-29`; `src/models/ConsentRecord.js:33-40`; `src/http/router.js`
(all routes); `README.md:16, 126`

**Evidence:** `router.get` appears three times and every one serves a static form or the
static rights catalog. No route and no export reads a `ConsentRecord`, `RightsRequest`,
`Grievance`, or `ConsentManagerRequest`. `currentState()` is defined at `ConsentRecord.js:33`
and documented at `README.md:126`, but `grep -rn currentState src/` matches only its own
definition - **it has zero call sites and is dead code**.

**Failure scenario:** Asha grants marketing consent, withdraws it 40 days later, then files a
Section 11 access request - a right the toolkit advertises to her verbatim at
`catalog.js:61`: "Get a summary of what personal data we hold about you and who we've shared
it with." `exerciseRight` writes a row and returns `{refId, status: "received"}`. There is
then no function in the package that can produce the summary she was promised. The data is
being written correctly and cannot be got out. An auditor asking "show me this principal's
consent history" must be handed raw Mongo access, which defeats obligation 7 ("audit trail of
the consent should be available at any point in time").

**Fix:** Add `GET /consent/:principalId` returning `currentState()` plus the full event
ledger, and read routes for the three request types. This closes obligations 2 and 7, makes
the `refId`s genuinely trackable, and gives C3 the state it needs to be non-destructive.

---

## HIGH

### H1 - Contractual necessity is not a lawful ground under the DPDP Act

**Location:** `src/config/catalog.js:16-18, 30-35`; enforced at `src/services/withdrawConsent.js:34-37`

**Evidence:**
```js
// `required: true` means processing rests on a legal/contractual basis under
// Section 7, not consent, so it CANNOT be withdrawn while the relationship is active.
...
{ type: "underwriting", basis: "Necessary to perform your loan contract", required: true }
```
DPDP does not carry a general contractual-necessity ground the way GDPR Article 6(1)(b) does.
It has consent plus an enumerated set of legitimate uses, and contract performance is not
among them.

**Failure scenario:** A principal calls `PUT /consent/withdraw` for `underwriting`. Line 34
rejects it, so the toolkit blocks a withdrawal the statute guarantees - it becomes the
instrument that denies the right it exists to protect. Two aggravating details: the refusal
is returned with **HTTP 200**, so a client sees a success status for a denied statutory
right; and `record.save()` still runs on the all-rejected path, persisting a write with no
corresponding event.

The `kyc` entry is on much firmer ground, resting on a statutory PMLA obligation rather than
a contract. This is the single highest-consequence item in the file, because it is the one
place the toolkit tells a data principal "no."

**Fix:** Derive `required: true` strictly from the enumerated legitimate uses, citing the
specific sub-clause per purpose rather than a blanket "Section 7". Where a purpose does not
map to one, model it as consent-based and withdrawable, and handle the commercial consequence
(closing the account) separately from the legal basis. Return a non-2xx status for a refusal.

---

### H2 - Withdrawal does not stop or erase anything

**Location:** `src/services/withdrawConsent.js:29-45`; `src/services/dataPrincipalRights.js:22-38`

**Evidence:** `withdrawConsent` appends an event and returns. No erasure, no processor
notification, no emitted event or injectable hook a caller could subscribe to.
`exerciseRight("erasure")` likewise only inserts a row.

**Failure scenario:** A principal withdraws marketing consent and receives
`200 {withdrawn: ["marketing"]}`. Their PII remains in full in `ConsentRecord.pii` and any
downstream processor continues unaware. The fiduciary now holds written proof it was told to
stop, and no mechanism that stopped anything - evidentially worse than not logging it. The
erasure duty operates per withdrawal, not only when every purpose is revoked, so it is
triggered here.

**Fix:** At minimum emit a documented event or invoke an injected
`onWithdrawal({principalId, types})` callback so an adopting org can wire in its erasure and
processor-notification pipeline. Shipping the log without the hook implies a completeness the
toolkit does not have.

---

### H3 - No notice is produced, stored, or returned at consent capture

**Location:** `src/services/persistPIIwithconsent.js:17-64`; `src/http/forms.js:17-77`;
`src/models/ConsentRecord.js:16-30`

**Evidence:** The consent path takes `pii` and `consentTypes` and writes events. There is no
notice text, no notice version, no record of what the principal was shown, and no consent
capture page at all - `forms.js` renders the rights, grievance, and consent-manager pages
only.

**Failure scenario:** The fiduciary bears the burden of proving that valid consent was
obtained, which means proving what notice preceded it. The ledger can show *that* a `granted`
event exists for marketing on a date; it cannot show what the principal was told at that
moment. In a dispute the fiduciary has a self-generated database row and no evidence of
notice. Storing an immutable notice snapshot alongside each consent event is the single
highest-value addition to the data model.

**Fix:** Add a `notice` subdocument to each consent event capturing the notice text or a
versioned notice ID, the language it was served in, and the timestamp.

---

### H4 - No age gate and no parental consent path

**Location:** `src/services/persistPIIwithconsent.js:18-37`; `src/models/ConsentRecord.js:23`;
`src/config/catalog.js:36-47`

**Evidence:** The schema has an optional `dob` field that nothing reads. There is no age
check, no parental consent flow, and no verifiable-parent mechanism.

**Failure scenario:** A 14-year-old submits the consent form. The toolkit accepts the record
and writes `granted` events for marketing and analytics - behavioural advertising and tracking
directed at a child. Nothing in the code path can detect or prevent it. This is the
obligation the project itself lists at item 12, and the penalty tier attached to children's
data breaches is among the highest in the Act.

**Fix:** Require `dob` (or an age band), gate optional purposes behind an adult check, and
add a parental-consent record type. Until that exists, the README should say plainly that the
toolkit must not be used for flows that can reach minors.

---

### H5 - JSON API clients receive HTML with the wrong status code

**Location:** `src/http/router.js:37, 43-46, 57-60, 79-82`; documented at `README.md:83-84, 90, 106, 119`

**Evidence:** `req.accepts("html")` is used as a boolean. Verified against Express 4.19.2:

| Request `Accept` header | `req.accepts("html")` | truthy |
| --- | --- | --- |
| *(none)* | `"html"` | yes |
| `*/*` (curl and fetch default) | `"html"` | yes |
| `application/json` | `false` | no |
| `text/html` | `"html"` | yes |

**Failure scenario:** `curl -X POST /rights/exercise -H 'Content-Type: application/json' -d '{...}'`
sends `Accept: */*`, so the HTML branch is taken and the client receives **200** with
`<p>Request received. Reference: <b>RQ-...</b></p>` instead of the documented
`201 {refId, right, status}`. Same for `POST /grievance` and `POST /consent-manager`.

Precisely: four of the eight routes negotiate - `GET /rights`, `POST /rights/exercise`,
`POST /grievance`, `POST /consent-manager`. `POST /consent` and `PUT /consent/withdraw` always
return JSON and match their documented contracts. The HTML fragments do carry `refId` through
(and `slaDueAt` for grievance); what is lost is the JSON shape, the 201 status, and the
`dpoEmail` and `note` fields.

**Fix:** `if (req.accepts(["json", "html"]) === "html")`. Listing `json` first makes it win
the `*/*` tie-break, so API clients get JSON and browsers still get HTML.

---

### H6 - The browser-facing surface is a closed dead end

**Location:** `src/http/forms.js:17-77` (inputs at `:28-29, :51-52, :68-69`); `src/http/router.js:26, 36, 53, 75`

**Evidence:** All three rendered forms require the principal to type a `principalId` into a
text field whose placeholder reads "Returned when you confirmed your consent". No HTML page
in the toolkit ever produces that value - it is only returned in the JSON response body of
`POST /consent`, and there is no consent capture page. There is also no withdrawal page at
all; withdrawal is an API-only `PUT`.

**Failure scenario:** The root README states the toolkit is "primarily developed for the
social and public sector organizations that deal with a lot of PII data" - an audience whose
data principals are beneficiaries, not API consumers. Such a person opens `/rights`, reads
"Right to erasure", and is blocked on a field demanding a 64-character hex string she was
never shown. Every browser-reachable path in the toolkit terminates the same way. This also
means obligation 4 (withdrawal as easy as granting) cannot be demonstrated: granting has no
page, and withdrawing has no page either.

**Fix:** Add a consent capture page that displays the resulting `principalId` (or better, per
C1, sets an authenticated session), and a withdrawal page with the same prominence as the
consent page.

---

### H7 - Nothing is ever sent to anyone, but the principal is told it was

**Location:** `src/services/complaintToTheBoard.js:37-43` (note text at `:42`), `:60-66`;
`src/http/router.js:54-72`; `package.json:10-14`

**Evidence:** The grievance response tells the principal: "This has been sent to
`${FIDUCIARY.name}`'s Grievance Officer." The package has no mailer, no HTTP client, no queue,
and no webhook - the dependency list is express, mongoose, dotenv. `escalateToBoard` likewise
sets `escalatedToBoard = true` and contacts nobody.

**Failure scenario:** Asha submits the grievance form and receives a page reading "Sent to
Data Protection Officer. Reference: GR-... SLA: 2026-08-14". Nothing was sent - a document was
inserted into Mongo. Per C4 there is also no list-open-grievances function, so the DPO has no
way to discover it either. The 7-day SLA is therefore guaranteed to lapse unmet on every
grievance ever filed. The statement made to the data principal is false as written.

**Fix:** Either wire an outbound notification (injected transport, so the library stays
dependency-light) or change the wording to what actually happened - "recorded" rather than
"sent" - and document that delivery is the integrator's responsibility. The same applies to
the `escalatedToBoard` flag, which records an intention rather than an action.

---

### H8 - The library hijacks the global mongoose singleton

**Location:** `src/db/connection.js:1, 5-11`; `src/models/*.js:1` (all four)

**Evidence:** Models are registered on the global `mongoose` singleton and `connect()` opens
the *default* connection:
```js
const mongoose = require("mongoose");
await mongoose.connect(uri);
```

**Failure scenario:** The integration the README documents at lines 36-42 is "drop this router
into your Express app". A district portal that already runs
`mongoose.connect(process.env.APP_DB)` for its own tables then calls the toolkit's
`connect(process.env.MONGO_URI)`. Because the default connection is already open on a
different string, the host either throws at startup or the toolkit silently writes consent
records into the host's database. Worse, the
`mongoose.models.X || mongoose.model("X", schema)` guard in each model means that if the host
app happens to have registered its own model named `Grievance`, the toolkit silently binds to
the host's schema and writes malformed documents.

**Fix:** Use `mongoose.createConnection(uri)` and register the models on that connection, so
the library owns an isolated connection and its own model registry.

---

### H9 - PII and the consent ledger share one document, making erasure and retention mutually exclusive

**Location:** `src/models/ConsentRecord.js:16-30` (PII `required: true` at `:20-22`, events at `:27`)

**Evidence:** One document holds both the principal's PII (with `name`, `email`, `phone` all
`required: true`) and the append-only `events[]` ledger.

**Failure scenario:** The principal exercises erasure and the operator implements it. The
schema permits only two implementations and both are wrong:

- `deleteOne({principalId})` destroys the consent ledger, which is the fiduciary's own
  evidence that it ever had a lawful basis for the years it processed her data. The operator
  erases its own defence.
- Blanking the PII fields fails schema validation, because `name`, `email` and `phone` are
  `required: true`. The save is rejected and erasure cannot complete.

The data model makes the two DPDP duties - erase on request, retain proof of consent -
structurally incompatible.

**Fix:** Split into two collections: an erasable PII/profile document and a retained,
pseudonymous consent ledger keyed by `principalId`. This is the change that makes C4's read
API and H2's erasure hook implementable at all, so it is worth doing before either.

---

### H10 - Identity is derived from email alone

**Location:** `src/utils/principalId.js:9-14`; `src/services/persistPIIwithconsent.js:18, 27, 39`

**Failure scenario:** Two problems.

1. A principal exercises the right to correct an inaccurate email. The next `POST /consent`
   derives a *different* principalId, matches nothing, and creates a second record. The
   original - holding the entire consent history - is orphaned and unreachable, because
   nothing maps old identity to new. Exercising a right destroys the audit trail for it.
2. `derivePrincipalId` throws unless given a valid email string and
   `persistPIIwithconsent:18` hard-requires `pii.email`. A beneficiary with a phone number and
   no email cannot be represented at all - a substantial share of the population this toolkit
   is aimed at.

**Fix:** Follows from C1 - a stable random `principalId` decoupled from any attribute solves
both, and contact details become mutable data rather than identity.

---

### H11 - Status enums exist that no code can ever advance

**Location:** `src/models/RightsRequest.js:9`; `src/models/Grievance.js:10`;
`src/models/ConsentManagerRequest.js:13`

**Evidence:** Three multi-state enums are declared - `received|in_progress|closed`,
`open|in_progress|resolved|escalated`, `received|connected|closed` - and the only transition
implemented anywhere is `open -> escalated`.

**Failure scenario:** A welfare department runs this for 18 months. Four thousand
beneficiaries file erasure and correction requests, and every `RightsRequest` still reads
`status: "received"` with `updatedAt == createdAt`, because no exported function, route, or
admin surface can move it. `RightsRequest` has no SLA field at all, so nothing is even
measurable. Relatedly, `escalateToBoard`'s guard `if (grievance.status === "resolved")` at
`complaintToTheBoard.js:55` is unreachable dead code.

**Fix:** Add the fiduciary-side transition functions - this is the missing back-office half of
the toolkit - or document the statuses as caller-managed and remove the unreachable guard.

---

### H12 - No `.gitignore`, no `.npmignore`, no `files` allowlist

**Location:** repo root (all absent); `package.json:1-15`; `README.md:32`

**Evidence:** `git ls-files` shows 20 tracked files, none of them ignore files. `package.json`
has no `files` key.

**Failure scenario:** The README instructs every adopter to create a `.env` containing
`MONGO_URI` - a connection string that typically embeds credentials for a database of
plaintext PII. With no `.gitignore`, a routine `git add .` commits it; with no `files`
allowlist or `.npmignore`, `npm publish` packs it into the tarball. `node_modules/` is
equally uncovered.

**Present state:** latent, not live. No `.env` exists in the working tree, git history is
clean of one, and the package has never been published. This is a defect that converts to an
exposure the moment an operator follows the documented setup.

**Fix:** Add `.gitignore` covering `.env`, `.env.*` (excluding `.env.example`),
`node_modules/`, `*.log`; add a `files` allowlist to `package.json`.

---

## MEDIUM

### M1 - Rendered forms POST to absolute paths, so mounting anywhere but `/` breaks them
`src/http/forms.js:26, 50, 67`. The forms hardcode `action="/rights/exercise"`,
`action="/grievance"`, `action="/consent-manager"`. The README's own example uses
`app.use("/", createRouter())`, but any adopter following normal practice with
`app.use("/dpdp", createRouter())` gets forms that render correctly and 404 on submit. **Fix:**
build the action from `req.baseUrl` and pass it into the render functions.

### M2 - `escalateToBoard` signature drift between README and code
`README.md:99` documents `escalateToBoard(refId)` as a positional string; the function
destructures an object (`complaintToTheBoard.js:51`), so the documented call throws. The JSDoc
at `:46-50` documents no `@param` at all, unlike every sibling service, so the README is the
only signature reference a consumer has and the drift is not self-correcting.

### M3 - Derived catalog snapshots diverge from the live catalog
`config/catalog.js:50-51` computes `REQUIRED_CONSENT_TYPES` and `VALID_CONSENT_TYPES` once at
import, while other code reads `CONSENT_CATALOG` live. An adopter following `README.md:137-140`
who appends a purpose at boot finds `POST /consent` rejects it with "Unknown consent type"
(`persistPIIwithconsent.js:22`, reading the stale snapshot) while
`persistPIIwithconsent.js:32` iterates the live catalog and writes a phantom `withdrawn` event
for it on every submission. **Fix:** derive both lists from the catalog at call time, or freeze
the catalog and document it as immutable.

### M4 - `docRef` identifies the principal, not the consent transaction
`ConsentRecord.js:17-18`; `persistPIIwithconsent.js:41-47`. The "consent receipt" is one per
principal and never changes. Asha consents to marketing on 1 Jan and gets `CN-LX2K-A91F`;
updates her address on 30 June without ticking marketing and gets `CN-LX2K-A91F` again, same
number, opposite consent state; withdraws analytics on 2 July and `withdrawConsent` returns
`CN-LX2K-A91F` once more. A receipt number that cannot distinguish between contradictory
transactions is not a receipt. **Fix:** issue a per-transaction reference and keep `docRef` as
the record identifier.

### M5 - Purposes never granted are recorded as `withdrawn`
`persistPIIwithconsent.js:34`; enum at `ConsentRecord.js:9`. A first-time principal who does
not tick analytics gets an `analytics/withdrawn` event dated today, for something they never
granted. The enum has no third state to express "declined at signup", which is a materially
different fact from "granted, then revoked". The ledger is partly self-disambiguating - a
`withdrawn` with no preceding `granted` can only mean never-granted - so the harm is
interpretive rather than immediate. **Fix:** add `denied` to the enum.

### M6 - Every error becomes HTTP 400 with a raw internal message
`router.js:20-22, 30-32, 47-49, 61-63, 69-71, 83-85` - six identical handlers doing
`res.status(400).json({error: err.message})`. A mid-run Mongo outage surfaces as
`MongooseError: Operation \`consentrecords.findOne()\` buffering timed out after 10000ms`
returned as a client error, so caller retry logic concludes its own payload was malformed. A
duplicate-key error leaks the collection name, index name, and colliding value. **Fix:**
distinguish validation from infrastructure errors and map unknown errors to 500 with a generic
body.

### M7 - find-then-create race and unhandled `docRef` collision
`persistPIIwithconsent.js:39-57`; `generateDocRef` at `principalId.js:16-20`. Three random
bytes is 24 bits scoped to one millisecond, and there is no upsert, no retry, and no E11000
handling. A double-submit or a collision surfaces to the principal as a 400 with raw Mongo
internals instead of their reference. **Fix:** `findOneAndUpdate` with `upsert: true`; widen to
`crypto.randomBytes(8)`; catch code 11000 with one retry.

### M8 - `escalateToBoard` accepts any `refId` with no ownership check
`router.js:65-72`; `complaintToTheBoard.js:51-67`. The route passes `req.params.refId` straight
through and never consults the grievance's `principalId`, so anyone holding or guessing a
`GR-...` reference can escalate someone else's grievance. Combined with M7's weak entropy,
guessing is not purely theoretical. **Impact is bounded:** escalation only mutates three fields
on a local document - there is no outbound path to the Board (see H7) - so this is unauthorised
state mutation, not a forged regulator filing. **Fix:** require `principalId` and compare.

### M9 - `withdrawConsent` never checks current state
`withdrawConsent.js:29-45`. Withdrawing an already-withdrawn purpose appends a duplicate event
and moves `effectiveFrom` forward on every replay. An all-rejected request still calls
`record.save()`, moving `updatedAt` for a modification that did not happen, and returns HTTP
200 with `withdrawn: []`. The response does carry the `rejected` array so the information is
not lost - the defect is the misleading 2xx and the spurious write.

### M10 - `connected` flag never reset, differing URI silently ignored
`db/connection.js:3-11`. A second `connect()` with a *different* URI returns the first
connection without warning, which is the H8 failure in miniature. The flag also never clears on
disconnect.

### M11 - Config frozen at require time, DPO placeholder rendered to principals
`config/catalog.js:1, 7-12`, rendered at `forms.js:49`. A library calling `dotenv.config()` as
an import side effect is a design smell, but the load-bearing half is independent of import
order: `FIDUCIARY_DPO_EMAIL` silently defaults to `dpo@example.com` with no validation
anywhere, so a deployment that misses that one variable ships a live grievance page telling
data principals to contact `example.com`. That fails obligation 11 ("DPO contact ... valid at
all times") while appearing to satisfy it. **Fix:** fail fast at startup if the DPO contact is
still the placeholder.

### M12 - License contradiction
Root `LICENSE` is Apache 2.0 (201 lines, header verified); `package.json:6` declares MIT. These
carry different obligations - Apache 2.0 has a patent grant and an attribution requirement MIT
does not. A downstream compliance scan gets a different answer depending on which file it
reads. The package is unpublished at 0.1.0, so nobody is currently mis-attributing, but this is
an adoption blocker for exactly the institutional users this targets.

### M13 - Nested package layout breaks install-from-git
`package.json` sits one directory below the repo root, so `npm install <git-url>` fails
outright and the README's `require("dpdp-fiduciary-toolkit")` cannot resolve for any consumer.
Running `npm install` *inside* `data-fiduciary-toolkit/` works and `npm run example` resolves
`../src/index` fine, so the bundled example path is functional - the breakage is specific to
consuming the package as a dependency. The root README is two lines and never mentions the
nested package.

### M14 - No rate limiting and unbounded free-text fields
`router.js:10-14`. Four unauthenticated write endpoints with no rate limiter, and
`RightsRequest.details` / `Grievance.description` / `ConsentManagerRequest.message` have no
`maxlength`. Storage exhaustion via unbounded strings is the nearer-term risk than request
volume. Rate limiting alone would slow but not prevent ledger poisoning; this is a consequence
of C1 rather than an independent defect.

### M15 - No tests, no lockfile, no CI
`package.json:7-9` has only an `example` script. C3, M5 and H5 are all behavioural defects a
handful of tests would have caught. Highest-value cases, in order:
1. Decline an optional purpose at signup, assert the event is not `withdrawn` (M5).
2. Grant, withdraw, re-post consent, assert the withdrawal survives (C3).
3. POST with `Accept: */*`, assert 201 and a JSON body (H5).
4. `withdrawConsent` with `principalId: {$gt: ""}`, assert it is rejected (C2).
5. Withdraw a `required` purpose, assert it lands in `rejected`.
6. `escalateToBoard` before and after SLA.

---

## LOW

| # | Location | Issue |
| --- | --- | --- |
| L1 | `README.md:4` | Cites the "Digital Personal Data Protection Act, **2025**". The statute is the 2023 Act; the Rules under it were notified in 2025. This is one wrong digit in the README against three *correct* references elsewhere (`package.json:4`, `catalog.js:54`, `forms.js:40`), so the code and the user-facing HTML are right and only the README is wrong. Fix the README; keep `forms.js:40` as the source of truth. The 2025 Rules are never cited anywhere, which is a scope gap. |
| L2 | `catalog.js:11` | A non-numeric `GRIEVANCE_SLA_DAYS` becomes `NaN` at import and every `POST /grievance` then fails with a Mongo cast error on `slaDueAt`. Operator-triggered only, and the 400 body names the field, so it is discoverable. |
| L3 | `complaintToTheBoard.js:55-64` | `escalateToBoard` does not guard against an already-escalated grievance, so a repeat call overwrites the original `escalatedAt`, destroying the first escalation date. |
| L4 | `package.json:10-14` | `express` is a hard dependency rather than a `peerDependency`, so an Express 5 consumer installs and ships a duplicate Express tree. |
| L5 | `catalog.js:73`, rendered at `forms.js:25` | The erasure right is described as covering data "no longer needed for the purposes it was collected for" - a precondition the statute does not impose on the principal's request. A principal reading this may wrongly self-select out of a request they are entitled to make. |
| L6 | `dataPrincipalRights.js:38`; `withdrawConsent.js:45`; `forms.js:38-42` | DPO/contact-person details are required in responses to rights-exercise communications; the rights page and two of the three response paths omit them. `forms.js:49` does render them on the grievance form. |
| L7 | `README.md:10, 22` | Obligation 1's "across all languages" and obligation 13's Significant Data Fiduciary test both misdescribe the Act. The second half of 13 (SDFs appoint a DPO and an independent auditor) is substantively correct. |
| L8 | `complaintToTheBoard.js:55` | The fiduciary can block `escalateToBoard` by marking its own grievance `resolved`. Bounded: this function is not the principal's route to the Board - a direct complaint to the Board is outside this system entirely - so it blocks a local flag, not a statutory remedy. Currently unreachable anyway (H11). |
| L9 | `README.md:32` | `cp .env.example .env` references a file that does not exist. `MONGO_URI` is documented at lines 32 and 46; `FIDUCIARY_NAME` and `PORT` are undocumented entirely. Full inventory below. |
| L10 | `README.md:35-43` | The quickstart mixes CommonJS `require` with top-level `await`; pasting it into a `.js` file is a SyntaxError. `examples/server.js` in the same package shows the working form. |
| L11 | `principalId.js:3-13` | The JSDoc calls the identifier "non-reversible". An unsalted SHA-256 of an email is trivially reversible by dictionary attack over a known user base; the correct term is pseudonymous, and pseudonymous data remains personal data. |
| L12 | `README.md:52-55, 124-126` | The README describes intake as recording "what the principal actually chose" and does not mention that unticked purposes are written as `withdrawn` (M5). |

**Env vars the code actually reads**, for the missing `.env.example`:

| Variable | Read at | Default |
| --- | --- | --- |
| `MONGO_URI` | `db/connection.js:5` | none - throws if unset |
| `FIDUCIARY_NAME` | `config/catalog.js:8` | `Kavach Finance` |
| `FIDUCIARY_DPO_NAME` | `config/catalog.js:9` | `Data Protection Officer` |
| `FIDUCIARY_DPO_EMAIL` | `config/catalog.js:10` | `dpo@example.com` |
| `GRIEVANCE_SLA_DAYS` | `config/catalog.js:11` | `7` |
| `PORT` | `examples/server.js:11` | `4000` |

---

## 3. Obligation coverage

The package README lists 13 obligations at lines 10-22 as intended scope. Mapping each to what
exists in code today. Line 25 frames these as "in the process of creating", so this is a
roadmap rather than a list of broken promises.

| # | Obligation | Status | Where / gap |
| --- | --- | --- | --- |
| 1 | Consent presented clearly, across all languages | **Absent** | No notice generated or stored (H3); no i18n; catalog strings English-only. |
| 2 | Inform principal of data collected, purpose, processing | **Absent** | Catalog holds title and basis, but no notice is rendered or returned and there is no consent capture page (H3, H6). |
| 3 | Inform how to revoke, exercise rights, complain | **Partial** | `GET /rights` and `GET /grievance/new` exist but are unusable end to end (H6). Nothing documents withdrawal to the principal. |
| 4 | Withdrawal as easy as granting | **Absent** | Neither granting nor withdrawing has a usable page (H6). Parity cannot be demonstrated. See also C3. |
| 5 | Tell processors to cease processing on revocation | **Absent** | H2. |
| 6 | Engagement via a Consent Manager | **Partial** | `consentManagerRequest.js` logs the request correctly and is honestly scoped as a handoff - but nothing is ever sent (H7) and the request cannot be read back (C4). |
| 7 | Audit trail available at any point in time | **Absent** | Written correctly, cannot be read back at all. C4. |
| 8 | Technical and organisational measures | **Absent** | No authn (C1), an injection (C2), no encryption at rest, no access control. |
| 9 | Breach notification with SLAs | **Absent** | No model, service, or route. |
| 10 | Erase prior data on revocation, intimate processor | **Absent** | H2, and the schema makes it structurally impossible (H9). |
| 11 | Valid DPO contact at all times | **Partial** | Rendered on the grievance form, but silently defaults to `dpo@example.com` with no validation (M11) and is missing from rights responses (L6). |
| 12 | Parental consent for children's data | **Absent** | H4. |
| 13 | Significant Data Fiduciary duties | **Absent** | Not modelled; README also misstates the test (L7). |

Present or partial: 3 of 13. The three obligations to close first are 5, 7 and 10 - those are
where the current code *looks* complete while doing less than it appears to, which is worse
than an acknowledged gap.

---

## 4. Suggested order of work

1. **C2** - the injection. One regex, one `sanitizeFilter` call. Smallest fix, largest
   immediate risk reduction, and independent of every architectural decision below.
2. **C1** - the identity and authentication model. Everything in the security column depends
   on it, and H10 falls out of the same change.
3. **H9** - split PII from the ledger. Do this before C4 and H2, because both are
   unimplementable against the current schema.
4. **C4, C3** - the read path, then make writes non-destructive using it. C3 cannot be fixed
   properly until something can report current state.
5. **H1, H3** - the legal core: correct the lawful-basis model, and capture notice at consent.
   These are what make the ledger evidentially useful rather than merely tidy.
6. **H5, M6, M1, M2** - the HTTP and documentation contract. Small, self-contained, currently
   breaking documented behaviour.
7. **H7, H11** - stop claiming delivery that does not happen; add the back-office half.
8. **H12, M12, L9** - repo hygiene. Minutes each, and H12/M12 are adoption blockers for the
   institutional users this targets.
9. **H4, H6** - children's data and a usable browser surface, both of which are scope
   additions rather than fixes.

Write the M15 tests alongside steps 2-5 rather than after.

---

## 5. Method

- All 20 tracked files read in full.
- **Verified by execution**, not asserted: Express 4.19.2 content negotiation across four
  Accept-header variants (H5); mongoose 8 query-operator casting on a String path, the
  truthiness of the `!principalId` guard, `express.urlencoded({extended:true})` parsing of
  `principalId[$ne]`, and `Model.create()` rejecting an operator object (C2); `currentState()`
  same-timestamp tie-breaking (found correct, listed under "what is done well").
- Verified by inspection: `LICENSE` type, absent files, env var inventory, and the
  zero-call-sites claim for `currentState()` (`git ls-files`, `grep`).
- Four-lens parallel audit with adversarial refutation and a completeness critic pass.

---

## 6. Audit reconciliation

The four-lens audit produced 46 findings; 44 survived adversarial refutation, 2 were refuted
and are excluded from section 2. The completeness critic then found 8 further findings that
none of the four lenses had raised. What the process changed:

### Findings only the audit caught

| Finding | Why it was missed initially |
| --- | --- |
| **C2** NoSQL operator injection | Requires knowing that mongoose does not strip query operators during schema casting, and that `extended: true` urlencoded parsing makes the payload form-deliverable. Both were verified independently before inclusion. |
| **H7** Nothing is ever sent | Visible only by cross-checking the user-facing string at `complaintToTheBoard.js:42` against the dependency list. |
| **H8** Global mongoose singleton hijack | A library-versus-host interaction, invisible when reading files individually. |
| **H9** PII and ledger in one document | An architectural consequence, not a line-level defect. |
| **H6** Browser surface is a dead end | Requires tracing the `principalId` field back to find that no page can supply it. |
| **M1** Absolute form actions | Only breaks when the router is mounted somewhere other than `/`. |
| **M3** Derived catalog snapshots | Subtle: half the code reads the catalog live, half reads import-time snapshots. |
| **M4** `docRef` is per-principal, not per-transaction | Requires reasoning about what a "receipt" must identify. |
| **M2**, **L2**, **L3**, **L4**, **L5**, **L6**, **L7** | Line-level items across signature drift, env handling, and legal wording. |

### Claims corrected during refutation

| Claim as first written | Correction applied |
| --- | --- |
| Act-year drift is a HIGH-severity inconsistency across the repo | Downgraded to **L1**. The code and the user-facing HTML are correct; only `README.md:4` is wrong. |
| Escalation "pushes a fabricated complaint to the regulator" | Overstated. `escalateToBoard` mutates three local fields; there is no outbound path anywhere in the package. Reframed as unauthorised state mutation (**M8**). |
| Never-granted-as-`withdrawn` triggers spurious erasure jobs | The downstream consumer does not exist in this repo, and the ledger is partly self-disambiguating. Downgraded to **M5**. |
| `POST /grievance` loses `refId` and `slaDueAt` in the HTML branch | Wrong - both are interpolated into the HTML. Only `dpoEmail` and `note` are dropped (**H5**). |
| "Four of the five documented HTTP contracts are wrong" | Loose arithmetic. Four of eight routes negotiate; `POST /consent` and `PUT /consent/withdraw` always return JSON and match their docs. |
| `currentState()` tie-breaking is fragile | Executed and found **correct** for a push-only ledger. Moved to "what is done well". |
| Setting env before `require` fails to override the catalog defaults | Wrong - it works; dotenv does not override already-set vars. The real defect is the unvalidated placeholder (**M11**). |
| `connect()` after `disconnect()` produces a buffering timeout | Wrong symptom - mongoose does not restore `Collection.buffer` on close. |
| The `.env` credential leak is live | Latent. No `.env` exists, git history is clean, package is unpublished (**H12**). |
| Erasure duty is never triggered by any input | Wrong - the duty operates per withdrawal, not only on full revocation (**H2**). |

### Refuted and excluded

- **Unescaped HTML template literals.** Every interpolation was traced: `forms.js` reads the
  static catalog and `FIDUCIARY` config; `router.js:44, 58, 80` interpolate server-generated
  `refId`, `addressedTo` and a `Date`. No request-supplied value reaches any template on any
  path, so there is no XSS. The "a future field would be injectable" argument does not
  establish a present defect and was dropped rather than kept as a caveat.
- **Missing CSRF protection.** CSRF requires an ambient credential the browser attaches
  automatically. Grep confirms no cookie, no `Set-Cookie`, no session middleware, and no
  credential of any kind is issued or checked. With no ambient authority, a cross-site POST
  confers nothing an attacker cannot already do with curl. This becomes a real finding the
  moment C1 is fixed with cookie-based sessions - worth noting in that work, not worth
  reporting now.
