# Task 6 report: Lawful basis model

## Fix round 1 (post-review)

The coordinator's review approved the substantive work and confirmed the two disclosed concerns from the original report were real. It raised two gaps in its own brief's test code and one minor normalisation item, all now specified behaviour.

### 1. Allow-list test did not guard the error it exists to prevent

`ALLOWED_S7_CLAUSES` accepts any of the nine real sub-clause letters, including 7(b) - so if `kyc_reporting` were reverted to the wrong `Section 7(b)` citation, that test alone would still pass. Fixed by adding a second, stronger test: `a legitimate use cites a clause a private fiduciary can actually rely on`, checking against a new `PRIVATE_FIDUCIARY_S7_CLAUSES` list.

**I deviated from the coordinator's proposed list and want that flagged explicitly, not buried.** The coordinator proposed `["Section 7(a)", "Section 7(d)", "Section 7(e)", "Section 7(f)", "Section 7(i)"]` - excluding 7(g) and 7(h) - and explicitly invited a challenge: "if you think my membership list is wrong for any letter, say so rather than encoding it." I checked the verbatim statute text via web search against two independent sources (indiankanoon.org and dpdpa.com, both quoting identical wording) before encoding anything:

- 7(b): "for **the State and any of its instrumentalities** to provide or issue to the Data Principal such subsidy, benefit, service, certificate, licence or permit..." - explicitly State-restricted.
- 7(c): "for the performance by **the State or any of its instrumentalities** of any function under any law..." - explicitly State-restricted.
- 7(d): obligation "on **any person**" to disclose to the State - obligation-bearer is unrestricted; only the disclosure recipient is the State. Private-capable (already established).
- 7(g): "for taking measures to provide medical treatment or health services to any individual during an epidemic, outbreak of disease, or any other threat to public health" - **no State-restriction language at all.**
- 7(h): "for taking measures to ensure safety of, or provide assistance or services to, any individual during any disaster, or any breakdown of public order" - **no State-restriction language at all.**
- 7(a), (e), (f), (i): confirmed generically worded, no State restriction, matching the coordinator's own inclusion of them.

So in the statute text, only 7(b) and 7(c) carry explicit "the State and/or its instrumentalities" language: every other sub-clause, including 7(g) and 7(h), is phrased generically and available to any data fiduciary. A private hospital group can rely on 7(g) for epidemic-response medical treatment; a private disaster-relief operator can rely on 7(h). I built `PRIVATE_FIDUCIARY_S7_CLAUSES` as `["Section 7(a)", "Section 7(d)", "Section 7(e)", "Section 7(f)", "Section 7(g)", "Section 7(h)", "Section 7(i)"]` - i.e., "every real clause except the two that explicitly say State-only" - and documented the sourcing and reasoning in a comment in `test/catalog.test.js`. This is the one point in this fix round I have not treated as settled - see Concerns below.

### 2. Nothing tied `withdrawable` to `lawfulBasis.kind` for every entry

Added the generic invariant test verbatim as proposed: `withdrawable is consistent with the basis kind for EVERY entry`, asserting `entry.withdrawable === (entry.lawfulBasis.kind === "consent")` across the whole catalog, closing the gap where only three of five entries had a per-entry check.

### 3. `prohibitedForChildren` normalised across all five entries

Added `prohibitedForChildren: false` to `underwriting`, `prohibitedForChildren: true` to `marketing` and `analytics` (per the coordinator's instruction - marketing and analytics are exactly the behavioural-profiling/advertising uses Section 9 keeps away from a child), and added the test `every entry declares prohibitedForChildren explicitly`, asserting `typeof entry.prohibitedForChildren === "boolean"` for every entry.

### Deliberate-break evidence

Per the coordinator's request, confirmed each new test can actually fail before trusting it, then reverted:

**`prohibitedForChildren` test - failed naturally**, before any catalog change (three entries still lacked the field):
```
✖ every entry declares prohibitedForChildren explicitly (0.7155ms)
  AssertionError [ERR_ASSERTION]: underwriting: prohibitedForChildren must be an explicit boolean
  + actual - expected
  + 'undefined'
  - 'boolean'
```

**Private-fiduciary clause test** - temporarily changed `kyc_reporting`'s clause from `"Section 7(d)"` to `"Section 7(b)"` (the exact wrong citation this task corrects), ran `node --test test/catalog.test.js`, then reverted:
```
✖ a legitimate use cites a clause a private fiduciary can actually rely on (0.073042ms)
  AssertionError [ERR_ASSERTION]: kyc_reporting: "Section 7(b)" is a real clause but not one a private fiduciary can rely on - 7(b) and 7(c) are State-side grounds
```
(The pre-existing `ALLOWED_S7_CLAUSES` test in "no purpose claims contractual necessity as a lawful basis" did NOT fail on this break, confirming the coordinator's diagnosis that it does not guard this error.)

**Withdrawable-consistency test** - temporarily set `marketing.withdrawable` from `true` to `false` (kind stays `"consent"`), ran the suite, then reverted:
```
✖ withdrawable is consistent with the basis kind for EVERY entry (0.600042ms)
  AssertionError [ERR_ASSERTION]: marketing: withdrawable must be true exactly when the basis is consent, got withdrawable=false for kind=consent
  false !== true
```

After reverting both deliberate breaks and applying the real `prohibitedForChildren` fix, `node --test test/catalog.test.js`:
```
✔ no purpose claims contractual necessity as a lawful basis (0.793ms)
✔ no legitimate use claims a general compliance-with-legal-obligation ground (0.108167ms)
✔ underwriting is consent-based and therefore withdrawable (0.082875ms)
✔ the PMLA reporting duty rests on 7(d) and is not withdrawable (0.0475ms)
✔ identity verification beyond the disclosure duty is consent-based and withdrawable (0.053125ms)
✔ the derived lists reflect catalog changes made after import (0.065459ms)
✔ the erasure right is not described with a precondition the Act does not impose (0.061ms)
✔ a legitimate use cites a clause a private fiduciary can actually rely on (0.072125ms)
✔ withdrawable is consistent with the basis kind for EVERY entry (0.083667ms)
✔ every entry declares prohibitedForChildren explicitly (0.096375ms)
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

Full suite, `npm test`:
```
ℹ tests 33
ℹ pass 33
ℹ fail 0
```
33 = the 23 originally pre-existing tests + 10 catalog tests (7 from the original round, 3 new this round).

### Files changed this round

- `src/config/catalog.js` - added `prohibitedForChildren` to `underwriting` (`false`), `marketing` (`true`), `analytics` (`true`).
- `test/catalog.test.js` - added `PRIVATE_FIDUCIARY_S7_CLAUSES` and three new tests.

No em dash or en dash in either file (checked with `grep -n "—\|–"`, no matches).

### Concerns for this round

**The 7(g)/7(h) inclusion is a real disagreement with the coordinator's brief, not a rubber-stamped correction - please double-check it before this gets frozen further.** I have two independent web sources quoting identical statute text with no State-restriction language in 7(g) or 7(h), contrasted against explicit "the State and any of its instrumentalities" language in 7(b) and 7(c). I'm confident in the textual reading, but the coordinator's list was deliberate (they derived it and asked to be corrected only if wrong), and I have not seen their reasoning for excluding 7(g)/7(h) specifically - there may be a policy or drafting-history reason I'm not aware of that isn't visible from the bare text (e.g., if secondary rules or a committee report narrow these clauses in a way the Act's plain text doesn't show). No current catalog entry cites 7(g) or 7(h), so this is forward-looking correctness for whichever task adds one, not a live defect today. Flagging for confirmation rather than treating it as closed.

## What I implemented

Rewrote `src/config/catalog.js` and created `test/catalog.test.js`, exactly per the brief, with one bug fix to the brief's verbatim test code (see below).

`CONSENT_CATALOG` now has five entries, each shaped `{ type, title, purpose, lawfulBasis: { kind, clause, description }, withdrawable, retentionMonths }`:

- `kyc_reporting` - the PMLA reporting duty to the Financial Intelligence Unit. `lawfulBasis.kind: "legitimate_use"`, `clause: "Section 7(d)"`. `withdrawable: false`.
- `identity_verification` - our own identity checks and record-keeping (the old `kyc` purpose's non-reporting half). `lawfulBasis.kind: "consent"`. `withdrawable: true`.
- `underwriting` - loan underwriting and credit assessment. Changed from the old "Necessary to perform your loan contract" / `required: true` to `lawfulBasis.kind: "consent"`. `withdrawable: true`.
- `marketing`, `analytics` - unchanged in substance, consent-based, withdrawable, now carrying `purpose` and `retentionMonths`.

Added five functions that read `CONSENT_CATALOG` live rather than snapshotting it at import time: `getCatalog()`, `getValidConsentTypes()`, `getWithdrawableTypes()`, `getConsentBasedTypes()`, `getCatalogEntry(type)`. `withdrawable` is not hand-set as an independent field decision - every entry's value matches its `lawfulBasis.kind` (`consent` implies withdrawable, `legitimate_use` implies not), and I did not encode a rule that enforces this pairing in code beyond the entries themselves being consistent (there is no runtime assertion that would catch a future entry setting them inconsistently) - flagging this as a soft point, discussed in Concerns below.

`RIGHTS_CATALOG`: fixed the erasure entry's description to drop the "no longer needed for the purposes it was collected for" precondition (L5). New text: "Ask us to delete the personal data we hold about you. We must comply unless the law requires us to keep it - we will tell you which, and why." Other four entries reworded per the brief but same section citations, unchanged shape.

`FIDUCIARY` is unchanged in shape and content, aside from one em-dash-to-hyphen fix in its adjacent comment (see Self-review).

Exports: the five functions, `FIDUCIARY`, `CONSENT_CATALOG`, `RIGHTS_CATALOG` - matching the brief's "export both the functions and, for backwards compatibility with `src/index.js`, `CONSENT_CATALOG` and `RIGHTS_CATALOG` directly." `REQUIRED_CONSENT_TYPES` and `VALID_CONSENT_TYPES` (the old frozen-array exports) are gone, per the brief's interface list, which does not mention them.

## TDD evidence

**RED** - `node --test test/catalog.test.js`, run against the old `catalog.js` (before rewriting it):

```
✖ no purpose claims contractual necessity as a lawful basis (0.8115ms)
✖ no legitimate use claims a general compliance-with-legal-obligation ground (0.155334ms)
✖ underwriting is consent-based and therefore withdrawable (0.135417ms)
✖ the PMLA reporting duty rests on 7(d) and is not withdrawable (0.080083ms)
✖ identity verification beyond the disclosure duty is consent-based and withdrawable (0.056792ms)
✖ the derived lists reflect catalog changes made after import (0.053333ms)
✖ the erasure right is not described with a precondition the Act does not impose (0.427375ms)
ℹ tests 7
ℹ pass 0
ℹ fail 7
```

All seven failed for the expected reasons: `getCatalog is not a function` / `getValidConsentTypes is not a function` (the old catalog exported `CONSENT_CATALOG` and `VALID_CONSENT_TYPES` as consts, not functions - so every test that calls a `get*` function threw a `TypeError`), and the erasure test failed on an actual assertion mismatch: `actual: 'Ask us to delete personal data no longer needed for the purposes it was collected for.'` matched `/no longer needed/i`, which the test forbids.

**GREEN** - after rewriting `catalog.js`, `node --test test/catalog.test.js`:

```
✔ no purpose claims contractual necessity as a lawful basis (0.843833ms)
✔ no legitimate use claims a general compliance-with-legal-obligation ground (0.091792ms)
✔ underwriting is consent-based and therefore withdrawable (0.088125ms)
✔ the PMLA reporting duty rests on 7(d) and is not withdrawable (0.0515ms)
✔ identity verification beyond the disclosure duty is consent-based and withdrawable (0.051875ms)
✔ the derived lists reflect catalog changes made after import (0.070417ms)
✔ the erasure right is not described with a precondition the Act does not impose (0.062ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

### Bug found in the brief's verbatim test code

Between RED and GREEN there was an intermediate failure not attributable to the catalog: the first run against the new catalog still failed one test with `TypeError: assert.notMatch is not a function`. `assert.notMatch` is not a real function in Node's `assert` module (confirmed empty on Node v26.3.1, the only negated-match function is `assert.doesNotMatch` - which the brief's own test file correctly uses in the second and seventh tests). This is a typo in the brief's verbatim code, not a design question, so I corrected it to `assert.doesNotMatch` in `test/catalog.test.js` rather than working around it. This is the one deviation from "exact code to use verbatim."

## Full-suite result

`npm test` (bare `node --test`, all files): **30/30 pass** - the 23 pre-existing tests plus the 7 new catalog tests. Zero failures, zero skips.

## Files changed

- `src/config/catalog.js` - rewritten (staged and committed).
- `test/catalog.test.js` - created (staged and committed).

Commit: `4721d1d fix: model lawful basis on the Act, not on GDPR` (branch `fix/dpdp-audit-remediation`), conventional-commit body, closes H1/L5/M3.

Staged explicitly (`git add src/config/catalog.js test/catalog.test.js`), not `git add -A`. An unrelated file, `docs/superpowers/plans/2026-08-07-dpdp-audit-remediation.md` (outside the npm package, likely auto-updated by planning tooling), was modified in the working tree before and during this session but was never staged or touched by me - it is not part of this commit.

## Transitional breakage left in place

Per the brief and task instructions, I did not touch `withdrawConsent.js` or `persistPIIwithconsent.js` (Task 7's job). Both now break when actually invoked, because they destructure `REQUIRED_CONSENT_TYPES` and `VALID_CONSENT_TYPES` from the catalog module (now `undefined`, since those exports are gone) and read `entry.basis` / `entry.required` off catalog entries (now `undefined`, since entries carry `lawfulBasis` and `withdrawable` instead). I confirmed this directly rather than just inferring it:

- `src/services/withdrawConsent.js` - calling it with a valid `principalId` now throws `Cannot read properties of undefined (reading 'includes')` at `VALID_CONSENT_TYPES.includes(type)`.
- `src/services/persistPIIwithconsent.js` - calling it now throws the same error at `unknownTypes = consentTypes.filter((t) => !VALID_CONSENT_TYPES.includes(t))`.

I did not add compatibility shims, per instruction 4.

## Did any pre-existing test depend on `entry.basis` / `entry.required`?

No. I checked this before touching anything, since the instructions asked me to flag it rather than work around it. The only pre-existing test that calls `withdrawConsent` is `test/injection.test.js` ("withdrawConsent rejects a NoSQL operator instead of matching an arbitrary principal"), and it only exercises malformed `principalId` payloads (`{ $gt: "" }`, `{ $ne: null }`, `{ $regex: ".*" }`). `withdrawConsent` calls `assertPrincipalId(principalId)` as its first line, which throws an `AppError` (status 400) for all of those shapes before the function ever reaches the catalog-dependent code - I verified this against `src/utils/validate.js` and by re-running the full suite. No test calls `persistPIIwithconsent` at all. So the transitional breakage above is real but currently untested and does not touch any of the 30 passing tests.

## Self-review

- **No `lawfulBasis.description` mentions a contract.** Checked all five by eye and via the test; `underwriting`'s description is now "Your consent", with the removed contract language now only appearing in a comment explaining why it was wrong.
- **Every `legitimate_use` entry cites an allow-listed clause, and it's the right one.** Only one entry is `legitimate_use`: `kyc_reporting`, citing `Section 7(d)` for disclosing PMLA-required information to the Financial Intelligence Unit - a disclosure to a State instrumentality, matching 7(d)'s text exactly. No entry cites 7(b) or 7(c).
- **`withdrawable` is consistent with `lawfulBasis.kind` for every entry.** `kyc_reporting`: `legitimate_use` / `false`. All other four: `consent` / `true`. There is no automated invariant enforcing this pairing beyond the entries themselves and the two catalog-test assertions that check specific entries - see Concerns.
- **Erasure right no longer imposes a precondition the Act doesn't.** Confirmed - description no longer says "no longer needed"; it now says compliance is required unless the law requires retention, and the fiduciary must say which law and why.
- **Derived-list functions pick up a runtime catalog change.** Confirmed by the "derived lists reflect catalog changes made after import" test, which pushes an entry after the module has loaded and checks `getValidConsentTypes()` grows by one - passes.
- **Test output pristine; no em dash or en dash.** `npm test` output has no dashes of that kind. I found and fixed one pre-existing em dash in `catalog.js`, in a comment above `FIDUCIARY` ("Swap via env vars — never hardcode...") left over from the original file. `FIDUCIARY`'s shape and values are unchanged; only that one comment's dash character changed, since the whole file was being rewritten under this task's explicit "always use a hyphen, never an em dash - the repo owner is strict about this" constraint. I did not touch anything else in the `FIDUCIARY` block.

## Concerns

1. **No runtime invariant ties `withdrawable` to `lawfulBasis.kind`.** The brief's decision 2 says "`withdrawable` is derived from the basis kind, not hand-set per entry," and the catalog test enforces this for the two entries it names specifically (`underwriting`, `kyc_reporting`) plus indirectly for the "no purpose claims contractual necessity" test's structural check. But there is no `getWithdrawableTypes()`-style derivation from `lawfulBasis.kind` inside the catalog itself - `withdrawable` is still a literal field per entry, just one I set consistently with `lawfulBasis.kind` by hand. A future entry could in principle set them inconsistently without the current test catching it (the test doesn't assert `withdrawable === (kind === "consent")` generically). I chose not to add that generic assertion or to compute `withdrawable` from `kind` inside the catalog itself, because the brief's Step 3 code, which I was told to use verbatim, hand-sets `withdrawable` per entry rather than deriving it via a formula - I judged this a "note it" case rather than a "fix it" case, since going beyond the brief's literal code risked the "do not restructure beyond the brief" instruction. Flagging it rather than silently deciding it doesn't matter.
2. **Transitional breakage confirmed live**, not just inferred - see above. `withdrawConsent` and `persistPIIwithconsent` will throw `TypeError`s if invoked with real data until Task 7 lands. This is expected and matches the brief, but worth restating because it's a real crash, not a cosmetic gap.
3. **One deviation from "verbatim" code**: `assert.notMatch` to `assert.doesNotMatch` in `test/catalog.test.js`, because the former doesn't exist in Node's `assert` module. Flagged in detail above.

I have no doubts about the substantive 7(d)/7(b)/7(c) reasoning in the brief - it matches my own reading of the statute's text as quoted, and I did not find a basis to argue `identity_verification` should be non-withdrawable.
