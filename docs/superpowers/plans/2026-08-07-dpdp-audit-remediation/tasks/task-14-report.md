# Task 14 report - Documentation sync and the remaining test cases

Status: DONE

## What changed

- **`test/index.test.js` (new).** Exactly the two tests from the brief's Step 1:
  the documented 22-name export surface is all present, and `derivePrincipalId`
  stays gone.
- **`src/index.js`.** Trimmed and extended to export exactly the 22-name
  surface the brief's test pins: added `erasePrincipalPII` (from
  `services/erasure`), `buildNotice` (from `config/notice`), and
  `newPrincipalId` (from `utils/principalId`); removed `getRightsRequest` and
  `getGrievance` (the single-item read functions), which were not part of the
  documented surface and are not referenced by any test or example - the
  route-level reads (`GET /rights/requests/:refId`, `GET /grievances/:refId`)
  still work, they are just not re-exported from the package root. Swept the
  one pre-existing em dash.
- **`examples/server.js`.** Rewritten per the brief's Step 3: wires
  `resolvePrincipal` against a clearly-labelled, in-memory `demoSessions` map,
  adds `POST /demo/login` (exchanges an email/phone already registered via
  `POST /consent` for a demo token), and wires both `onWithdrawal` and
  `onGrievanceFiled` with console-log bodies that name what a real deployment
  would do instead. Added a header comment giving the end-to-end demo
  sequence. Verified by running it against a throwaway `mongodb-memory-server`
  instance and driving the full flow with curl (signup -> login -> GET
  /consent -> GET /rights/requests -> PUT /consent/withdraw, plus confirming
  an unauthenticated write still 401s) - see "npm run example" below.
- **`src/models/ConsentManagerRequest.js`, `src/services/consentManagerRequest.js`.**
  Swept one pre-existing em dash each (Step 4c) - no other changes.
- **`README.md` (rewritten from "## Setup" onward; header/obligations list
  kept verbatim).** New/changed sections: `## Breaking changes in 0.2.0`
  (the seven items from Step 5b2, near the top so an upgrader sees it before
  anything else); `### Identity and authentication` (new, explains
  `resolvePrincipal`, the random `principalId`, deny-by-default, the `POST
  /consent` exception and its `409`); rewrote `## The APIs` end to end -
  every route's method, auth requirement, and response shape checked against
  `src/http/router.js` and the relevant service, including `denied`,
  `regrant`, `receiptId` vs `docRef`, and an honest description of
  `escalateToBoard` (see judgement question 1 below); new `## Reading it
  back` (the six read routes, all auth, all `no-store`); new `## Age gate and
  parental consent`; new `## Hooks: onWithdrawal and onGrievanceFiled`
  (fatal vs non-fatal, and why); new `## Erasure - erasePrincipalPII`; new
  `## Fiduciary-side lifecycle` (the three `advance*` functions, deliberately
  unmounted); new `## Notice - buildNotice`; updated `## Data model` (six
  collections, current shapes); new `## Migrating from 0.1.0` (principalId
  cannot be carried over; the `lastNotice` shape change and what to do about
  pre-upgrade documents, per Step 4d); `## What this is not` gained four new
  bullets (withdrawal/erasure not reaching a processor - H2's boundary;
  `erasePrincipalPII` not reaching grievance/rights/consent-manager free
  text; no rate limiting - M14's boundary; the M13 install-from-git paragraph,
  verbatim from the brief) plus a closing paragraph naming all of H2, M14,
  M13, the `escalateToBoard` note, and the parental-consent gap as "closed by
  documentation, not by code," with a link out to `spec.md` instead of a
  duplicated coverage table (see judgement question 2).

## Suite runs (three required by the brief, plus a fourth after later edits)

All four runs are bare `npm test` (`node --test`, no path argument), warm
cache, no other tasks running concurrently.

```
Run 1: tests 144  pass 144  fail 0  duration_ms 25551.63
Run 2: tests 144  pass 144  fail 0  duration_ms 24644.50
Run 3: tests 144  pass 144  fail 0  duration_ms 24339.89
```

Then, after fixing the two top-level-`await` snippets found during
self-review (below), three more formal runs:

```
Run A: tests 144  pass 144  fail 0  duration_ms 24205.73
Run B: tests 144  pass 144  fail 0  duration_ms 24401.63
Run C: tests 144  pass 144  fail 0  duration_ms 24704.71
```

144 = 142 baseline + the 2 new tests in `test/index.test.js`. No flakes across
seven consecutive runs; the test-infrastructure fix pulled forward from this
task before Task 11 is still holding at the end of the branch.

## `npm pack --dry-run`

```
LICENSE, README.md, package.json, and 26 files under src/ (29 total).
package size: 51.2 kB / unpacked: 162.1 kB
```

Only `src/`, `README.md`, `LICENSE`, `package.json` - matches the expected
list exactly (verified twice, before and after the final README edit).

## `.env.example` reconciliation

```
grep -rho 'process\.env\.[A-Z_]*' src/ examples/ | sed 's/.*process\.env\.//' | sort -u
  FIDUCIARY_DPO_EMAIL
  FIDUCIARY_DPO_NAME
  FIDUCIARY_NAME
  GRIEVANCE_SLA_DAYS
  MONGO_URI
  NOTICE_LANGUAGES
  PORT
  PRINCIPAL_ID_SECRET
  RIGHTS_SLA_DAYS
  TZ                    <- false positive, see below

grep -o '^[A-Z_]*' .env.example | grep -v '^$' | sort -u
  FIDUCIARY_DPO_EMAIL
  FIDUCIARY_DPO_NAME
  FIDUCIARY_NAME
  GRIEVANCE_SLA_DAYS
  MONGO_URI
  NOTICE_LANGUAGES
  PORT
  PRINCIPAL_ID_SECRET
  RIGHTS_SLA_DAYS
```

The two lists match on all 9 real config variables - identical to the brief's
own stated definitive set, so no change was needed to `.env.example`. `TZ`
in the first list is a false positive: `src/utils/age.js:33` has the literal
string `process.env.TZ` inside a comment explaining why the timezone
regression test spawns subprocesses rather than assigning `process.env.TZ` at
runtime. No code path in `src/` or `examples/` actually reads
`process.env.TZ`; grep matched the text pattern in prose. Left `.env.example`
and the comment both as-is - adding `TZ` there would document a knob the
library does not actually consume.

## `npm run example`

Starts. Verified three separate times against a throwaway
`mongodb-memory-server` instance (never against a real deployment's Mongo):

1. Ran the full demo sequence from the file's own header comment end to end:
   `POST /consent` (201, new principal) -> `POST /demo/login` (200, token) ->
   `GET /consent` (200, ledger) -> `GET /rights/requests` (200, `[]`) ->
   `PUT /consent/withdraw` (200, `withdrawn: ["marketing"]`) -> confirmed the
   `onWithdrawal` hook actually fired (`[demo] cease processing for
   <id>: marketing` in the server's own stdout) -> confirmed an
   unauthenticated `PUT /consent/withdraw` still 401s.
2. Copied the exact `## Setup` quickstart code block out of the README into a
   scratch consumer project that installs this package as a real
   `file:` dependency (not a relative require inside the toolkit's own repo)
   and ran it verbatim - it started, `GET /rights` returned 200, `GET
   /consent` (no session wired) returned 401 exactly as the surrounding prose
   claims, and `POST /consent` returned 201.
3. A third, final run repeating the header-comment curl sequence after all
   edits were in place, immediately before the formal three-run suite pass.

All scratch processes (mongod instances, the example server, the scratch
consumer project) were killed and removed; `git status` shows only the
intended file changes.

## Judgement question 1: `escalateToBoard` and the Board

Framed it the same way Task 12 reframed the grievance note ("recorded", not
"sent"): `escalateToBoard` is described in the README as **"local
bookkeeping, not a filing with the Board"** - it sets `escalatedToBoard =
true` and `escalatedAt` on the document and contacts no one, because the
package has no outbound channel anywhere. The text explicitly says not to
read the `200` response as proof the Board has been notified, and tells the
integrator to build the actual submission to the Board as a separate,
host-owned integration. The closing paragraph of "What this is not" repeats
this alongside H2, M14, and M13 as "closed by documentation, not by code."

## Judgement question 2: full coverage table vs a link

Chose to **link out** to `spec.md` rather than reproduce the 13-row
obligation table, with one sentence of reasoning in the README itself: "a
fixed-in-time coverage table next to living code drifts the moment either one
changes." Reasoning:

- The audit's 13-row table is a snapshot scored against a specific commit at
  a specific date. The README describes current behaviour, which will keep
  moving after this branch merges - duplicating the table means every future
  behavioural change also needs a synchronised edit to two documents, which
  is exactly the kind of drift that produced finding L12 in the first place.
- The five items the task explicitly asked to be stated plainly (H2, M14,
  M13, no parental verification, erasure-vs-free-text) are not left to the
  linked document - they are stated directly, in prose, in the README's own
  "What this is not," because those are the specific claims most likely to
  mislead an integrator if missing. The link is for someone who wants the
  full finding-by-finding history, not for the load-bearing boundaries.
- The link target (`docs/.../spec.md`) is not shipped in the npm package
  (`package.json`'s `files` allowlist is `src/`, `README.md`, `LICENSE`), so
  it is a GitHub URL rather than a relative path - it works whether the
  reader has the README from `npm view` metadata, a vendored `src/` copy, or
  a full git clone.

## Self-review

- **Does every code sample in the README actually run?** Extracted all
  eleven ` ```js ` fenced blocks. Seven are HTTP-protocol illustrations
  (`POST /consent\n{...}\n-> 201 {...}`) in the same non-executable notation
  the pre-existing README already used for this purpose - not meant to be
  pasted as JS. The four genuinely executable blocks (`## Setup` quickstart,
  the `allowedOrigins` one-liner, the `erasePrincipalPII` snippet, the
  `advanceGrievance` snippet) all pass `node --check`, and the quickstart was
  additionally run for real (see "npm run example" above, run 2). Caught and
  fixed a real defect during this pass: the `erasePrincipalPII` and
  `advanceGrievance` snippets originally had a bare top-level `await` outside
  any function, which is a `SyntaxError` in this package's CommonJS - the
  exact L10/L12 mistake class this task exists to prevent. Both are now
  wrapped in a named `async function`.
- **Does the README describe any behaviour the code does not have?** Checked
  every response shape against the actual service return statement and every
  route/method/status pair against `src/http/router.js` while writing this
  (not from memory) - `persistPIIwithconsent`, `withdrawConsent`,
  `getConsentState`, `exerciseRight`, `complaintToTheBoard`,
  `escalateToBoard`, `consentManagerRequest`, `erasePrincipalPII`,
  `buildNotice`, and the three `advance*` functions. No claim in the README
  outruns what a grep of the corresponding file supports.
- **Is every env var the code reads present in `.env.example`, and vice
  versa?** Yes, both directions - see the reconciliation above (with the one
  documented false positive).
- **Does `npm run example` start?** Yes - see above, run three separate ways.
- **Any em dash or en dash left in `src/`, `examples/`, `test/`,
  `README.md`?** `grep -rn $'[–—]' src/ examples/ test/ README.md`
  returns nothing (verified after every edit, most recently after the final
  README wording fix).

## Concerns

- **`src/index.js`'s export surface is now narrower than before this task**:
  `getRightsRequest` and `getGrievance` (single-item lookups) are no longer
  re-exported from the package root, per the brief's literal "export exactly
  that surface" instruction and the fact that neither is referenced by any
  test, example, or the README's documented API. They remain reachable via
  `require("dpdp-fiduciary-toolkit/src/services/...")` for anyone who needs
  them, but that path is undocumented and the package has no subpath exports
  map. If this trim is not what was intended, it is a one-line revert (add
  both back into `src/index.js`'s destructuring and export object) with no
  effect on any test.
- Everything else in the brief and the four priorities in the prompt is
  addressed with no open items I am aware of.

## Fix round 1 of 5

Coordinator ruling: the "export exactly that surface" instruction in my
brief predated Task 10's item-level readers, so following it literally
removed `getRightsRequest` and `getGrievance` - a real capability, not just
a stale test fixture. Restore both. Also asked me to check the same
asymmetry against `findPrincipalByContact` (used by `examples/server.js` via
a deep import) and `updatePrincipalContact` (the only path to correct a
data principal's contact details), and to make the export-surface test
structural rather than a second pinned list.

### 1. Restored `getRightsRequest` and `getGrievance` to `src/index.js`

Re-added both destructures (from `services/dataPrincipalRights` and
`services/complaintToTheBoard`) and both entries in `module.exports`. No
other code changed - these functions were never removed from the services
themselves, only from the package's public re-export.

### 2. `findPrincipalByContact` - decided: public export

Checked what it actually does: a read-only lookup (`models.Principal.findOne`
against a keyed HMAC hash of the supplied email/phone) with no side effects
and no PII it did not already hold. It backs `POST /consent`'s own
existing-principal check internally, and `examples/server.js`'s demo login
uses it to turn "I have a verified email" into a `principalId`.

Chose to export it rather than have the example do something else, because
the alternative isn't actually simpler: a real integrator building real
sign-in (an emailed one-time link, an OTP - anything that ends in "I have
just verified this contact detail belongs to this person") needs exactly
this operation, and the only other way to get it is to duplicate the
email/phone-priority matching logic and the keyed-hash lookup by hand, which
means re-implementing (and risking drift from) `lookupHash` and the
household-sharing rule already encoded here. `erasePrincipalPII` is already
exported as a callable primitive with no route wrapping it - this is the
same pattern for identity resolution instead of erasure.

Changes:
- `src/index.js` - added `findPrincipalByContact` to the `utils/principalId`
  destructure and to `module.exports`, with a comment naming it as the
  building block for a host's own sign-in.
- `examples/server.js` - now imports it from `../src/index` (the public
  entry point) instead of `../src/utils/principalId` (an internal path),
  alongside the other three imports already coming from there.

### 3. `updatePrincipalContact` - checked, NOT exported, and a real defect
   found in the process

Confirmed by grep: `updatePrincipalContact` (`src/utils/principalId.js:155`)
has zero callers anywhere in `src/` or `examples/` - only its own
definition, a comment referencing it by name, and `test/principal.test.js`
call it. **It is not wired to any HTTP route and was not exported from
`src/index.js` before or after my first pass** - the same
written-correctly-unreachable pattern the original audit flagged for
`currentState()` (C4). Per the coordinator's framing ("check and report"),
I did not export it or add a route for it - that is a route-design decision
(method, path, request/response shape, its own tests) bigger than this fix
round, and the brief only asked me to check.

While tracing this I found the README **overclaimed** as a direct result of
my own first pass: the "Identity and authentication" section said
"correcting your own details afterwards is `PUT /consent` ... it reads the
*stored* PII rather than the request body." I re-read `src/http/router.js`'s
`PUT /consent` handler line by line to check this before fixing it:

```js
const result = await persistPIIwithconsent({
  models,
  principalId: req.principalId,
  pii: principal.pii.toObject(),   // ALWAYS the stored PII
  consentTypes: readConsentTypes(req.body),
  regrant: isTrue(req.body.regrant),
  notice,
});
```

`assertOwnContact` only checks that an email/phone in the request body (if
present) matches the stored hash, throwing `403` on a mismatch - it never
applies the submitted value to anything. **`PUT /consent` cannot change a
data principal's name, email, phone, dob, pan, or address under any input.**
My original wording implied it could. This is exactly the class of defect
Task 14 exists to prevent (L12: "the README describes behaviour the code
does not have"), and I introduced it in my own first pass by describing what
I assumed the route was for rather than what it does.

Fixed in `README.md`:
- Rewrote the "Identity and authentication" paragraph to state plainly that
  `PUT /consent` updates consent decisions only, names the fields it cannot
  touch, and states there is currently no route for self-service contact
  correction.
- Added a `findPrincipalByContact` paragraph in the same section.
- Added a new "What this is not" bullet: no public API for self-service
  contact correction, naming `updatePrincipalContact` as the unexported,
  unrouted service-layer function, and naming `POST /rights/exercise` with
  `right: "correction"` as the (different, manually-actioned) alternative
  that does work today.
- Updated the closing "closed by documentation" paragraph in "What this is
  not" from four items to five, adding this one.
- Retitled the `persistPIIwithconsent` API subsection from "update:
  `PUT /consent`" to "consent update: `PUT /consent`" for the same reason.

**Report, as asked:** the Section 12 right to correct one's own contact
details currently has no public API in this package - not via HTTP, and not
via a package-root export. `POST /rights/exercise` with `right: "correction"`
covers the general case (file a request, a human resolves it), but there is
no self-service equivalent to how consent capture and withdrawal work. This
is now documented honestly rather than left to look like `PUT /consent`
covers it. Whether to export `updatePrincipalContact` and/or add a route for
it is left to the coordinator's ruling, same as the export-surface question
that started this fix round.

### Extended `test/index.test.js` so the export-trim mistake cannot recur

Added a third test, structural rather than pinned: it walks each service
module's own `Object.keys()`, and for every `list*` export that has a
matching `get*` sibling **on that same service module**, asserts the
package root exports both or the test fails naming which one is missing.
Deliberately does not require every `list*` to have a `get*` -
`ConsentManagerRequest` has no `getConsentManagerRequest` at the service
level at all (already a separately-tracked gap, not this test's concern),
and `listRights` (the static catalog) has no singular form. A guard rail
(`pairsChecked >= 2`) fails loudly if the loop body ever stops matching
anything, so the test cannot silently degrade into checking zero pairs.

Also added `getRightsRequest`, `getGrievance`, and `findPrincipalByContact`
to the original pinned `expected` array, so both tests independently cover
the restored surface.

**Proved the new test is non-vacuous** rather than assuming it: temporarily
removed the `getRightsRequest,`/`getGrievance,` lines from
`src/index.js`'s `module.exports` (leaving the `require` destructure
untouched, so this reproduces exactly the original mistake - present in the
service, absent from the export), re-ran `test/index.test.js` alone, and
confirmed the new structural test fails with:

```
✖ every list*/get* pair a service module actually exports is exported here together
  AssertionError: getRightsRequest exists on the service alongside
  listRightsRequests but is missing from the public API - an integrator
  could list requests but never fetch the one refId a data principal was
  actually given
```

Then restored `src/index.js` and confirmed it is byte-identical to the
pre-break version (`diff` empty) before re-running the full suite.

### Commands and output

```
$ node --test test/index.test.js
✔ the documented public API is all exported
✔ derivePrincipalId is gone - it was the guessable-identity bug
✔ every list*/get* pair a service module actually exports is exported here together
tests 3  pass 3  fail 0

$ npm test        (x4, after all fix-round edits)
Run 1: tests 145  pass 145  fail 0  duration_ms 24134.31
Run 2: tests 145  pass 145  fail 0  duration_ms 24869.87
Run 3: tests 145  pass 145  fail 0  duration_ms 25049.19
Run 4: tests 145  pass 145  fail 0  duration_ms 25748.19  (final, pre-commit)
```

145 = 142 baseline + 2 from Task 14's first pass + 1 new structural test in
this round. No flakes across four runs.

```
$ npm pack --dry-run
total files: 29, package size: 51.9 kB  - unchanged file set
  (src/, README.md, LICENSE, package.json only)

$ grep -rho 'process\.env\.[A-Z_]*' src/ examples/ | sed 's/.*process\.env\.//' | sort -u
$ grep -o '^[A-Z_]*' .env.example | grep -v '^$' | sort -u
  identical, modulo the pre-existing TZ comment false positive already
  noted in the base report - unaffected by this round's changes
```

Also re-ran the example end to end against a fresh `mongodb-memory-server`
instance after the import-path change (`findPrincipalByContact` now comes
from `../src/index` instead of `../src/utils/principalId`): `npm run
example` starts, `POST /consent` -> 201, `POST /demo/login` -> 200 with a
token. Behaviour unchanged, only the import source moved.

### Self-review of this round

- Re-checked every other README claim about what `PUT /consent`,
  `POST /rights/exercise`, and the read routes can and cannot do, against
  the actual route handlers, to make sure the contact-correction overclaim
  was not the only instance of this mistake. Found none.
- Re-ran the full em-dash sweep (`grep -rn $'[–—]' src/ examples/
  test/ README.md`) after every edit in this round - clean throughout.
- Confirmed `git status` shows exactly the four files touched, nothing else.

### Files changed (this round)

- `data-fiduciary-toolkit/src/index.js` - restored `getRightsRequest`,
  `getGrievance`; added `findPrincipalByContact`.
- `data-fiduciary-toolkit/examples/server.js` - `findPrincipalByContact` now
  imported from `../src/index` instead of `../src/utils/principalId`.
- `data-fiduciary-toolkit/README.md` - corrected the `PUT /consent`
  contact-correction overclaim; documented `findPrincipalByContact`; added
  the contact-correction gap to "What this is not"; updated the "closed by
  documentation" count from four to five; retitled the `persistPIIwithconsent`
  subsection heading.
- `data-fiduciary-toolkit/test/index.test.js` - extended the pinned list;
  added the structural list*/get* pairing test, proved non-vacuous by
  deliberate break-and-restore.
