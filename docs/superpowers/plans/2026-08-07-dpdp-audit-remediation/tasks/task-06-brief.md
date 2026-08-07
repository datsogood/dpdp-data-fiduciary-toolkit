# Task 6 brief

Extracted from `docs/superpowers/plans/2026-08-07-dpdp-audit-remediation/plan.md`. Do not edit - regenerate if the plan changes.

## Global Constraints

These bind this task even where its steps do not repeat them.

- **Writing style:** always use a hyphen ( - ). Never an em dash or en dash. Applies to all code comments, prose, docs, and commit messages.
- **Statute citations:** the Act is the **Digital Personal Data Protection Act, 2023**. Never write "DPDP Act, 2025". The DPDP Rules, 2025 are a separate instrument and must be cited by their own name where referenced.
- **License:** `Apache-2.0`. The root `LICENSE` file (Apache 2.0) is authoritative; `package.json` must declare `"license": "Apache-2.0"`.
- **No secrets in source:** every org-specific value comes from an env var with a documented default. A placeholder default that would be shown to a data principal must fail startup instead.
- **`principalId` is never read from `req.body` or `req.query` on any route.** It comes only from `resolvePrincipal(req)`. Services still accept it as a parameter so they stay framework-agnostic.
- **Every value that reaches a Mongoose query filter must be validated as a primitive first.** Per-field validation in `src/utils/validate.js` is the primary control. `sanitizeFilter` is defence in depth and **must be set on the library's own connection only** - `connection.set("sanitizeFilter", true)`. **Never `mongoose.set("sanitizeFilter", true)`**: verified against mongoose 8.24 by executing real queries, that global setting makes a host application's own `Model.find({ age: { $gt: 5 } })` throw `CastError`, which is precisely the global-singleton hijack H8 exists to eliminate. Also verified: per-query `.setOptions({ sanitizeFilter: true })` does **not** sanitize and is silently inert - do not use it.
- **The consent ledger is append-only.** No code path may delete or mutate an existing event. Erasure removes PII from `Principal`, never events from `ConsentRecord`.
- **Test commands:** `npm test` runs the whole suite via bare `node --test` (no path argument). **Verified in this environment (Node v26.3.1): `node --test test/` FAILS** - it treats the positional `test/` as a module to load and reports a phantom failing test regardless of the real suite. Bare `node --test` discovers `test/**/*.test.js` correctly and treats `test/helpers/db.js` as a zero-test file. To run one file, invoke it directly: `node --test test/validate.test.js`. **Never write `npm test -- test/<file>`** - npm appends the argument, producing the broken two-path form. Every task that changes behaviour ships tests in the same commit.
- **Commit style:** conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`). Every commit message body ends with the two trailer lines used in this repo:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K
  ```
- **Working directory:** all paths below are relative to `data-fiduciary-toolkit/` unless prefixed with `repo-root:`.
- **Finding IDs** (`C1`, `H5`, `M12`, `L3` ...) refer to [`spec.md`](spec.md) beside this plan. Every task lists the findings it closes; a task is not complete until each listed finding is actually addressed.

---

### Task 6: Lawful basis model

**Closes:** H1, L5

**Files:**
- Rewrite: `src/config/catalog.js`
- Create: `test/catalog.test.js`

**Interfaces:**
- Produces:
  - `CONSENT_CATALOG` entries shaped `{ type, title, purpose, lawfulBasis: { kind, clause, description }, withdrawable, retentionMonths }`.
  - `getCatalog()`, `getValidConsentTypes()`, `getWithdrawableTypes()` - **functions**, not frozen arrays (M3).
  - `RIGHTS_CATALOG` with corrected descriptions.
  - `FIDUCIARY` unchanged in shape.

**The substantive fix:** the Act recognises consent plus an enumerated list of legitimate uses. It has no general contractual-necessity ground. `underwriting` was marked non-withdrawable on the basis "Necessary to perform your loan contract", which is a GDPR concept - so the toolkit refused a withdrawal the statute guarantees. Underwriting becomes consent-based and withdrawable. The old single `kyc` purpose is split: `kyc_reporting` cites Section 7(d) (the only clause a private fiduciary's statutory duty can rest on, and only for disclosure to the State) and stays non-withdrawable, while `identity_verification` - our own checks and record-keeping, which go beyond that disclosure duty - becomes consent-based and withdrawable.

- [ ] **Step 1: Write the failing test `test/catalog.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { getCatalog, getValidConsentTypes, getWithdrawableTypes, RIGHTS_CATALOG } = require("../src/config/catalog");

// The real Section 7 sub-clauses, verified against the statute text. A
// legitimate use must cite one of these exactly. A prefix check like
// /^Section 7/ would bless "Section 7(b)" for a private lender's KYC, which is
// the State subsidy clause - so pin the enumeration instead.
// Clauses a PRIVATE data fiduciary can actually rely on. Verified clause by
// clause against the statute text: only 7(b) ("for the State and any of its
// instrumentalities to provide or issue ... subsidy, benefit, service,
// certificate, licence or permit") and 7(c) ("for the performance by the State
// or any of its instrumentalities of any function under any law") are restricted
// to the State. Every other clause is open to a private fiduciary - 7(g) covers
// a private healthcare provider during an epidemic and 7(h) a private relief
// organisation during a disaster, neither of which is State-limited in the text.
//
// This list exists because membership in ALLOWED_S7_CLAUSES is not enough: 7(b)
// is a real clause, so an allow-list of all nine letters would happily bless
// "Section 7(b)" for a private lender's KYC - which is the exact error H1 was
// raised for, and which an earlier draft of this plan actually made.
const PRIVATE_FIDUCIARY_S7_CLAUSES = [
  "Section 7(a)", "Section 7(d)", "Section 7(e)", "Section 7(f)",
  "Section 7(g)", "Section 7(h)", "Section 7(i)",
];

const ALLOWED_S7_CLAUSES = [
  "Section 7(a)", "Section 7(b)", "Section 7(c)", "Section 7(d)", "Section 7(e)",
  "Section 7(f)", "Section 7(g)", "Section 7(h)", "Section 7(i)",
];

test("no purpose claims contractual necessity as a lawful basis", () => {
  for (const entry of getCatalog()) {
    assert.doesNotMatch(
      entry.lawfulBasis.description,
      /contract/i,
      `${entry.type}: the Act has no contractual-necessity ground - use consent or a cited legitimate use`
    );
    assert.ok(["consent", "legitimate_use"].includes(entry.lawfulBasis.kind));
    if (entry.lawfulBasis.kind === "legitimate_use") {
      assert.ok(
        ALLOWED_S7_CLAUSES.includes(entry.lawfulBasis.clause),
        `${entry.type}: "${entry.lawfulBasis.clause}" is not a real Section 7 sub-clause`
      );
    }
  }
});

test("a legitimate use cites a clause a private fiduciary can actually rely on", () => {
  // Membership in ALLOWED_S7_CLAUSES is only a floor - it catches an invented
  // letter. It cannot catch a real-but-inapplicable one, which is the error that
  // actually happened: an earlier draft cited 7(b), the State subsidy clause,
  // for a private lender's KYC.
  for (const entry of getCatalog()) {
    if (entry.lawfulBasis.kind !== "legitimate_use") continue;
    assert.ok(
      PRIVATE_FIDUCIARY_S7_CLAUSES.includes(entry.lawfulBasis.clause),
      `${entry.type}: "${entry.lawfulBasis.clause}" is a real clause but not one a private ` +
        `fiduciary can rely on - 7(b) and 7(c) are State-side grounds`
    );
  }
});

test("no legitimate use claims a general compliance-with-legal-obligation ground", () => {
  // Section 7 contains no such ground for a private fiduciary. 7(d) is confined
  // to disclosure obligations owed to the State, so a description asserting a
  // broad legal-obligation basis is a misstatement of the Act.
  for (const entry of getCatalog()) {
    if (entry.lawfulBasis.kind !== "legitimate_use") continue;
    assert.doesNotMatch(
      entry.lawfulBasis.description,
      /compliance with a legal obligation/i,
      `${entry.type}: no such ground exists - cite what the clause actually authorises`
    );
  }
});

test("withdrawable is consistent with the basis kind for EVERY entry", () => {
  // A generic invariant, not per-entry spot checks. Without this, a future edit
  // setting marketing.withdrawable = false while its kind stays "consent" would
  // pass every other test in this file - and silently refuse a withdrawal the
  // Act guarantees, which is the whole defect H1 was raised for.
  for (const entry of getCatalog()) {
    assert.equal(
      entry.withdrawable,
      entry.lawfulBasis.kind === "consent",
      `${entry.type}: withdrawable must be true exactly when the basis is consent, got ` +
        `withdrawable=${entry.withdrawable} for kind=${entry.lawfulBasis.kind}`
    );
  }
});

test("every entry declares prohibitedForChildren explicitly", () => {
  // Task 9 branches on this. An entry that merely omits it reads as false by
  // accident rather than by decision, which is not good enough for a flag whose
  // job is to keep behavioural advertising away from a child.
  for (const entry of getCatalog()) {
    assert.equal(
      typeof entry.prohibitedForChildren,
      "boolean",
      `${entry.type}: prohibitedForChildren must be an explicit boolean`
    );
  }
});

test("underwriting is consent-based and therefore withdrawable", () => {
  const u = getCatalog().find((e) => e.type === "underwriting");
  assert.equal(u.lawfulBasis.kind, "consent");
  assert.equal(u.withdrawable, true);
  assert.ok(getWithdrawableTypes().includes("underwriting"));
});

test("the PMLA reporting duty rests on 7(d) and is not withdrawable", () => {
  const k = getCatalog().find((e) => e.type === "kyc_reporting");
  assert.equal(k.lawfulBasis.kind, "legitimate_use");
  assert.equal(k.lawfulBasis.clause, "Section 7(d)");
  assert.equal(k.withdrawable, false);
});

test("identity verification beyond the disclosure duty is consent-based and withdrawable", () => {
  // The 7(d) cover extends only to disclosing information to the State. Our own
  // verification and record-keeping is wider, so it needs consent.
  const v = getCatalog().find((e) => e.type === "identity_verification");
  assert.equal(v.lawfulBasis.kind, "consent");
  assert.equal(v.withdrawable, true);
});

test("the derived lists reflect catalog changes made after import", () => {
  const before = getValidConsentTypes().length;
  getCatalog().push({
    type: "research", title: "Impact research", purpose: "Programme evaluation",
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true, retentionMonths: 12,
  });
  assert.equal(getValidConsentTypes().length, before + 1, "derived lists must not be import-time snapshots");
  assert.ok(getValidConsentTypes().includes("research"));
  getCatalog().pop();
});

test("the erasure right is not described with a precondition the Act does not impose", () => {
  const erasure = RIGHTS_CATALOG.find((r) => r.key === "erasure");
  assert.doesNotMatch(
    erasure.description,
    /no longer needed/i,
    "the principal's request is the trigger; retention necessity is the fiduciary's exception to argue"
  );
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test test/catalog.test.js`
Expected: FAIL on all five - the current catalog uses `basis`/`required` and says "no longer needed".

- [ ] **Step 3: Rewrite `src/config/catalog.js`**

```js
// ---------------------------------------------------------------------------
// Consent catalog - the purposes this fiduciary processes personal data for.
//
// Under the Digital Personal Data Protection Act, 2023 there are exactly two
// kinds of lawful basis: the data principal's consent, and the enumerated
// "certain legitimate uses" in Section 7. There is NO general
// contractual-necessity ground - that is GDPR Article 6(1)(b), and it does
// not exist here. So a purpose is either consent-based and withdrawable, or
// it cites a specific Section 7 clause and is not.
//
// Getting this wrong is not cosmetic: a purpose wrongly marked
// non-withdrawable makes this toolkit refuse a withdrawal the statute
// guarantees.
// ---------------------------------------------------------------------------
const CONSENT_CATALOG = [
  // IMPORTANT - read before changing this entry.
  //
  // Section 7 has NO general "compliance with a legal obligation" ground for a
  // private data fiduciary. The clauses were checked against the statute text:
  //   7(b) - the State providing a subsidy, benefit, service, certificate,
  //          licence or permit. Nothing to do with a private lender.
  //   7(c) - the State performing a function under law.
  //   7(d) - "fulfilling any obligation under any law ... on any person to
  //          disclose any information to the State or any of its
  //          instrumentalities". THIS is the only clause a private fiduciary's
  //          statutory duty can rest on, and only for the DISCLOSURE limb.
  //
  // So the PMLA reporting obligation - handing prescribed information to the
  // Financial Intelligence Unit - fits 7(d). Verifying a customer's identity
  // for our OWN records goes beyond that disclosure duty, and processing for
  // that purpose needs consent under Section 6. Modelling the whole of "KYC"
  // as non-withdrawable would repeat exactly the mistake H1 was raised for:
  // refusing a withdrawal the Act guarantees, on a basis that does not cover it.
  {
    type: "kyc_reporting",
    title: "Anti-money-laundering reporting",
    purpose:
      "Reporting the information the law requires us to report about you to the Financial Intelligence Unit.",
    lawfulBasis: {
      kind: "legitimate_use",
      clause: "Section 7(d)",
      description:
        "Obligation under law to disclose information to the State - reporting under the Prevention of Money-Laundering Act, 2002",
    },
    withdrawable: false,
    prohibitedForChildren: false,
    retentionMonths: 60,
  },
  {
    type: "identity_verification",
    title: "Identity verification (KYC checks)",
    purpose: "Checking that you are who you say you are, and keeping a record of that check.",
    // Consent-based: this is our own verification and record-keeping, which is
    // wider than the Section 7(d) disclosure obligation above, so it does not
    // inherit that clause's cover.
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true,
    prohibitedForChildren: false,
    retentionMonths: 60,
  },
  {
    type: "underwriting",
    title: "Loan underwriting and credit assessment",
    purpose: "Assessing whether we can offer you a loan, and on what terms.",
    lawfulBasis: {
      kind: "consent",
      clause: "Section 6",
      description: "Your consent",
    },
    // Consent-based, so withdrawable. Withdrawing it may mean we cannot
    // continue the service - that is a commercial consequence, and it is not
    // a reason to refuse the withdrawal.
    withdrawable: true,
    retentionMonths: 60,
  },
  {
    type: "marketing",
    title: "Marketing and personalised offers",
    purpose: "Telling you about products we think you will want.",
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true,
    prohibitedForChildren: true,
    retentionMonths: 24,
  },
  {
    type: "analytics",
    title: "Product analytics and improvement",
    purpose: "Understanding how our product is used so we can improve it.",
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true,
    prohibitedForChildren: true,
    retentionMonths: 24,
  },
];

// Functions, not module-level snapshots. Snapshots meant that an adopter who
// customised the catalog at boot got a half-applied change: the validator
// rejected the new purpose while the event writer happily wrote events for it.
const getCatalog = () => CONSENT_CATALOG;
const getValidConsentTypes = () => CONSENT_CATALOG.map((c) => c.type);
const getWithdrawableTypes = () => CONSENT_CATALOG.filter((c) => c.withdrawable).map((c) => c.type);
const getConsentBasedTypes = () => CONSENT_CATALOG.filter((c) => c.lawfulBasis.kind === "consent").map((c) => c.type);
const getCatalogEntry = (type) => CONSENT_CATALOG.find((c) => c.type === type);
```

`RIGHTS_CATALOG` - fix the erasure description (L5) and keep the verified section numbers:

```js
const RIGHTS_CATALOG = [
  { key: "access", title: "Right to access information", section: "Section 11",
    description: "Get a summary of the personal data we hold about you, what we are doing with it, and who we have shared it with." },
  { key: "correction", title: "Right to correction and completion", section: "Section 12",
    description: "Ask us to correct inaccurate personal data, complete what is incomplete, or update what is out of date." },
  { key: "erasure", title: "Right to erasure", section: "Section 12",
    description: "Ask us to delete the personal data we hold about you. We must comply unless the law requires us to keep it - we will tell you which, and why." },
  { key: "nominate", title: "Right to nominate", section: "Section 14",
    description: "Name someone to exercise these rights on your behalf if you die or become incapacitated." },
  { key: "grievance", title: "Right to grievance redressal", section: "Section 13",
    description: "Raise a complaint with our Grievance Officer. If it is not resolved in time, you may complain to the Data Protection Board." },
];
```

Export both the functions and, for backwards compatibility with `src/index.js`, `CONSENT_CATALOG` and `RIGHTS_CATALOG` directly.

- [ ] **Step 4: Run the tests**

Run: `node --test test/catalog.test.js`
Expected: PASS 5/5

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: model lawful basis on the Act, not on GDPR

Closes H1, L5, M3.

The catalog marked underwriting non-withdrawable with the basis
'Necessary to perform your loan contract', attributed to Section 7. The
Act has no general contractual-necessity ground - it has consent plus the
enumerated legitimate uses in Section 7 - so the toolkit was refusing a
withdrawal the statute guarantees. Underwriting is consent-based and
withdrawable.

The single kyc purpose is also split, because Section 7 has no general
compliance-with-legal-obligation ground for a private fiduciary. Checked
against the statute: 7(b) is the State issuing a subsidy or licence, 7(c)
is the State performing a function under law, and 7(d) - the only clause
that can carry a private duty - is confined to disclosing information to
the State. So kyc_reporting cites 7(d) for the PMLA reporting obligation
and stays non-withdrawable, while identity_verification, which is our own
record-keeping and wider than that disclosure duty, is consent-based and
withdrawable. Citing 7(b) here would have repeated the same class of
error this commit fixes.

- lawfulBasis { kind, clause, description } replaces basis + required
- withdrawable is derived from the basis kind, not set by hand
- the catalog test pins an allow-list of real Section 7 sub-clauses
  instead of matching a /^Section 7/ prefix, which would bless any letter
- derived type lists become functions, so a catalog customised at boot no
  longer half-applies
- the erasure right no longer tells the principal it only covers data
  'no longer needed' - their request is the trigger, and retention
  necessity is the fiduciary's exception to raise
- each purpose gains a plain-language purpose string and a retention
  period, both needed for the Section 5 notice

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---
