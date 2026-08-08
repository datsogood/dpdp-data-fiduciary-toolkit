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
