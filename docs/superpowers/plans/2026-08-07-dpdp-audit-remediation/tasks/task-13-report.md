# Task 13 report: A usable browser surface

**Closes:** H6

## What I implemented

### `src/http/forms.js`

- Added three renderers:
  - `renderConsentPage({ basePath, notice })` - renders the itemised Section 5 notice built by `buildNotice`. Splits `notice.purposes` on `lawfulBasis.kind`: purposes with `kind === "consent"` become a checkbox (`name="consentTypes" value="<type>"`); purposes with `kind === "legitimate_use"` are rendered as a stated card (title, clause, purpose text, and the lawful-basis description) with no checkbox at all. Collects `name`, `email`, `phone`, `dob` (matching `readPii`'s flat-field shape) and posts a hidden `consentSubmitted=1` alongside the checkboxes.
  - `renderConsentReceipt({ basePath, result })` - shows `result.principalId` and `result.receiptId` in read-only text inputs, plus links to `/rights` and `/consent/withdraw`. This is the only page in the toolkit that ever shows a browser user their `principalId`.
  - `renderWithdrawalPage({ basePath, state })` - takes the `state` map from `getConsentState` (`{ [type]: latestEvent }`), filters to purposes currently `"granted"` and marked `withdrawable` in the catalog (via the newly imported `getCatalogEntry`), and renders one checkbox per surviving purpose plus a hidden `consentSubmitted=1`. A non-withdrawable purpose (`kyc_reporting`) is excluded regardless of its status, the same restriction `renderConsentPage` applies on the way in.
- Removed the `principalId` text input and its `<label>Principal ID</label>` from `renderRightsPage`, `renderGrievanceForm`, and `renderConsentManagerForm`. Nothing else in those three functions changed.
- Every interpolated value in the new renderers goes through the existing `escapeHtml`. All values interpolated are catalog/notice data (operator-supplied) or service-generated identifiers (`principalId`, `receiptId`) - no raw end-user-typed value is ever echoed back into these templates.

### `src/http/router.js`

- `GET /consent/new` (public, no `requireAuth`): builds the notice via `buildNotice({ language: req.query.lang || DEFAULT_NOTICE_LANGUAGE })` (same pattern already used by `POST /consent` and `PUT /consent`) and renders `renderConsentPage`.
- `POST /consent`: unchanged signup logic; added a `wantsHtml(req)` branch that renders `renderConsentReceipt` with status 201 instead of the JSON body. JSON clients (the default, per `wantsHtml`'s json-first tie-break) are unaffected.
- `GET /consent/withdraw` (`requireAuth`, `noStore`): calls `getConsentState({ models, principalId: req.principalId })`, passes `state` to `renderWithdrawalPage`. Given the `noStore` treatment already used on `GET /consent`, since it reveals which purposes are currently granted.
- `POST /consent/withdraw` already existed (added by an earlier task, confirmed at `router.js:361`, sharing the same handler as `PUT /consent/withdraw`) - no change needed there, matching the brief's "verify, don't re-add" instruction.
- One addition beyond the brief's explicit file list, made in answer to the judgement question below: the shared error mapper (registered last) now renders a client-facing `AppError` (status < 500) or Mongoose `ValidationError`/`CastError` as a plain `<p>` when `wantsHtml(req)` is true, instead of always returning JSON. This reuses the mapper's own existing reasoning ("the message is written for the caller") - it changes only the *representation*, not which errors are safe to echo, and touches nothing above 500 (those still never leak detail to any client).

### `test/browser.test.js` (new)

Implemented exactly as specified in the brief's Step 1 code block (4 tests) plus Step 4b's two additional submit-and-verify tests (6 tests total):

1. `the consent page states the notice and offers a checkbox per optional purpose`
2. `a browser user is shown their principalId after consenting - the forms are unusable without it`
3. `a withdrawal page exists, with the same prominence as consenting`
4. `rendered forms no longer demand a principalId the page cannot supply`
5. `the rendered withdrawal form can actually be submitted` (submits the form, then reads `models.ConsentRecord.findOne({ principalId }).currentState()` directly - not markup-only)
6. `a single ticked checkbox is accepted, not rejected as a non-array`

Note: the brief's Step 5 says "Expected: `test/browser.test.js` 4/4 PASS", which appears to be a stale count left over from before Step 4b appended two more tests to the same file. I implemented all six tests the brief actually specifies (Step 1 + Step 4b) rather than only the four counted in Step 5's expectation text, since Step 4b explicitly instructs "Add two tests that submit" to the same file.

## TDD evidence

**Step 2 - confirmed the test failed first**, before any implementation:
```
✖ the consent page states the notice and offers a checkbox per optional purpose
  404 !== 200
✖ a withdrawal page exists, with the same prominence as consenting
  404 !== 200
✖ rendered forms no longer demand a principalId the page cannot supply
  AssertionError: /rights: identity comes from the session, not from a field the user cannot fill
  (actual html included <input name="principalId" ... required />)
```
(The other two tests in the initial run also failed for the same underlying reasons - no `/consent/new` route, no receipt page, no `/consent/withdraw` route.)

**After implementation**, `node --test test/browser.test.js`:
```
✔ the consent page states the notice and offers a checkbox per optional purpose (545.8ms)
✔ a browser user is shown their principalId after consenting - the forms are unusable without it (451.0ms)
✔ a withdrawal page exists, with the same prominence as consenting (263.3ms)
✔ rendered forms no longer demand a principalId the page cannot supply (269.5ms)
✔ the rendered withdrawal form can actually be submitted (269.7ms)
✔ a single ticked checkbox is accepted, not rejected as a non-array (262.2ms)
tests 6, pass 6, fail 0
```

## Full-suite result

```
npm test
...
ℹ tests 140
ℹ suites 0
ℹ pass 140
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms ~24000-29000 (two runs: 24.0s and 29.1s wall clock; variance is MongoMemoryServer startup jitter, not a regression - re-ran once to confirm)
```
134 baseline + 6 new = 140. All pass, 0 failures, both before and after the commit.

## End-to-end browser walkthrough performed

I wrote and ran a standalone Node script (plain `fetch`, no test framework) that plays the part of a browser: it never reads `principalId` from anywhere except what a page rendered, and simulates the host's session with a single in-memory variable set only after reading the receipt page (matching how a real host would wire up its own cookie session against `resolvePrincipal`).

```
=== GET /consent/new (no session, nothing known about the visitor) ===
status: 200
has marketing checkbox: true
has analytics checkbox: true
kyc_reporting NOT a checkbox: true
PMLA basis stated: true
no principalId field anywhere: true

=== POST /consent (submitting the rendered form) ===
status: 201
principalId shown on receipt: d5b68e2d98f72ad00f7ee66f0c0492cc5c99105135f95c9f7276616b7067795e

=== GET /rights (now signed in) ===
status: 200
no principalId field: true

=== GET /consent/withdraw ===
status: 200
marketing offered: true
kyc_reporting NOT offered: true
form posts, not puts: true

=== POST /consent/withdraw (submitting the rendered form) ===
status: 200

=== Verifying the ledger directly ===
marketing status: withdrawn

=== GET /consent/withdraw again (after withdrawing) ===
marketing no longer offered: true

=== Mount-relative check: router mounted at /compliance/dpdp ===
form action is sub-path relative: true

=== POST /consent for a minor, no parental consent (age-gate 422) ===
status: 422
content-type: text/html; charset=utf-8
body: <p>Verifiable parental consent is required before processing a child&#39;s personal data</p>

Walkthrough complete.
```

I also ran a separate targeted check for the all-unchecked-form trap (not asserted by the brief's own tests, but explicitly called out as load-bearing): submitting the consent form with `consentSubmitted=1` and no `consentTypes` field at all (exactly what a browser sends when every box is left unticked) recorded every consent-based purpose as `"denied"` - a real decision, not silence:
```
status: 201
marketing: denied
analytics: denied
underwriting: denied
identity_verification: denied
```

So: yes, a person with only a browser can go from nothing, to consenting, to seeing their rights, to withdrawing, entirely through rendered forms and real POSTs - no API client, no manually-constructed `principalId`.

## Answers to the two judgement questions

**1. What should a minor see instead of a raw 422?**

I did not build a bespoke "child-facing" flow, and deliberately did not add any wording that could read as an invitation to misstate age (no "are you sure you're old enough?" retry prompt, nothing that treats the DOB field as advisory). Concretely: I changed the shared error mapper so that when `wantsHtml(req)` is true, any client-facing `AppError` (status < 500) is rendered as `<p>{escaped message}</p>` instead of a JSON body. The message shown is the exact same one an API client already receives ("Verifiable parental consent is required before processing a child's personal data") - the router-level comment justifying this already stated "the message is written for the caller," which was already true for JSON callers and simply wasn't true for browser callers before this change.

I chose this over a dedicated "sorry, you're a minor" page for a few reasons: `parentalConsent` is explicitly server-side-only per the brief and this task, so there is nothing a bespoke page could offer the child to *complete* the flow online - any page that tried would either have to expose a `parentalConsent` field (explicitly forbidden) or dead-end anyway, just with nicer copy. A generic, honest, readable sentence explaining *why* is a smaller, more defensible surface than a purpose-built page that implies a path forward the toolkit cannot actually provide. It is a plain HTML paragraph rather than a raw JSON object, which was the actual defect - a JSON blob is unreadable to a browser user of any age, adult or child. This same change also improves every other in-browser AppError (a 409 for repeat signup, a 400 for a malformed field, a 404 for a missing consent record on `/consent/withdraw`), which are the same *class* of problem the brief's own concern was one instance of.

What I did not do: add a "contact us" sentence or DPO email specifically to this message. The error mapper is shared across every route and error type, so hand-tailoring it for one AppError would be scope creep against the "surgical changes" principle; if a future task wants a warmer, fiduciary-specific age-gate page, it should be a deliberate addition, not something I backed into via the generic mapper.

**2. Is showing `principalId` in plain text on the receipt page the right pattern?**

Yes, and I don't think there's a simpler correct alternative given the constraints. `principalId` is a random 64-hex-character identifier (`crypto.randomBytes(32).toString("hex")`, per `src/utils/principalId.js`) - it is a database key, not a derived hash of anything secret, and by design (per the plan's own global constraints) it is never accepted from `req.body`/`req.query` on any route; every mutating and reading route requires `resolvePrincipal(req)` to already know who the caller is via the host's own session. So `principalId` is not actually a bearer credential today - possessing it grants nothing without also controlling the session `resolvePrincipal` would authenticate. Given that, showing it in plain text is showing a reference number (closer to an account number than a password), and the brief's own interface contract requires exactly this ("shows the `principalId` and `receiptId`, which is how a browser user obtains their identifier at all" - there is no other page that could ever hand it out).

What I did do: word the receipt page explicitly as "not a password" and "save this somewhere safe," so a user does not treat it as something to keep as secret as a login credential, without pretending it's meaningless either. What I considered and rejected as unnecessary complexity for this task: a copy-to-clipboard button or downloadable file (adds client-side JS/state for no functional gain over a selectable text field); `Cache-Control: no-store` on the POST response (POST responses aren't cached by default per HTTP semantics, and no test or finding calls for it, so adding it would be an untested assumption about caching behavior I'd be introducing rather than fixing). If a future task wires `resolvePrincipal` to something that treats `principalId` as sufficient on its own (skipping real session auth), that would be the actual vulnerability to fix - not the receipt page.

## Self-review

- **Walkthrough (nothing to consent to withdrawal):** performed and passed end-to-end, see script output above - includes the round trip through a real session variable set only from what the receipt page rendered, never hardcoded.
- **Does withdrawal actually change the ledger, not just markup?** Yes - `test/browser.test.js`'s "the rendered withdrawal form can actually be submitted" test and my manual walkthrough both query `models.ConsentRecord.findOne({ principalId }).currentState()` directly after the POST and assert `status === "withdrawn"` / `status === "granted"` on the specific purposes.
- **Single ticked checkbox:** works (201, confirmed by both the automated test and reasoning about `extended: false` urlencoded parsing plus `readConsentTypes`/`asArray`, unchanged in this task).
- **All-unchecked submission:** confirmed by manual script above to record `"denied"` for every consent-based purpose (a real decision), not silence, because the consent page always sends `consentSubmitted=1` as a hidden field regardless of which boxes are ticked.
- **Escaping:** every interpolated value in the three new renderers passes through `escapeHtml`. No raw user-typed value (name/email/phone/dob as typed into the consent form) is ever echoed back by any of my new templates - only catalog/notice data and service-generated identifiers are interpolated.
- **Mount-relative:** confirmed both by the pre-existing `http.test.js` suite (unchanged, still passing - the three modified forms only lost a field, their `action=` logic is untouched) and by my walkthrough script's sub-path check (`/compliance/dpdp/consent/new` renders `action="/compliance/dpdp/consent"`).
- **Test output pristine:** `node --test test/browser.test.js` output is clean with no unexpected stderr. Full suite (`npm test`) is 140/140, 0 failures, no warnings beyond the pre-existing intentional `console.error` calls from tests that inject failing hooks on purpose (unchanged by this task).
- **Em dash / en dash:** ran `grep -n $'\xe2\x80\x94\|\xe2\x80\x93'` across `src/http/forms.js`, `src/http/router.js`, and `test/browser.test.js` - no matches.

## Concerns

- I extended the shared error mapper beyond the brief's literal file-change list (which named only the three renderers and the two `GET` routes) to answer the minor/422 judgement question with an actual behavior change rather than only a design note. I judged this in scope because the task's own "Before You Begin" section asked for a decision on this exact scenario, not just commentary, and the change is small, generic (not minor-specific), and provably safe against the existing suite (verified every existing test that exercises an AppError-below-500 or a ValidationError/CastError path sends `Accept: application/json` explicitly, so none of them exercise the new `wantsHtml` branch - grepped `test/http.test.js` to confirm). Flagging it in case the reviewer wants it split into its own commit or reverted to a docs-only answer.
- Step 5 of the brief says "Expected: `test/browser.test.js` 4/4 PASS," but the brief's own Step 4b adds two more tests to the same file. I implemented all six (Step 1 + Step 4b) since Step 4b's instruction ("Add two tests that submit") is unambiguous, and reported the actual 6/6 rather than silently dropping two specified tests to match a stale count.

---

## Fix round 1 of 5

Review approved the task - no Critical, no Important findings. It verified all four required properties from the code, confirmed the withdrawal-submission test asserts against the raw ledger rather than markup, confirmed every interpolated value in all three original renderers is escaped, and judged the error-mapper extension "appropriate initiative, not scope creep, and correct" after checking it line by line against the no-leak rule (the `>= 500` branch untouched, both HTML branches escaped, `ValidationError`/`CastError` still ordered first) and independently re-verifying my claim that no existing test hits the new HTML branch. It also traced the all-unchecked-withdrawal trap against `withdrawConsent` and confirmed it is safe (`assertStringArray` turns an absent field into `[]`, and `withdrawConsent` 400s rather than defaulting to withdrawing everything).

Two Minors were raised, both closed in this round.

### 1. The withdrawal form landed a browser user on raw JSON

`POST /consent/withdraw` returned `res.status(200).json(result)` unconditionally, so a data principal who granted consent got a styled receipt and one who withdrew got an unstyled JSON blob - the one step in the task's own end-to-end walkthrough that still dropped out of the browser surface, on the very obligation (H6 finding 4: withdrawal as easy as granting) this task exists to demonstrate.

**Fix:** added `renderWithdrawalReceipt({ basePath, result })` to `src/http/forms.js`, and wired it into the shared `withdraw` handler in `src/http/router.js` (used by both `POST /consent/withdraw` and `PUT /consent/withdraw`) behind the existing `wantsHtml(req)` check, returning status 200 HTML instead of JSON for a browser. It renders three distinct sections built from `withdrawConsent`'s own result shape:

- **Withdrawn** - one `<li>` per type in `result.withdrawn`, using the catalog title (via `getCatalogEntry`), with "This takes effect now."
- **Could not be withdrawn** - one `<li>` per `{ type, reason }` in `result.rejected`, showing the catalog title and `withdrawConsent`'s own reason text verbatim (which already names the clause, e.g. "Section 7(d)") - no new copy invented, just rendered.
- **No change needed** - one `<li>` per type in `result.noChange`, with explicit reassurance ("not an error, there was simply nothing left to do") so a repeat withdrawal of an already-withdrawn purpose does not read as a failure.

Any section with an empty array renders nothing, so a response with only one kind of outcome (e.g. everything withdrawn cleanly) doesn't show two empty headers.

### 2. The consent receipt showed `principalId` without `Cache-Control: no-store`

I had considered this in the original submission and rejected it on the grounds that POST responses aren't cached by default - true, but inconsistent with this task's own established reasoning: `GET /consent` and `GET /consent/withdraw` both get `no-store` specifically because they reveal principal-identifying state, and the receipt page displays the identifier itself in a copyable field.

**Fix:** both receipt responses (`POST /consent`'s HTML branch, and the shared `withdraw` handler's new HTML branch) now set `Cache-Control: no-store` and `Vary: Cookie` before sending, matching the header pair `noStore` middleware already sets on the GET routes. Applied only to the `wantsHtml(req)` branches - the JSON branches are unchanged, matching the fix request's literal scope ("both receipt responses").

### New tests

Added to `test/browser.test.js` (now 8 tests total):

- `the withdrawal receipt states what was withdrawn, what was refused and why, and what needed no change` - a single submission covering all three cases at once: `marketing` (currently granted → withdrawn), `kyc_reporting` (Section 7(d), rejected), `analytics` (withdrawn *before* the form submission, via a direct `withdrawConsent` call, so the page has to render it as "no change needed" rather than "freshly withdrawn"). Asserts on the rendered HTML (section headers, catalog titles, the "Section 7(d)" clause text, the "not an error" reassurance) and independently re-reads `ConsentRecord.findOne({ principalId }).currentState()` to confirm the ledger actually moved to `"withdrawn"` for both `marketing` and `analytics`.
- `both receipt pages carry Cache-Control: no-store - they show or reveal principal-identifying state` - submits the consent form, checks the response header, extracts `principalId` from the rendered receipt, then submits the withdrawal form and checks its response header too.

### Commands and output

```
$ node --test test/browser.test.js
✔ the consent page states the notice and offers a checkbox per optional purpose (763.5ms)
✔ a browser user is shown their principalId after consenting - the forms are unusable without it (426.2ms)
✔ a withdrawal page exists, with the same prominence as consenting (261.2ms)
✔ rendered forms no longer demand a principalId the page cannot supply (272.8ms)
✔ the rendered withdrawal form can actually be submitted (279.8ms)
✔ a single ticked checkbox is accepted, not rejected as a non-array (263.7ms)
✔ the withdrawal receipt states what was withdrawn, what was refused and why, and what needed no change (267.8ms)
✔ both receipt pages carry Cache-Control: no-store - they show or reveal principal-identifying state (258.1ms)
tests 8, pass 8, fail 0
```

```
$ npm test
...
ℹ tests 142
ℹ suites 0
ℹ pass 142
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 25102.5295
```
134 baseline + 8 browser tests (6 original + 2 new this round) = 142. All pass, 0 failures.

### Confirming all three withdrawal-receipt cases render correctly

Verified by the single combined test above, reading the actual response HTML for each case:

- **Something withdrawn** (`marketing`, previously granted): renders under "Withdrawn", names "Marketing and personalised offers", states "This takes effect now." Ledger confirms `state.marketing.status === "withdrawn"` after the call.
- **Something rejected** (`kyc_reporting`, Section 7(d)): renders under "Could not be withdrawn", names "Anti-money-laundering reporting", and shows the reason text in full, including "Section 7(d)".
- **A no-op** (`analytics`, already withdrawn by a direct service call before the form submission): renders under "No change needed", names "Product analytics and improvement", and states plainly it "is not an error" - it does not read as a failure.

### Self-review of this round

- Both fixes are scoped exactly to what was asked - no unrelated renderer or route touched.
- `escapeHtml` is applied to every interpolated value in `renderWithdrawalReceipt`, including `withdrawConsent`'s own `reason` strings (service-authored, not raw user input, but escaped anyway per the existing defensive posture) and the DPO contact block.
- The `>= 500` fallback in the error mapper was left untouched, as instructed.
- Grepped for em dash / en dash across all three changed files - no matches.

### Files changed (this round)

- `data-fiduciary-toolkit/src/http/forms.js` - added `renderWithdrawalReceipt`, exported it.
- `data-fiduciary-toolkit/src/http/router.js` - imported `renderWithdrawalReceipt`; the shared `withdraw` handler now renders it (with `Cache-Control: no-store`) for `wantsHtml(req)`; the `POST /consent` HTML branch now also sets `Cache-Control: no-store`.
- `data-fiduciary-toolkit/test/browser.test.js` - two new tests, plus a top-level `withdrawConsent` require used by the new combined-cases test.
