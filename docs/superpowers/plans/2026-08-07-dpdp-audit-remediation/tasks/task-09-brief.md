# Task 9 brief

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

### Task 9: Age gate and parental consent

**Closes:** H4

**Files:**
- Modify: `src/models/Principal.js` (`isMinor`, `parentalConsent`)
- Modify: `src/services/persistPIIwithconsent.js`
- Create: `test/children.test.js`

**Interfaces:**
- Produces:
  - `ageInYears(dob, asOf)` exported from `src/utils/age.js`.
  - `persistPIIwithconsent` requires `pii.dob`. When the principal is under 18, `parentalConsent: { name, email, relationship, verifiedAt }` is required, and without it the call throws `AppError(…, 422)`.
  - Minors never get tracking/advertising purposes: any purpose flagged `prohibitedForChildren: true` in the catalog is refused even with parental consent.

- [ ] **Step 1: Add the flag to the catalog**

T6 already sets `prohibitedForChildren` on every entry (`marketing` and `analytics` true, the rest false) and a catalog test asserts every entry declares it explicitly. Verify that is still the case and move on - there is nothing to add here.

- [ ] **Step 2: Write the failing test `test/children.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
const { buildModels } = require("../src/models");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const { ageInYears } = require("../src/utils/age");

const ADULT_DOB = "1990-04-01";
function minorDob() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 14);
  return d.toISOString().slice(0, 10);
}

test("ageInYears handles the birthday boundary", () => {
  // asOf is built locally, never from an ISO string - see the note on ageInYears.
  assert.equal(ageInYears("2008-08-07", new Date(2026, 7, 6)), 17);
  assert.equal(ageInYears("2008-08-07", new Date(2026, 7, 7)), 18);
});

test("ageInYears handles a leap-year date of birth", () => {
  assert.equal(ageInYears("2008-02-29", new Date(2026, 1, 28)), 17);
  assert.equal(ageInYears("2008-02-29", new Date(2026, 2, 1)), 18);
  assert.equal(ageInYears("2008-02-29", new Date(2028, 1, 29)), 20);
});

test("date of birth is required - an age gate cannot work without it", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () => persistPIIwithconsent({ models, pii: { name: "A", email: "a@b.com", phone: "1" }, consentTypes: [] }),
      (e) => e.status === 400 && /dob/i.test(e.message)
    );
  });
});

test("a minor cannot be registered without verifiable parental consent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () => persistPIIwithconsent({
        models,
        pii: { name: "Child", email: "c@example.com", phone: "1", dob: minorDob() },
        consentTypes: [],
      }),
      (e) => e.status === 422 && /parental consent/i.test(e.message)
    );
  });
});

test("tracking and advertising are refused for a minor even with parental consent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const r = await persistPIIwithconsent({
      models,
      pii: { name: "Child", email: "c@example.com", phone: "1", dob: minorDob() },
      consentTypes: ["marketing", "analytics"],
      parentalConsent: { name: "Parent", email: "p@example.com", relationship: "mother", verifiedAt: new Date() },
    });
    assert.equal(r.state.marketing, undefined, "behavioural advertising to a child must never be recorded as granted");
    assert.equal(r.state.analytics, undefined);
    assert.ok(r.refusedForChild.includes("marketing"));
    const principal = await models.Principal.findOne({ principalId: r.principalId });
    assert.equal(principal.isMinor, true);
    assert.equal(principal.parentalConsent.name, "Parent");
  });
});

test("an adult is unaffected", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const r = await persistPIIwithconsent({
      models, pii: { name: "Asha", email: "a@example.com", phone: "1", dob: ADULT_DOB }, consentTypes: ["marketing"],
    });
    assert.equal(r.state.marketing.status, "granted");
    assert.deepEqual(r.refusedForChild, []);
  });
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `node --test test/children.test.js`
Expected: FAIL - no age handling exists.

- [ ] **Step 4: Write `src/utils/age.js`**

```js
/**
 * Whole years between a date of birth and a moment. Returns null for an
 * unparseable date.
 *
 * The two arguments are DIFFERENT KINDS OF THING and must be read differently.
 * Getting this wrong is not academic - it decides whether a 17-year-old is
 * processed as an adult.
 *
 *   dob  is a CALENDAR DATE. "2008-08-08" parses to UTC midnight (the ISO 8601
 *        rule the Date constructor follows), and a Date loaded from Mongo for a
 *        date-only value is UTC midnight too. So UTC getters recover the
 *        intended calendar date in both cases.
 *
 *   asOf is an INSTANT - "now". The civil date that matters is the one the
 *        deployment is actually living in, so it needs LOCAL getters.
 *
 * Reading both with UTC getters looks tidy and is wrong: verified by execution,
 * it returns 18 at 23:30 on the day BEFORE an 18th birthday in America/New_York
 * (a child treated as an adult), and 17 at 00:30 ON the birthday in
 * Asia/Calcutta - misclassifying an adult as a child in the Act's own
 * jurisdiction. Reading both with local getters is also wrong, and worse: it
 * moves the recognised birthday a full day earlier for every hour of the
 * preceding day anywhere behind UTC.
 *
 * CALLERS AND TESTS: pass asOf as a locally-constructed Date - new Date(2026, 7, 6)
 * - never as an ISO string. new Date("2026-08-06") is UTC midnight, which local
 * getters will shift a day in any negative-offset timezone.
 */
function ageInYears(dob, asOf = new Date()) {
  const birth = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  let age = asOf.getFullYear() - birth.getUTCFullYear();
  const monthDiff = asOf.getMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < birth.getUTCDate())) age -= 1;
  return age;
}

module.exports = { ageInYears, ADULT_AGE: 18 };
```

- [ ] **Step 5: Add the gate to `persistPIIwithconsent`**

After validating `pii` and before `findOrCreatePrincipal`:

```js
const age = ageInYears(pii && pii.dob);
if (age === null) {
  throw new AppError("pii.dob is required and must be a valid date - the Act requires a child's data to be treated differently, which cannot be done without it", 400);
}
const isMinor = age < ADULT_AGE;
if (isMinor && !isVerifiedParentalConsent(parentalConsent)) {
  throw new AppError("Verifiable parental consent is required before processing a child's personal data", 422);
}
```

And when building events, skip any purpose the catalog marks
`prohibitedForChildren` for a minor, collecting them into `refusedForChild`:

```js
if (isMinor && entry.prohibitedForChildren) { refusedForChild.push(entry.type); continue; }
```

Persist `isMinor` and `parentalConsent` on the `Principal`.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: `test/children.test.js` 5/5 PASS, all previous green.

- [ ] **Step 6b: Document what the gate deliberately does not do**

`parentalConsent` is a **server-side parameter only**. No step wires it into `POST /consent`, into the router, or into any rendered form, and that is intentional: a child filling in their parent's name and a `verifiedAt` timestamp on a public form is not verifiable parental consent, it is a text box. The Rules require the check to be made against reliable details of identity, which this library has no way to perform.

The consequence, which must be stated rather than left for someone to discover: **over HTTP, a minor cannot complete signup at all** - they receive the 422 and there is no field through which a parent's consent can be supplied. That is the correct conservative default for a reference implementation, but it is a gap, not a feature. Add to the package README's "What this is not":

```markdown
- No verifiable parental consent mechanism. The toolkit detects that a data
  principal is under 18 and refuses to process their data, but it cannot verify
  a parent's identity, so there is no HTTP path for a minor to be registered
  even with genuine parental consent. An adopter serving minors must build that
  verification and call `persistPIIwithconsent` with a `parentalConsent` object
  from trusted server-side code. Do not expose that parameter to a form.
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add an age gate and parental consent

Closes H4.

There was no age check anywhere. A 14-year-old could submit the consent
form and the toolkit would record granted events for marketing and
analytics - behavioural advertising and tracking aimed at a child - with
nothing in the code path able to detect it. The schema had an optional
dob field that nothing read.

- pii.dob is now required; an age gate cannot exist without it
- a minor cannot be registered without verifiable parental consent (422)
- purposes flagged prohibitedForChildren are refused for a minor even
  when a parent consents, and reported back in refusedForChild
- isMinor and the parental consent record persist on Principal

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---
