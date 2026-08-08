# Whole-branch fix round - report

Branch `fix/dpdp-audit-remediation`. Nine cross-task blockers from the whole-branch
review, plus the uncommitted Task 14 work that preceded them.

**Baseline 145 tests. Final 158, all passing, three consecutive runs.**

---

## Suite counts

| Stage | Tests | Pass | Fail |
|---|---|---|---|
| Baseline (before any change) | 145 | 145 | 0 |
| After fix 1 (harness + operator) | 146 | 146 | 0 |
| After fixes 2, 3 | 149 | 149 | 0 |
| After fix 9 | 151 | 151 | 0 |
| After fix 4 | 152 | 152 | 0 |
| After fixes 5, 7 | 156 | 156 | 0 |
| After fixes 6, 8 | 158 | 158 | 0 |
| Final, run 1 / 2 / 3 | 158 / 158 / 158 | 158 / 158 / 158 | 0 / 0 / 0 |

13 tests added. No test was deleted, weakened, or skipped.

---

## Commits

| Commit | Scope |
|---|---|
| `76ada51` | Task 14's uncommitted work - `updatePrincipalContact` export + README section |
| `dd898b5` | The controller's own progress.md note (committed separately, not my work) |
| `a22deba` | Fix 1 - sanitizeFilter operator + test harness through `connect()` |
| `5c938f9` | Fixes 2, 3 - a phone number is not an identity |
| `d89a375` | Fix 9 - registered minor locked out of `PUT /consent` |
| `2395f41` | Fix 4 - erasure leaving the guardian's plaintext name and email |
| `c89f00e` | Fixes 5, 7 - boot gates + `>= 500` content negotiation |
| `ee58e26` | Fixes 6, 8 - the two rendered pages |
| `197e7fd` | README for fixes 2, 3, 4, 5, 7 |

---

## Did the harness change surface anything?

**Yes - exactly one, and it was test-side, not library-side.**

`test/auth.test.js:315` used `models.ConsentRecord.findOne({ principalId: { $ne: phoneOnly } })`
to find "the other principal" in the household test. Under `sanitizeFilter` that
rewrites to `{ $eq: { $ne: ... } }` and CastErrors on a String path, exactly like the
production bug. I found it by grep before the first run and changed it in the same
commit (the housemate's id now comes off the response body), so I never observed a
red run from it. Proven separately with a probe against a `withDb` connection:

```
sanitizeFilter on harness connection: true
RESULT: $ne filter THREW CastError: Cast to string failed for value "{
```

**Nothing in `src/` other than `updatePrincipalContact` relied on the un-sanitized
semantics.** `grep` across `src/` finds exactly one query operator in a filter, and
it was the bug. The other operator occurrences in the suite are all legitimate and
still pass:

- `test/connection.test.js:53` - deliberately *asserts* the CastError.
- `test/connection.test.js:47` - a bare `createConnection` standing in for a host
  application, which must stay bare or the test stops testing what it is named for.
- `test/injection.test.js`, `test/validate.test.js` - operators passed as *values*
  into validators, never into a filter.

So the answer to "was the clash check the only place" is yes for `src/`, and no for
the suite by exactly one line.

---

## Per finding

### 1. `sanitizeFilter` breaks the only deliberate operator query

**Changed.** `src/utils/principalId.js` - the clash filter drops the operator:
`findOne({ emailHash: hash })` then compares `clash.principalId !== principalId` in
JavaScript. `emailHash` is unique, so at most one document can match.
`test/helpers/db.js` now builds its connection with the library's own `connect()`
instead of a bare `mongoose.createConnection`.

**Guarded by.** `test/principal.test.js` - "an email correction runs its clash check
under PRODUCTION query semantics". It asserts `conn.get("sanitizeFilter") === true`
(so the harness change cannot be silently reverted), then that a correction succeeds
*and* that a genuine clash still 409s. Both halves are needed: an implementation that
simply deleted the check would pass the first and fail the second.

**RED evidence.** Restoring the operator fails 4 tests in `test/principal.test.js`,
all with `Error [CastError]: Cast to string failed for value "{`:
correcting an email; the new production-semantics test; the email-theft 409; the
concurrent-correction race.

### 2. Sign-in by phone resolves to another household member

**Changed.** `findPrincipalByContact`'s phone branch is now
`find({ phoneHash }).limit(2)` and throws `409 "That phone number identifies more
than one data principal - it cannot be used on its own to sign in"` when two match.
`examples/server.js`'s demo login takes email only, with the reasoning inline so an
adopter does not copy the pattern; it 400s a phone-only body. README's identity
section states that a phone alone is not an identity.

**Guarded by.** `test/principal.test.js` - "a phone number that identifies more than
one principal is refused for sign-in, not guessed". It first asserts a *single*
principal on a number still resolves, so the test is about ambiguity rather than
about phone being rejected outright.

**RED evidence.** With `findOne` restored the test fails.

### 3. Two phone-only household members cannot both register

**Changed.** `findOrCreatePrincipal`'s filter is `emailHash` only - no email means no
match and always create. The router's pre-write existence check passes `email` only.

**Guarded by.** `test/principal.test.js` - "two people sharing a phone and having NO
email can both register" (service level), and `test/auth.test.js` - "the 409 does not
lock out two household members who have NO email at all" (route level, both `201`,
two Principals, two ledgers, and the first person's `pii.name` unchanged).

**RED evidence.** With the `phoneHash` fallback and the router's `phone:` argument
restored, both fail, along with finding 2's test - 3 failures total.

**My view on your ruling: I agree, and I would not take the name-plus-dob
alternative.** Three reasons, in order of weight.

First, a second discriminator does not remove the ambiguity, it relocates it. Two
sisters on one handset with different names and dobs would be distinguished; a woman
resubmitting her own form with her name typed slightly differently - "Asha Rao" then
"Asha rao", or a transliteration that varies - would be treated as a *new* person
anyway. So the failure mode you are trying to avoid still occurs, just less
predictably, which is worse than occurring predictably.

Second, it would make the failure mode the dangerous one rather than the safe one.
Matching on name plus dob means a *successful* match writes to an existing record.
For a population where names repeat within a household and a shared handset is
normal, a false positive there is an account takeover - the exact harm finding 2
describes, reintroduced at signup. The current design's failure is a duplicate row.
Those are not comparable costs.

Third, it puts identity resolution in the wrong layer. This library has no way to
verify a name or a date of birth; the host does, and holds context the library never
sees. "Always create, host disambiguates" is the same principle the branch already
settled on for `updatePrincipalContact` (verification is the host's job) and for
`resolvePrincipal` (identity is the host's job). Name-plus-dob would be this library
guessing at identity from unverified payload fields, which is the C1 pattern.

The residual duplicate is documented in the README rather than hidden.

**Relationship to the progress.md ruling.** This does not contradict PLAN REVISION 2's
design F1 ruling - it completes it. That ruling fixed the case where the daughter has
her *own email* (match on emailHash when an email is supplied). It left the fallback
in place for the no-email case and so never covered two phone-only members, which is
the case the stated audience actually lives in. Same principle, wider application.

### 4. Erasure leaves the guardian's plaintext name and email

**Changed.** `src/services/erasure.js` clears `parentalConsent.name`, `.email` and
`.relationship` alongside `pii` and the two hashes.

**The `isMinor` decision: RETAINED, and so is `parentalConsent.verifiedAt`.** Neither
names anybody. `verifiedAt` is a fact about the fiduciary's own process, not personal
data about the guardian; `isMinor` is a bare boolean on a record that is pseudonymous
once the PII and both hashes are gone. Together they are the only thing that keeps the
retained ledger legible as evidence: a child's ledger carries no marketing or analytics
events *because Section 9 prohibits them*, and without `isMinor` that absence cannot be
distinguished from an adult who declined. It is the same trade the ledger itself makes
and that this file's own docstring already argues for - destroy the identity, keep the
pseudonymous evidence. Clearing them would have destroyed the fiduciary's only record
that a child's processing had the lawful basis Section 9 requires.

**Guarded by.** `test/erasure.test.js` - "erasure clears the GUARDIAN's personal data
too, not just the child's". Asserts against the **raw** document (a read-side filter
would hide the defect), checks the three cleared fields individually, *and* scans the
whole serialised record for the guardian's address and name - so a field added to that
subdocument later is caught even if the per-field assertions are never extended. Also
asserts the two retained fields explicitly, so the decision is pinned rather than
incidental, and that `getConsentState` now reports `pii: null` truthfully.

**RED evidence.** Removing the `parentalConsent` clear fails with
`AssertionError: the guardian's name must not survive an erasure`.

**README** now itemises what erasure clears, including the guardian's details, and
names the two retained fields with the reason.

### 5. `PRINCIPAL_ID_SECRET` is not checked by `assertConfigured`

**Changed.** `assertConfigured` rejects an unset, blank, or shorter-than-32-character
`PRINCIPAL_ID_SECRET`, matching the floor `utils/principalId.js`'s own `secret()`
already enforces - so a deployment cannot boot and then 500 on the first request
anyway. Read from `process.env` rather than from the exported `FIDUCIARY` object,
because a secret has no business in an object the toolkit exports for introspection.
The `>= 500` branch of the error mapper now negotiates like the two branches above it,
rendering HTML for a browser while still withholding the internal message.
`.env.example` says it refuses to start; the breaking-changes list records both.

**Guarded by.** `test/catalog.test.js` - "assertConfigured refuses to boot without a
strong PRINCIPAL_ID_SECRET" (unset, empty, whitespace, 31 chars, then 32 chars
succeeds), preceded by "a correctly configured deployment boots" as a non-vacuity
guard so the other tests cannot pass on the wrong error. `test/auth.test.js` - "a
browser gets HTML on the 5xx branch too, and still no internal detail".

**RED evidence.** Removing both the secret check and the negotiation fails both tests
(and finding 7's).

### 6. The rendered consent page omits almost everything the notice requires

**Changed.** `renderConsentPage` renders the object it is handed: `personalData` as an
itemised list, `rights` in full, `grievance.route` and `slaDays`,
`boardComplaint.description`, the `dpo` contact, `statute`, `language` as the `<html
lang>` attribute, per-purpose `retentionMonths`, and `basePath`-built anchors to
`/rights`, `/consent/withdraw` and `/grievance/new`. It also states the notice
`version` and `generatedAt`, so the page and the ledger entry cross-reference.

**Guarded by.** `test/browser.test.js` - "the consent page displays every top-level key
of the notice it stores". The mechanism that makes it drift-proof is
`assert.deepEqual(Object.keys(NOTICE_PROBES).sort(), Object.keys(notice).sort())`:
adding a field to `buildNotice` fails the test until both the renderer and the probe
table are updated. Probes are computed *from* the notice object, not hardcoded, so a
catalog or config change moves the expectation with it. Each probe list is asserted
non-empty, so no key can be silently unchecked. The test also confirms the rendered
notice's version is the one actually stored in `NoticeVersion`, so the assertions are
about the document that gets hashed onto every event.

One probe is a RegExp: `generatedAt` is stamped per render, so the notice the test
builds carries a different instant from the one the server rendered. The assertion is
that the page states a generation time in the right shape, not which one.

**RED evidence.** With `forms.js` at its previous revision the test fails on
`notice.language`, the first key it reaches.

### 7. A non-English language produces an English notice labelled as that language

**Changed.** `assertConfigured` refuses any `NOTICE_LANGUAGES` entry other than `en`,
with an error naming the offending language and what the harm is. The
`require("./notice")` is deliberately **inside** the function: `config/notice.js`
requires `config/catalog.js` at load time, so a top-level require would be circular
and leave `notice.js` destructuring a half-built exports object. By the time
`createRouter` calls `assertConfigured`, both modules are fully loaded.

The code comment in `notice.js` that promised a translation map is replaced with a
statement of why there is none and what would have to be true to add one. The
`.env.example` instruction and the README instruction are both gone, replaced with a
plain statement that only English ships. **No translation system was built.**

**Guarded by.** `test/catalog.test.js` - "assertConfigured refuses to boot with a
notice language that has no catalog". `NOTICE_LANGUAGES` is read once at module load,
so this runs in subprocesses (the technique `test/children.test.js` already uses for
`TZ`). Three cases: `en,hi` refused and the error names `hi` and cites Section 5(3);
bare `hi` refused, so the check is not merely "anything but exactly the string en";
and `en` still boots, so the test is not just asserting that the function throws.

**RED evidence.** Removing the check fails the test.

### 8. The rights page offers a withdrawal button that always fails

**Changed.** `renderRightsPage` renders every right in `RIGHTS_CATALOG` - the filter is
gone. `withdrawal` and `grievance` render as anchor cards pointing at
`/consent/withdraw` and `/grievance/new`; the rest keep their request forms. The
mapping lives in a named `LINKED_RIGHTS` constant with the reasoning attached.

**Guarded by.** `test/browser.test.js` - "every affordance on the rights page either
submits successfully or links to a live route". It parses every `<form>` and every
`<a href>` off the rendered page, POSTs each form with its `right` key and requires
2xx, GETs each link and requires 200. Three non-vacuity guards: forms must be found,
at least one link must be found (the page previously had none), and every key in
`RIGHTS_CATALOG` must be reachable as one or the other - so a future right cannot be
quietly dropped from the page.

**RED evidence.** With `forms.js` at its previous revision the test fails with
`the page must contain at least one link, it previously contained none`.

### 9. A registered minor is locked out of `PUT /consent` forever

**Changed.** On the `principalId` branch, `persistPIIwithconsent` resolves the
principal *before* the age gate and defaults `parentalConsent` to the stored record
when the caller passes none. The signup branch keeps the original ordering - gate
first, then `findOrCreatePrincipal` - so a rejected minor still leaves no `Principal`
behind, which an existing test depends on. Reading a document is not a write, so
resolving first on the authenticated branch does not weaken that guarantee. Only a
caller-supplied record is written back, so the stored one is never re-stamped as if it
had been freshly verified.

**Guarded by.** Two tests in `test/children.test.js`:

- "a registered minor can still update consent - the parental consent on file counts".
  Registers a 14-year-old with valid parental consent, then updates by `principalId`
  exactly as `PUT /consent` does (identity from the session, stored pii, no
  `parentalConsent`), and asserts success, `created: false`, `underwriting` granted -
  while `marketing` and `analytics` stay in `refusedForChild` and absent from state.
- "a minor with NO parental consent on file is still refused on the update path".
  This one is **not** a RED discriminator and passes either way; it is there so the
  fallback cannot later be loosened into a way around Section 9 entirely.

**RED evidence.** Removing the fallback line fails the first test with `status: 422`.

---

## Conflicts

**Between fixes: none.** The two that could have collided are 2 and 3, which both touch
`findPrincipalByContact`. They are reconciled by role rather than by compromise: the
function serves the *sign-in* path (phone branch kept, now refusing ambiguity - fix 2)
and the router's *existence-check* path (which now passes email only, so it never
reaches the phone branch - fix 3). Neither weakens the other.

Fix 1's harness change did overlap fixes 2 and 3 as predicted, but benignly: the one
query it broke was in the household test, which fixes 2 and 3 also touch.

**With progress.md rulings: none.** Checked specifically:

- PLAN REVISION 2, design F1 (shared phone) - fix 3 *extends* it to the no-email case
  it did not cover. Same principle.
- Task 4 finding 1 (phone clash check in `updatePrincipalContact`) - untouched.
  `updatePrincipalContact` still does not check phone clashes.
- Task 4 finding 4 (erasure test asserted 3 of 8 cleared fields) - fix 4 continues in
  that direction rather than against it.
- Task 5 judgement (a) (the age gate must run on the update path too, because
  `isMinor` is read by `decideFor`) - fix 9 preserves this. The gate still runs on
  every path; only the parental-consent *input* to it gained a fallback.
- Task 8 finding 2 (the `withdrawal` right must not fake-succeed) - fix 8 is consistent:
  it still does not create a `RightsRequest`, it now links to the real flow.
- PLAN REVISION 1 (`sanitizeFilter` on `connection.set`, not global) - fix 1 does not
  move it; `test/connection.test.js`'s host-isolation test still passes unchanged.

---

## What I think should still block the PR

**Nothing, in my judgement.** All nine are closed with a guarding test that fails
without its fix. Below are things I noticed but did not fix, none of which I would
hold the PR for.

1. **`generatedAt` on the page is the render time; the stored `NoticeVersion.generatedAt`
   is the first time that version was ever seen** (`$setOnInsert`). Both are honest and
   the `version` hash is the identity that ties them together, but they are not the
   same instant. Worth a sentence in the docs at some point.

2. **The phone-only duplicate is real and now documented, not eliminated.** That is the
   deliberate choice in fix 3, but an adopter who does not read the README will meet it
   in production. A future improvement would be a host-facing helper that lists
   candidate duplicates for a phone number, so disambiguation is supported rather than
   merely expected. Out of scope here.

3. **`findPrincipalByContact` now has two behaviours behind one name** - returns for
   email, throws 409 for an ambiguous phone. Documented in its JSDoc and the README, and
   splitting it would have broken the public export the index test pins. Fine as is, but
   a reviewer may reasonably prefer two functions.

4. **Pre-existing, untouched:** `test/connection.test.js` still has `conn.close()` inside
   `try` blocks rather than `finally` (already recorded as a Task 3 deferral), and
   `consentManagerRequest` still has no `getConsentManagerRequest` to pair with its
   `list*` (already recorded in `test/index.test.js`'s own comment). Neither is mine to
   fix in this round.

5. **Process note.** Every RED check in this report was produced by reverting the fix on
   disk, running the affected file, and restoring from a backup copy taken first. No
   suite run overlapped another; the three final runs were sequential.
