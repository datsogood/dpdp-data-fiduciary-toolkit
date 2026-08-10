# Task 8 report: Section 5 notice capture

**Status:** DONE
**Commit:** `77c4cfd` feat: generate and store the Section 5 notice
**Closes:** H3, L6
**Suite:** 90/90 pass (81 pre-existing + 9 new in `test/notice.test.js`), 0 fail, output pristine.

---

## 1. What I implemented

### `src/config/notice.js` (new)

`buildNotice({ language })` returns the brief's Step 3 shape plus the three Step 4c
additions:

```
{ language, fiduciary, purposes, personalData, rights, withdrawal, grievance,
  boardComplaint, dpo, statute, version, generatedAt }
```

- `purposes` is generated from `getCatalog()` on every call - never a module-level
  snapshot - so it cannot drift from what `persistPIIwithconsent` actually processes.
- `personalData` (Rule 3(b)(i) of the DPDP Rules, 2025), `withdrawal` (Rule 3(c)(i)),
  and `boardComplaint` (Section 5(1)(iii)) are the three items the brief's own first
  draft flagged as missing.
- `rights` maps `RIGHTS_CATALOG`, which now includes the Section 6(4) withdrawal
  right (added in `src/config/catalog.js`), so the notice's rights array actually
  enumerates it.
- `version` is `sha256(JSON.stringify(body)).slice(0, 16)` - content-addressed over
  everything except `generatedAt`, so an unchanged catalog and config reproduce the
  same version and any change to what is told to a principal produces a new one.
- `SUPPORTED_NOTICE_LANGUAGES` reads `NOTICE_LANGUAGES` from the environment
  (default `"en"`), and `DEFAULT_NOTICE_LANGUAGE` is the **first configured**
  language rather than a hardcoded `"en"` - see judgement question 2 below for why.
- An unsupported language throws `AppError(..., 400)` naming the configured set and
  the full Eighth Schedule code list, for translators and for the caller.

### `src/config/catalog.js`

- Added `{ key: "withdrawal", title: "Right to withdraw consent", section: "Section
  6(4)", ... }` to `RIGHTS_CATALOG`.
- Added and exported `contactBlock()` returning `{ dpoName, dpoEmail }`, read live
  from `FIDUCIARY` so a runtime env change is reflected immediately, matching the
  existing pattern for `getCatalog()`.

### `src/models/ConsentRecord.js`

Added `noticeSnapshotSchema` (`{ version, language, body: Mixed, shownAt }`,
`_id: false`) and `lastNotice: { type: noticeSnapshotSchema, default: undefined }` on
`consentRecordSchema`, exactly per the brief's Step 4.

### `src/services/persistPIIwithconsent.js`

`snapshotNotice(doc)` now writes the full shape
`{ version, language, body: notice, shownAt: now }` instead of assigning the bare
`notice` object to `lastNotice` (which had no schema path before this task and was
silently dropped by mongoose strict mode). Called from both the first-attempt save
and the E11000 recovery, unchanged from the existing single-function structure.

### `src/http/router.js` - the step that actually closes H3

Both `POST /consent` and `PUT /consent` now build a notice and pass it through:

```js
const notice = buildNotice({ language: req.query.lang || DEFAULT_NOTICE_LANGUAGE });
const result = await persistPIIwithconsent({ ..., notice });
```

Before this, `persistPIIwithconsent`'s `notice` parameter existed and was tested at
the service layer, but nothing in the HTTP path ever supplied one - every real
consent capture (every deployment using the router) would have stored no notice at
all, while the service-level test made the suite look green. This is the wiring the
brief called out by name as the one that actually matters.

### `src/services/dataPrincipalRights.js` / `src/services/withdrawConsent.js` (L6)

Both now return `contact: contactBlock()` alongside their existing fields.

### `.env.example`

Appended `NOTICE_LANGUAGES=en` with a comment documenting the default and listing
the Eighth Schedule codes, matching `notice.js`'s `EIGHTH_SCHEDULE` list exactly.

### `test/notice.test.js` (new, 9 tests)

The brief's 3 tests, tightened and extended to 9:

1. **Itemises every purpose** - plus assertions that `personalData`, `withdrawal`,
   `boardComplaint` are present and non-empty (Step 4c's tightening instruction),
   and that `rights` includes a `withdrawal` entry (decision 3).
2. **Declares its language and rejects an unsupported one** - as given.
3. **Version is content-addressed, both directions** - same call twice gives the
   same version; pushing a synthetic catalog entry and popping it in a `finally`
   changes the version and restores the catalog.
4. **The notice shown at consent time is stored with the record** - as given
   (direct service call).
5. **`POST /consent` stores a notice snapshot without the caller ever passing
   one** - HTTP-level, asserts `record.lastNotice.version` and `.language` after a
   real POST with no `notice` in the request body. This is the test the brief
   required to actually close H3.
6. **`PUT /consent` refreshes the notice snapshot on an authenticated update** -
   same proof on the update path, since the brief asks for both routes wired.
7. **An unsupported `?lang=` on `POST /consent` is a 400, not a 500, and writes
   nothing** - covers judgement question 2.
8. **`exerciseRight` carries the DPO contact** (L6).
9. **`withdrawConsent` carries the DPO contact** (L6).

---

## 2. TDD evidence

### RED

To get a genuine red run rather than inferring one, I stashed every source-side
change (`.env.example` and all six modified `src/` files), moved the new
`src/config/notice.js` out of the tree, and ran the test file against that
pre-task state with only `test/notice.test.js` present:

```
$ node --test test/notice.test.js
Error: Cannot find module '../src/config/notice'
Require stack:
- .../test/notice.test.js
...
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

Expected and confirmed: `src/config/notice.js` does not exist yet, exactly as the
brief's Step 2 predicted. I then restored everything with `git stash pop` and moved
`notice.js` back.

### GREEN

```
$ node --test test/notice.test.js
✔ the notice itemises every purpose with its lawful basis and retention (2.2ms)
✔ the notice declares its language and rejects an unsupported one (0.3ms)
✔ the version is content-addressed: stable when the catalog is unchanged, and changes when it is (0.1ms)
✔ the notice shown at consent time is stored with the record (995.7ms)
✔ POST /consent stores a notice snapshot without the caller ever passing one (786.8ms)
✔ PUT /consent refreshes the notice snapshot on an authenticated update (823.3ms)
✔ an unsupported ?lang= on POST /consent is a 400 naming the supported languages, not a 500 (632.2ms)
✔ exerciseRight carries the DPO contact (876.6ms)
✔ withdrawConsent carries the DPO contact (888.2ms)
ℹ tests 9
ℹ pass 9
ℹ fail 0
ℹ duration_ms 5262.19
```

---

## 3. Full suite

```
$ node --test
ℹ tests 90
ℹ suites 0
ℹ pass 90
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 30436.29
```

81 pre-existing tests unchanged, 9 new. Wall clock ~30.4s (was ~29.3s at baseline -
the 9 new tests add roughly 8s, mostly from six of them spinning up their own
`MongoMemoryServer` via `withDb`, consistent with the ~0.8-2.7s per-instance cost
seen throughout the existing suite). Ran the full suite four times across this task
(baseline, after the first implementation pass, after tightening the rights
assertion, and this final run) - 90/90 every time, no flakes observed.

Filtering for anything that is not a `✔`, an `ℹ`, or an npm/node banner line returns
nothing: no warnings, no stray stderr, no unhandled rejections.

**Files changed:**
- `data-fiduciary-toolkit/.env.example`
- `data-fiduciary-toolkit/src/config/catalog.js`
- `data-fiduciary-toolkit/src/config/notice.js` (new)
- `data-fiduciary-toolkit/src/http/router.js`
- `data-fiduciary-toolkit/src/models/ConsentRecord.js`
- `data-fiduciary-toolkit/src/services/dataPrincipalRights.js`
- `data-fiduciary-toolkit/src/services/persistPIIwithconsent.js`
- `data-fiduciary-toolkit/src/services/withdrawConsent.js`
- `data-fiduciary-toolkit/test/notice.test.js` (new)

Not touched: `src/http/forms.js` and `examples/server.js`, per the brief - they
belong to Tasks 12-14.

---

## 4. The two judgement questions

### Q1: per-record `lastNotice` vs. one snapshot per consent event

**I implemented per-record, exactly as the brief's Step 4 code specifies. If it
were mine to decide unilaterally, I would choose per-event (or a hybrid), and I
did not make that change myself because it is a real design shift beyond what
Task 8 was chartered to do, and the brief explicitly frames this as a question to
answer, not a decision to make silently in code.**

Reasoning for why the evidentiary argument runs backward from "for size":

The whole premise of this task is that a fiduciary must be able to show *what a
specific data principal was told at the moment of a specific consent event* -
that is the sentence H3's own writeup uses. A single `lastNotice` field,
overwritten on every submission, guarantees that this evidence exists **only for
the most recent event**. Concretely: a principal grants `marketing` in January
under one notice, the catalog's retention period for `marketing` changes in June
(a new `version`), and the principal grants `analytics` in July. `lastNotice` now
holds the July notice. If a dispute arises over the January grant, the fiduciary's
database can no longer produce the notice that was actually shown at that moment
- it can only produce a later one and assert (not prove) that the earlier one was
"similar enough." That is close to the original defect this task exists to fix:
the ledger shows an event happened, but not what preceded it.

"Chosen for size" is also weaker than it first appears, because the version is
already content-addressed. The expensive part - the full notice body - does not
need to be duplicated per event if a separate `NoticeVersion` collection keyed by
`version` stores each unique body once, and each `consentEventSchema` entry stores
only `{ noticeVersion, language }` (a few dozen bytes). Re-submitting under an
unchanged catalog costs nothing beyond that reference, because the version and
body already exist. The size argument mainly bites if the *body* is duplicated on
every event regardless of whether it changed - and content-addressing is
precisely the tool that avoids that.

The counter-argument for per-record, and why I did not simply override the
brief: it is a smaller, more contained change, matches exactly what the brief's
"exact code to use" specifies, and does not touch `consentEventSchema` (which the
append-only-ledger constraint treats with real care - every field on it is part of
the audit trail contract). A per-event version also raises a question the brief
does not answer: does an old event's notice reference stay resolvable forever, or
only as long as the `NoticeVersion` collection is never pruned? That needs its own
design pass, not a decision embedded silently inside a task whose brief already
specifies the opposite shape.

**My recommendation for the record:** move to per-event before this ships to a
production deployment that expects to survive a real dispute, using a
`NoticeVersion` side collection keyed by the content-addressed `version` (so
storage stays bounded to the number of *distinct* notices ever shown, not the
number of consent events), with each `consentEventSchema` entry carrying just
`{ noticeVersion, language }`. Keep `lastNotice` on `ConsentRecord` too, if a
fast "what does this principal see right now" read is useful - it is not wrong,
it is just insufficient as the sole record.

### Q2: does an unsupported `?lang=` reach an unauthenticated caller, and is the resulting status sensible?

**Yes, it reaches one, and yes, the status is sensible - verified by test 7 in
`notice.test.js`, not just reasoned about.**

`POST /consent` is deliberately unauthenticated (signup). The router now calls
`buildNotice({ language: req.query.lang || DEFAULT_NOTICE_LANGUAGE })` in that
handler before any write, so `POST /consent?lang=kl` reaches `buildNotice` with an
unauthenticated, attacker-controlled `language` value. `buildNotice` throws
`AppError(message, 400)`.

Tracing that through `router.js`'s error mapper (registered last): an `AppError`
with `status < 500` is echoed verbatim - `res.status(err.status).json({ error:
err.message })`. So the caller gets a `400` naming the configured languages and
the Eighth Schedule list. That is sensible for three reasons:

1. **It is the caller's own bad input**, not an internal fault - a `500` would be
   wrong in the other direction (the same class of bug M6 already fixed for
   mongoose cast errors).
2. **The message leaks nothing sensitive.** It names only public, static
   configuration (which languages are supported) - not a secret, not PII, not
   anything comparable to the `PRINCIPAL_ID_SECRET` leak the router's error
   mapper was built to prevent. The `err.status < 500` branch exists precisely
   because messages below 500 are "written for the caller."
3. **It writes nothing.** `buildNotice` is called and throws before
   `persistPIIwithconsent` is ever reached, so a probing request costs the
   fiduciary no state at all - confirmed by asserting
   `Principal.countDocuments({}) === 0` and `ConsentRecord.countDocuments({}) ===
   0` after the rejected call.

One thing I changed beyond the brief's literal Step 3 code because of this
question: `DEFAULT_NOTICE_LANGUAGE` is `SUPPORTED_NOTICE_LANGUAGES[0]`, not a
hardcoded `"en"`. The brief's Step 4b sample references `DEFAULT_NOTICE_LANGUAGE`
without defining it, so I had to choose. A hardcoded `"en"` default would mean
that a deployment which sets `NOTICE_LANGUAGES` to something that does not include
`"en"` would have **every** default-language `POST /consent` (i.e. every signup
that does not pass `?lang=`) throw this same 400 - turning a configuration choice
into an outage for the toolkit's primary entry point. Deriving the default from
the first configured language avoids that failure mode while still defaulting to
`"en"` in the shipped configuration (`NOTICE_LANGUAGES=en` is the only value
`.env.example` documents, per decision 5 - only English ships).

---

## 5. Self-review

- **Is the notice actually stored on the HTTP path, or only when a service caller
  passes one?** Asserted directly - tests 5 and 6 hit `POST /consent` and
  `PUT /consent` through a real Express app (`fetch` against a listening server,
  matching `test/auth.test.js`'s pattern) with no `notice` in the request body,
  and read `record.lastNotice.version` / `.language` back from Mongo afterward.
  Both pass.
- **Does the version change when the catalog changes, and stay stable when it
  does not? Both directions.** Test 3 proves both: two calls with an unchanged
  catalog produce an identical version; pushing a synthetic catalog entry (the
  same push/pop pattern `test/catalog.test.js` and `test/consent.test.js` already
  use) and calling again produces a different version, and the catalog is
  restored in a `finally` regardless of assertion outcome.
- **Does the notice contain all of: itemised personal data, every purpose with
  its lawful basis and retention, the rights including withdrawal, the DPO
  contact, and how to complain to the Board?** Test 1 asserts all six:
  `personalData.length > 0`, every `purposes[]` entry has `lawfulBasis.kind` and
  an integer `retentionMonths`, `rights.some(r => r.key === "withdrawal")`,
  `dpo.email`, and `boardComplaint.description`.
- **Is `NOTICE_LANGUAGES` in `.env.example`?** Yes, appended with the default
  (`en`) and the full Eighth Schedule code list in the comment, matching
  `notice.js`'s `EIGHTH_SCHEDULE` constant exactly so the two cannot drift apart
  silently.
- **Test output pristine? Any em dash or en dash?** Full suite output is clean
  (checked above). Grepped every file this task touched or created for
  `–`/`—` - one hit, in `src/services/dataPrincipalRights.js` line 6
  (`"Data Principal Rights" page — just the static catalog`) - which is
  pre-existing code my diff does not touch (confirmed via `git diff` showing that
  line outside any hunk). Left it alone per the surgical-changes rule against
  fixing unrelated pre-existing issues; flagging it here rather than silently
  leaving it unmentioned.

### One observation, not a defect

`notice.js`'s `grievance` field (from the brief's original Step 3) and its
`boardComplaint` field (added in Step 4c) carry near-duplicate text - both
describe "raise it with the Grievance Officer first, then the Board." I kept both
as separate fields exactly as the brief's Step 4c code specifies, since the brief
is explicit that this is "the exact code to use." If this is unintentional
duplication rather than a deliberate redundancy (e.g. `grievance` meant as a
general pointer, `boardComplaint` meant as the Section 5(1)(iii)-specific
citation), it may be worth collapsing in a later pass - I did not do so
unilaterally since the brief's given code is explicit and this task's job was to
implement it, not edit it.

---

## 6. Concerns

1. **Per-record `lastNotice`, as shipped, does not evidence pre-Task-8 vintage
   consent history and loses evidentiary precision for older events once a newer
   submission overwrites it.** Covered in full under judgement question 1 above.
   I implemented exactly what the brief specifies; my recommendation is to move
   to a per-event reference before this is relied on in an actual dispute.
2. **`RIGHTS_CATALOG` now includes `"withdrawal"`, but `exerciseRight` in
   `src/services/dataPrincipalRights.js` has no special case for it** (unlike
   `"grievance"`, which is explicitly blocked with a message redirecting the
   caller to `complaintToTheBoard`, because grievance has its own dedicated,
   stateful flow). Withdrawal also has its own dedicated, **immediately
   effective, self-service** flow (`withdrawConsent` / `PUT` or `POST
   /consent/withdraw`) that this toolkit already ships. As implemented, a caller
   who calls `POST /rights/exercise { right: "withdrawal" }` gets a `RightsRequest`
   document with `status: "received"` - the same shape as `"erasure"` or
   `"correction"`, which genuinely do require manual fiduciary processing - but
   nothing about the principal's actual consent state changes. That could read to
   an integrator or a data principal as "withdrawal filed" when no purpose was
   actually withdrawn. I did not add a guard for this: it is not required to
   close H3 or L6, it is not in the brief's "decisions already made" list, and
   `dataPrincipalRights.js`'s file-list mandate for this task was narrowly "include
   DPO contact in responses." Flagging it as a candidate for whichever task next
   touches that file, or for the plan owner to rule on directly - the fix, if
   wanted, would mirror the existing `"grievance"` block exactly.
3. **The `grievance` / `boardComplaint` near-duplicate text** noted in the
   self-review above - not fixed, not asked to be fixed, flagged for awareness.

---
---

# Fix round 1 report

**Commit:** `d26299b` fix: store the Section 5 notice per event, and stop withdrawal fake-succeeding
**Suite:** 94/94 pass (90 pre-existing + 4 new in `test/notice.test.js`), 0 fail, output pristine.
All items addressed - the two concerns I raised myself, the PUT-test false-green,
and all three minor items. No item deferred, no pushback.

## Item 1 (concern 1, adopted as specified): per-event notice storage

**New model, `src/models/NoticeVersion.js`** - `{ schema, build }` factory, matching
every other model in `src/models/`:

```js
const noticeVersionSchema = new Schema({
  version: { type: String, required: true, unique: true, index: true },
  language: { type: String, required: true },
  body: { type: Schema.Types.Mixed, required: true },
  firstSeenAt: { type: Date, default: Date.now },
});
```

Registered in `src/models/index.js` alongside the other five models, same pattern.

**`src/models/ConsentRecord.js`:**
- `consentEventSchema` gains `noticeVersion: { type: String }` - not required, since
  an event written by a direct service caller that passed no `notice` legitimately
  has none.
- `noticeSnapshotSchema` (the `lastNotice` field) drops `body: Schema.Types.Mixed`
  entirely. It is now `{ version, language, shownAt }` only - a pointer, not the
  evidence. The evidence for a *specific* event is that event's own `noticeVersion`
  plus the `NoticeVersion` row it names; `lastNotice` exists only for a fast "what
  would this principal see right now" read.
- Comment above `consentEventSchema` explains `noticeVersion`; comment above
  `noticeSnapshotSchema` states plainly it is a pointer, not evidence, and points
  at `NoticeVersion` as the actual source of truth. Neither comment references this
  report - the coordinator's minor item 2 asked for that pointer to be dropped
  since the reasoning is now restated inline, and it already was in this rewrite.

**`src/services/persistPIIwithconsent.js`:**
- New block right after `receiptId` is computed, before `decideFor` is defined:
  upserts the notice with `$setOnInsert` (so an unchanged notice shown again writes
  nothing new), keyed on `version`, guarded by `if (notice)`. Runs exactly once per
  call - both the first attempt and the E11000 recovery share it, since `notice`
  does not change between them, so there is no need to upsert twice.
- Added `await models.NoticeVersion.init()` immediately before the upsert, beyond
  what either the coordinator's message or my own plan specified. Same reasoning
  Task 7 accepted for `ConsentRecord.init()`: mongoose builds indexes in the
  background, so without waiting, two concurrent submissions under the same new
  notice version could both upsert before the unique index exists and both insert,
  leaving two `NoticeVersion` rows with the same `version`. I judged this materially
  lower-stakes than the `ConsentRecord` race it mirrors - content-addressing means
  any such duplicate would be byte-identical in `body`, so it could never corrupt or
  fork evidence, only waste one extra document - and said so in the code comment
  rather than overstating the risk. `init()` is memoized, so this costs nothing once
  the index exists. Not directly tested (same honest disclosure Task 7 made for the
  `ConsentRecord` case): I did not find a way to force this exact race in a unit
  test without duplicating Task 7's monkey-patch technique against a second model,
  which felt like more machinery than a lower-stakes race justifies. Flagging for a
  reviewer ruling rather than either skipping the line or inflating its test claim.
- `decideFor`'s event-building loop now stamps `noticeVersion: notice ? notice.version
  : undefined` on every event it pushes - so an event pushed under an earlier notice
  keeps that notice's version even after a later call's `decideFor` runs with a
  different `notice` closed over.
- `snapshotNotice` shrinks to the pointer shape: `{ version, language, shownAt }`,
  no `body`.

**Verified both directions, not just asserted:**

`test("events carry the notice version in force when they were written, not the
record's most recent one")` - grants `marketing` under a first notice, mutates the
live catalog (push/pop, same pattern as `catalog.test.js` and my own earlier
content-addressing test), grants `analytics` under the resulting second notice on
the SAME record, then asserts:
- the `marketing` event's `noticeVersion` is still the FIRST version, not silently
  reattributed to the second;
- the `analytics` event's `noticeVersion` is the second;
- both versions independently resolve via `NoticeVersion.findOne`;
- `lastNotice.version` (the pointer) follows the most recent submission, as
  intended - it is not supposed to hold history, `noticeVersion` per event is.

`test("showing an unchanged notice twice creates exactly one NoticeVersion row")` -
same principal, same notice object, two submissions; `countDocuments({ version })
=== 1`.

`test("several principals consenting under one unchanged catalog still leave
exactly one NoticeVersion")` - three different principals (distinct PII), same
notice; `countDocuments({}) === 1` across the whole collection, not just per-version.

## Item 2 (concern 2, confirmed as a regression, fixed): the withdrawal right no-op

Mirrored the existing `grievance` block in `dataPrincipalRights.js` exactly:

```js
if (right === "withdrawal") {
  throw new AppError(
    "Use withdrawConsent (PUT or POST /consent/withdraw) to withdraw consent - " +
    "it takes effect immediately, it is not a request someone has to action",
    400
  );
}
```

Placed after the `grievance` check, before the `RightsRequest.create` call, so it is
unreachable for any right that should actually be filed. JSDoc's `@param
input.right` updated to name both exclusions.

**Test:** `"exerciseRight refuses 'withdrawal' - it is immediate and self-service,
not a request to file"` - asserts the call rejects with `status === 400` and a
message naming `withdrawConsent` or the route, and that `RightsRequest.countDocuments({})
=== 0` afterward, so the rejection is confirmed to write nothing rather than just
throw and leave a stray document behind.

## Item 3 (false-green in the PUT test, fixed): deliberate-break evidence

The coordinator's diagnosis was exactly right: the PUT test's setup (`POST /consent`
first) already set `lastNotice.version` to some value, and an unchanged catalog
between the POST and the PUT reproduces that same version - so asserting only
`record.lastNotice.version` truthy could not distinguish "PUT wired its own notice
through" from "PUT changed nothing and the POST's snapshot is still sitting there."

**Fix:** capture `lastNotice.shownAt` right after the POST, `await tick()` (5ms,
same helper `test/consent.test.js` uses to guarantee two writes land in different
milliseconds), then assert `shownAt` after the PUT is strictly greater than the
captured value. `shownAt` only moves if a snapshot write actually happens on the
PUT path - a version match alone cannot produce a `shownAt` change unless the write
occurred.

**Verified by an actual deliberate break, not just reasoned about:**

```
$ node --test test/notice.test.js     # with PUT's `notice` wiring deleted
✖ PUT /consent refreshes the notice snapshot on an authenticated update (854.7ms)
  AssertionError [ERR_ASSERTION]: shownAt must move on PUT too, or this test cannot
  distinguish PUT snapshotting its own notice from PUT simply inheriting the POST's
  unchanged snapshot
ℹ tests 13
ℹ pass 12
ℹ fail 1
```

I made the break by removing the `const notice = buildNotice(...)` line and the
`notice,` property from the PUT handler's `persistPIIwithconsent` call in
`src/http/router.js`, ran the suite, confirmed exactly one failure and that it was
this test, then restored the handler with `Edit` and reran to confirm 13/13 green
again. `git diff src/http/router.js` against the prior commit was empty afterward,
confirming the restore was byte-exact - no leftover probe code shipped.

## Minor items

1. **`notice.js` - collapsed the near-duplicate `grievance`/`boardComplaint`
   prose.** Took the coordinator's second suggestion (`boardComplaint` reuses
   `grievance.route`) rather than dropping either field, since both are needed for
   different reasons - `grievance` is the Step 3 interface field, `boardComplaint`
   exists specifically to name Section 5(1)(iii). Introduced one `grievanceRoute`
   constant, referenced from both places, with a comment explaining why: hand-typing
   the same sentence twice would let an SLA or process change leave the two
   descriptions silently out of step. This changes the notice's content-addressed
   `version` (the text changed), which is expected and matches the whole point of
   content-addressing - no test pins a specific version value, so nothing broke.
2. **`ConsentRecord.js:22` - the "Task 8 report" pointer.** Already gone by
   construction: the comment it was attached to was rewritten wholesale for Item 1
   above (the field it described no longer holds a `body` at all), and the new
   comment states the pointer-vs-evidence reasoning inline rather than deferring to
   an external document. Nothing further to do here.
3. **`notice.js` - `personalData` drift-risk comment.** Added: explains that unlike
   `purposes` and `rights`, which are generated from `getCatalog()` and
   `RIGHTS_CATALOG` respectively, `personalData` is hand-maintained because there is
   no single catalog of "every PII field this library's schemas accept" to generate
   it from - so a new field added to `pii` elsewhere (`Principal`'s schema, a form,
   an adopter's own extension) without a matching entry here would silently
   under-disclose it.

## Commands and output

```
$ node --test test/notice.test.js
ℹ tests 13
ℹ pass 13
ℹ fail 0
ℹ duration_ms 8399.26

$ node --test                          # full suite
ℹ tests 94
ℹ suites 0
ℹ pass 94
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35269.51
```

94 = 81 baseline + 9 from the original Task 8 commit + 4 new this round (3 for
per-event notice storage, 1 for the withdrawal guard). Filtering for anything that
is not a `✔`, an `ℹ`, or an npm/node banner line returns nothing - no warnings, no
stray stderr, no unhandled rejections.

**Em dash / en dash check** across every file touched this round
(`src/config/notice.js`, `src/models/ConsentRecord.js`, `src/models/index.js`,
`src/models/NoticeVersion.js` (new), `src/services/dataPrincipalRights.js`,
`src/services/persistPIIwithconsent.js`, `test/notice.test.js`, and `src/http/router.js`
re-checked after the restore): one hit, at `src/services/dataPrincipalRights.js`
line 6 - the same pre-existing line flagged in the original report, confirmed via
`git diff` to sit outside every hunk this round touches. Left alone again, per the
same surgical-changes reasoning as before.

## Files changed in this round

- `src/models/NoticeVersion.js` (new)
- `src/models/index.js` - registers `NoticeVersion`
- `src/models/ConsentRecord.js` - `noticeVersion` on events, `lastNotice` slimmed to
  a pointer
- `src/services/persistPIIwithconsent.js` - upsert, per-event stamping, pointer
  snapshot
- `src/services/dataPrincipalRights.js` - `withdrawal` guard in `exerciseRight`
- `src/config/notice.js` - `grievanceRoute` dedup, `personalData` risk comment
- `test/notice.test.js` - 4 new tests (13 total, up from 9), 1 existing test
  (`PUT /consent refreshes...`) rewritten to assert `shownAt` rather than a
  version presence that setup already guaranteed

Staged by explicit path. **Note:** two files outside `data-fiduciary-toolkit/` are
modified in the working tree - `docs/superpowers/plans/2026-08-07-dpdp-audit-remediation/plan.md`
and `.../tasks/task-08-brief.md` - the coordinator's own documentation edits. Left
unstaged and uncommitted, as instructed.

## Standing concerns after this round

Both concerns from the original report are resolved. One new item, disclosed above
rather than left silent:

1. ~~Per-record `lastNotice` loses evidentiary precision for older events~~ - fixed
   via `NoticeVersion` and per-event `noticeVersion`.
2. ~~`withdrawal` fake-succeeds through `exerciseRight`~~ - fixed, guarded and tested.
3. `await models.NoticeVersion.init()` is not directly test-proven, on the same
   honest-disclosure basis as `ConsentRecord.init()` in Task 7. I judged the actual
   risk lower than that precedent, because content-addressing bounds the damage of
   a lost race to a harmless duplicate row rather than forked or corrupted state -
   said so in the code comment rather than either skipping the line or overclaiming
   a test that does not exist.
4. The `grievance` / `boardComplaint` near-duplicate text - resolved (minor item 1).
