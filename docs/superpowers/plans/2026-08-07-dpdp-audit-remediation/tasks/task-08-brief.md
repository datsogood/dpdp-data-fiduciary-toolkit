# Task 8 brief

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

### Task 8: Section 5 notice capture

**Closes:** H3, L6

**Files:**
- Create: `src/config/notice.js`
- Modify: `src/models/ConsentRecord.js` (notice snapshot on the record)
- Modify: `src/services/persistPIIwithconsent.js` (store the notice)
- Modify: `src/services/dataPrincipalRights.js`, `src/services/withdrawConsent.js` (include DPO contact in responses)
- Create: `test/notice.test.js`

**Interfaces:**
- Produces:
  - `buildNotice({ language })` returns `{ language, fiduciary, purposes: [{ type, title, purpose, lawfulBasis, retentionMonths }], rights, grievance, dpo, generatedAt, version }`.
  - `SUPPORTED_NOTICE_LANGUAGES` - `["en"]` plus any configured, with the Eighth Schedule codes documented.
  - `contactBlock()` returning `{ dpoName, dpoEmail }`, added to the return value of `exerciseRight` and `withdrawConsent`.

- [ ] **Step 1: Write the failing test `test/notice.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
const { buildNotice, SUPPORTED_NOTICE_LANGUAGES } = require("../src/config/notice");
const { buildModels } = require("../src/models");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");

test("the notice itemises every purpose with its lawful basis and retention", () => {
  const notice = buildNotice({ language: "en" });
  assert.ok(notice.purposes.length >= 4);
  for (const p of notice.purposes) {
    assert.ok(p.title && p.purpose, "each purpose needs a plain-language description");
    assert.ok(p.lawfulBasis.kind);
    assert.ok(Number.isInteger(p.retentionMonths));
  }
  assert.ok(notice.dpo.email, "the notice must carry the DPO contact");
  assert.ok(notice.rights.length >= 4, "the notice must tell the principal how to exercise their rights");
  assert.ok(notice.version, "a notice snapshot needs a version to be evidence");
});

test("the notice declares its language and rejects an unsupported one", () => {
  assert.equal(buildNotice({ language: "en" }).language, "en");
  assert.ok(SUPPORTED_NOTICE_LANGUAGES.includes("en"));
  assert.throws(() => buildNotice({ language: "kl" }), /language/i);
});

test("the notice shown at consent time is stored with the record", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const notice = buildNotice({ language: "en" });
    const r = await persistPIIwithconsent({
      models,
      pii: { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" },
      consentTypes: ["marketing"],
      notice,
    });
    const record = await models.ConsentRecord.findOne({ principalId: r.principalId });
    assert.equal(record.lastNotice.version, notice.version,
      "without the notice the fiduciary cannot show what the principal was told");
    assert.equal(record.lastNotice.language, "en");
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test test/notice.test.js`
Expected: FAIL - `src/config/notice.js` does not exist.

- [ ] **Step 3: Write `src/config/notice.js`**

```js
const crypto = require("node:crypto");
const { getCatalog, RIGHTS_CATALOG, FIDUCIARY } = require("./catalog");
const { AppError } = require("../utils/errors");

/**
 * Section 5 requires an itemised notice accompanying (or preceding) the
 * request for consent: what personal data, for what purpose, how to exercise
 * rights, and how to complain. Section 5(3) requires it to be available in
 * English or any language in the Eighth Schedule to the Constitution.
 *
 * The notice is generated from the catalog rather than written by hand, so it
 * cannot drift from what the code actually processes - and a hash of it is
 * stored with the consent, because "we obtained consent" is only evidence if
 * you can also show what the person was told.
 *
 * Only 'en' ships here. Add translations by supplying NOTICE_LANGUAGES and a
 * translation map - the structure is deliberately data, not prose, so it can
 * be translated without touching code.
 */
const EIGHTH_SCHEDULE = [
  "as", "bn", "brx", "doi", "gu", "hi", "kn", "ks", "kok", "mai", "ml", "mni",
  "mr", "ne", "or", "pa", "sa", "sat", "sd", "ta", "te", "ur",
];

const SUPPORTED_NOTICE_LANGUAGES = (process.env.NOTICE_LANGUAGES || "en")
  .split(",").map((s) => s.trim()).filter(Boolean);

function buildNotice({ language = "en" } = {}) {
  if (!SUPPORTED_NOTICE_LANGUAGES.includes(language)) {
    throw new AppError(
      `Unsupported notice language: ${language}. Configured: ${SUPPORTED_NOTICE_LANGUAGES.join(", ")}. ` +
      `Section 5(3) permits English or any Eighth Schedule language (${EIGHTH_SCHEDULE.join(", ")}).`,
      400
    );
  }

  const purposes = getCatalog().map((c) => ({
    type: c.type, title: c.title, purpose: c.purpose,
    lawfulBasis: c.lawfulBasis, withdrawable: c.withdrawable,
    retentionMonths: c.retentionMonths,
  }));

  const body = {
    language,
    fiduciary: { name: FIDUCIARY.name },
    purposes,
    rights: RIGHTS_CATALOG.map((r) => ({ key: r.key, title: r.title, section: r.section, description: r.description })),
    grievance: {
      route: "Raise it with our Grievance Officer first. If it is not resolved within the stated period, you may complain to the Data Protection Board.",
      slaDays: FIDUCIARY.grievanceSlaDays,
    },
    dpo: { name: FIDUCIARY.dpoName, email: FIDUCIARY.dpoEmail },
    statute: "Digital Personal Data Protection Act, 2023",
  };

  // Content-addressed version: the same catalog and config always produce the
  // same version, and any change to what we tell people produces a new one.
  const version = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { ...body, version, generatedAt: new Date() };
}

module.exports = { buildNotice, SUPPORTED_NOTICE_LANGUAGES, EIGHTH_SCHEDULE };
```

- [ ] **Step 4: Add the notice snapshot to `ConsentRecord`**

```js
const noticeSnapshotSchema = new Schema(
  { version: { type: String, required: true }, language: { type: String, required: true }, body: { type: Schema.Types.Mixed }, shownAt: { type: Date, default: Date.now } },
  { _id: false }
);
// on consentRecordSchema:
lastNotice: { type: noticeSnapshotSchema, default: undefined },
```

In `persistPIIwithconsent`, replace `if (notice) record.lastNotice = notice;` with:

```js
if (notice) {
  record.lastNotice = { version: notice.version, language: notice.language, body: notice, shownAt: now };
}
```

- [ ] **Step 4b: Wire `buildNotice()` into `POST /consent` - otherwise H3 is not closed**

Add `src/http/router.js` to this task's Files list. Without this step the notice is snapshotted only when a direct service caller hands one in, and the only test exercising it calls the service directly - so over HTTP, which is every consent a real deployment captures, `notice` is `undefined` and `record.lastNotice` is never set. `getConsentState` would always return `notice: null` while the suite reported H3 closed.

In the `POST /consent` handler (and the `PUT /consent` update handler), build the notice and pass it through:

```js
const notice = buildNotice({ language: req.query.lang || DEFAULT_NOTICE_LANGUAGE });
const result = await persistPIIwithconsent({ models, pii, consentTypes, regrant, notice });
```

`GET /consent/new` (T13) must render the same object it will store, so the principal sees exactly what gets snapshotted.

Add an HTTP-level test asserting `record.lastNotice.version` is set after a `POST /consent`, not just after a direct service call.

- [ ] **Step 4c: Add the notice items the Act requires**

Section 5(1) requires the notice to state the personal data and the purpose, **the manner in which the principal may exercise their rights**, and **the manner of making a complaint to the Board**. The DPDP Rules, 2025 add an itemised description of the personal data and the means of withdrawing consent. The `body` object in Step 3 covers purposes, rights and grievance but omits three items. Extend it:

```js
  // Rule 3(b)(i) - an itemised description of the personal data, not just the
  // purposes it is used for.
  personalData: [
    { field: "name", description: "Your full name" },
    { field: "email", description: "Your email address" },
    { field: "phone", description: "Your mobile number" },
    { field: "dob", description: "Your date of birth" },
    { field: "pan", description: "Your PAN, where we are required to collect it" },
    { field: "address", description: "Your postal address" },
  ],
  // Rule 3(c)(i) - how to withdraw, with ease comparable to giving consent.
  withdrawal: {
    description: "You can withdraw consent for any consent-based purpose at any time, as easily as you gave it.",
    path: "/consent/withdraw",
  },
  // Section 5(1)(iii) - the manner of complaining to the Board.
  boardComplaint: {
    description:
      "Raise it with our Grievance Officer first. If it is not resolved within the stated period, you may complain to the Data Protection Board of India directly.",
    grievancePath: "/grievance/new",
  },
```

Also add the Section 6(4) right of withdrawal to `RIGHTS_CATALOG` in T6's catalog, so the notice's `rights` array actually enumerates it - today withdrawal is a right the notice never lists. Tighten the Step 1 test to assert `personalData`, `withdrawal` and `boardComplaint` are all present and non-empty.

- [ ] **Step 4d: Add `NOTICE_LANGUAGES` to `.env.example`**

This step introduces `process.env.NOTICE_LANGUAGES`. `.env.example` is written once in T1 and no later task amends it, so without this the file that L9 exists to make complete ships incomplete again. Append it with its default of `en` and a comment listing the Eighth Schedule codes.

- [ ] **Step 5: Add the DPO contact to rights and withdrawal responses (L6)**

In `src/config/catalog.js`, export:

```js
const contactBlock = () => ({ dpoName: FIDUCIARY.dpoName, dpoEmail: FIDUCIARY.dpoEmail });
```

Add `contact: contactBlock()` to the object returned by `exerciseRight` and by `withdrawConsent`.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: `test/notice.test.js` 3/3 PASS, all previous green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: generate and store the Section 5 notice

Closes H3, L6.

The consent path produced, stored and returned no notice at all, so the
fiduciary could show that a granted event exists on a date but not what
the data principal was told at that moment - and 'we obtained consent' is
only evidence if you can show the notice that preceded it.

- buildNotice() itemises every purpose with its lawful basis, plain
  language description and retention period, generated from the catalog
  so it cannot drift from what the code processes
- content-addressed version, so any change to what we tell people yields
  a new version
- the notice is snapshotted onto the consent record at capture time
- declares its language and validates it against the configured set,
  with the Eighth Schedule codes documented for translators
- rights and withdrawal responses now carry the DPO contact

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---
