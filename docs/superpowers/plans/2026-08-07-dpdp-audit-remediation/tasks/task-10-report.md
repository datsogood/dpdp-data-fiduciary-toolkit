# Task 10 report: the read path

Closes **C4**. Branch `fix/dpdp-audit-remediation`. Work performed from
`data-fiduciary-toolkit/`.

---

## Fix round 1 of 5 (review response)

Commit `74de8d3` - `fix: close review round 1 findings on the read path`.

The review approved the core property (no cross-principal read found, across
operator injection, undefined-`principalId` collapse, spread-built filters,
fetch-then-check timing, and route shadowing) and confirmed none of the
cross-principal tests passed for the wrong reason. It raised three Important
findings and three cheap/minor ones.

### 1. Ledger dropped `noticeVersion` (Important)

`consentState.js`'s ledger projection omitted `noticeVersion`, even though
`state: record.currentState()` returns raw event subdocuments that already
serialise it - the full audit trail hid the one field that lets a past
event's notice be resolved, backwards for an audit trail. This was the
brief's own Step 3 code, not something I introduced, but it undercut my
answer to judgement question 1 (that per-event `noticeVersion` is where that
evidence lives) since the shipped ledger didn't actually carry it.

**Fix:** added `noticeVersion: e.noticeVersion` to the ledger map in
`src/services/consentState.js`.

**Test added:** `test/readpath.test.js` - "the ledger surfaces noticeVersion
per event, not just on currentState()'s latest one." Builds a notice with
`buildNotice`, submits consent with it, and asserts the ledger's grant event
carries the same `noticeVersion` as `notice.version`.

### 2. PII-bearing reads are cacheable (Important)

The six new authenticated `GET` routes are the first cacheable responses in
the toolkit carrying personal data - every pre-existing PII route is `POST`
or `PUT`. `GET /consent` in particular returns name, email, phone, dob, PAN
and address on a URL with no user-identifying component, distinguished only
by the host's session cookie, so a shared cache/CDN or a browser's
back-forward cache on a shared machine could serve one principal's response
to the next.

**Fix:** added a `noStore` middleware in `src/http/router.js`:

```js
function noStore(req, res, next) {
  res.set("Cache-Control", "no-store");
  res.set("Vary", "Cookie");
  next();
}
```

Applied alongside `requireAuth` (as a third middleware, before the handler)
on all six read routes: `GET /consent`, `GET /rights/requests`,
`GET /rights/requests/:refId`, `GET /grievances`, `GET /grievances/:refId`,
`GET /consent-manager/requests`.

**Test added:** `test/readpath.test.js` - "GET /consent carries
Cache-Control: no-store and Vary: Cookie - PII must never be cached."
Asserts both header values on a live response.

### 3. `escalateToBoard` was an existence oracle (Important)

`complaintToTheBoard.js`'s `escalateToBoard` queried `Grievance.findOne({
refId })` and only afterwards compared `grievance.principalId !==
principalId`, throwing 403 for a mismatch. My new `getGrievance` correctly
404s the identical cross-principal probe by folding `principalId` into the
query filter itself. The mismatch meant `POST /grievance/:refId/escalate`
let anyone holding or guessing a `GR-` reference distinguish "exists, not
yours" (403) from "does not exist" (404) - defeating the exact property this
task establishes elsewhere. Not introduced by me (Task 5's code, unchanged
context), but the same file, so I fixed it here as instructed.

**Fix:** in `src/services/complaintToTheBoard.js`, changed the lookup to
`models.Grievance.findOne({ refId, principalId })` and removed the separate
403 branch - a mismatch now falls straight into the existing 404. Updated
the doc comment above the function to explain the new shape and point at
`getGrievance`'s identical reasoning.

**Existing test updated:** `test/auth.test.js` - "escalateToBoard refuses a
refId belonging to another principal" (written in Task 5) asserted
`res.status === 403`. Changed the assertion to `404` and updated its message
and an inline comment to explain why (existence-oracle reasoning, matching
`GET /grievances/:refId`). No other test referenced the old 403 or its "This
grievance does not belong to you" message - checked with
`grep -rn "escalateToBoard\|does not belong to you\|403" test/`, which found
only this one and the new 404-focused assertions I'd already added.

### Cheap/minor findings addressed

- **`consentManagerRequest.js` omitted `updatedAt`** while its two sibling
  list functions return it. The underlying model genuinely had no
  `updatedAt` field (unlike `RightsRequest`/`Grievance`, which do) - this
  wasn't just a missing projection. Added `updatedAt: { type: Date, default:
  Date.now }` to `src/models/ConsentManagerRequest.js` (additive, so no
  existing document or test needed backfilling) and included it in
  `listConsentManagerRequests`'s return shape.
- **No test for a syntactically valid but nonexistent `refId`** - only the
  cross-principal 404 was covered for `getRightsRequest`/`getGrievance`.
  Added "GET /rights/requests/:refId and GET /grievances/:refId are 404 for
  a syntactically valid refId that never existed" to `readpath.test.js`,
  using well-formed but unregistered refIds (`RQ-0000000000000000`,
  `GR-0000000000000000`) against the requester's own session.
- **Unbounded list queries** - `listRightsRequests`, `listGrievances`, and
  `listConsentManagerRequests` had no `.limit()`, so a principal with an
  unusually large history could make a read arbitrarily expensive. Added
  `.limit(200)` to all three, with a comment on each explaining the cap.

### Not addressed (per coordinator: not mine)

- Missing `GET /consent-manager/requests/:refId` - carried as a follow-up by
  the coordinator; my original call to follow the brief's route table stands.
- The function-export-with-a-property shape on `consentManagerRequest.js`
  (ESM interop hazard) - carried by the coordinator rather than restructured
  now.

### Re-verification

**`node --test test/readpath.test.js`** (11 tests: the original 8 plus the 3
new ones from this round):

```
✔ a principal's full consent history can be read back
✔ the ledger surfaces noticeVersion per event, not just on currentState()'s latest one
✔ getConsentState returns pii for a principal who has not been erased, and erasedAt is null
✔ GET /consent returns the ledger to the authenticated owner only
✔ GET /consent carries Cache-Control: no-store and Vary: Cookie - PII must never be cached
✔ GET /rights/requests and GET /rights/requests/:refId are scoped to the owner - a stranger gets 404, not 403
✔ GET /grievances and GET /grievances/:refId are scoped to the owner - a stranger gets 404, not 403
✔ GET /consent-manager/requests is scoped to the owner
✔ GET /consent for an erased principal surfaces erasedAt and never resurrects pii
✔ a principalId in the query string is ignored on a read route - identity comes only from the session
✔ GET /rights/requests/:refId and GET /grievances/:refId are 404 for a syntactically valid refId that never existed
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

**Full suite, `node --test`:** first run showed 104 pass / 1 fail -
`test/children.test.js`'s "date of birth is required" test failed with
`Error: Port "60110" already in use`, a `mongodb-memory-server` port-binding
race unrelated to any file this round touched. Re-ran the full suite
immediately after:

```
ℹ tests 105
ℹ pass 105
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 38262.99
```

105 = 94 original baseline + 11 in `readpath.test.js` (8 from the initial
implementation, 3 added this round). Wall clock ~38.3s, consistent with the
in-memory-MongoDB-per-test pattern used throughout this suite. All tests
green on the clean re-run, including the updated `test/auth.test.js`
assertion.

### Files changed this round

- `data-fiduciary-toolkit/src/services/consentState.js` (`noticeVersion` in
  the ledger)
- `data-fiduciary-toolkit/src/http/router.js` (`noStore` middleware, applied
  to all six read routes)
- `data-fiduciary-toolkit/src/services/complaintToTheBoard.js`
  (`escalateToBoard` filter fix, `.limit(200)` on `listGrievances`)
- `data-fiduciary-toolkit/src/services/dataPrincipalRights.js`
  (`.limit(200)` on `listRightsRequests`)
- `data-fiduciary-toolkit/src/services/consentManagerRequest.js`
  (`updatedAt` in the return shape, `.limit(200)`)
- `data-fiduciary-toolkit/src/models/ConsentManagerRequest.js` (added
  `updatedAt` field)
- `data-fiduciary-toolkit/test/auth.test.js` (403 to 404 assertion update)
- `data-fiduciary-toolkit/test/readpath.test.js` (3 new tests)

Not staged or committed: `docs/superpowers/plans/2026-08-07-dpdp-audit-remediation/plan.md`,
`.../tasks/task-10-brief.md`, `.../tasks/task-14-brief.md` - all modified in
the working tree by the coordinator, not by me.

## What was implemented

1. **`src/services/consentState.js`** (new) - `getConsentState({ models, principalId })`,
   exactly the code given in the brief. Returns `{ docRef, principalId, state, ledger,
   notice, pii, erasedAt, createdAt, updatedAt }`. `state` is `record.currentState()`;
   `ledger` is the full event array (type, status, basis, lawfulBasisKind, receiptId,
   timestamp - one entry per grant/decline/withdrawal, never collapsed). `pii` is
   `null` once the principal is erased, with `erasedAt` surfaced instead. Throws
   `AppError(..., 404)` when no `ConsentRecord` matches the given `principalId`.

2. **`src/services/dataPrincipalRights.js`** - added `listRightsRequests({ models,
   principalId })` and `getRightsRequest({ models, principalId, refId })`, both
   filtering on `{ principalId }` (get also on `{ principalId, refId }` together, not
   `{ refId }` followed by an ownership check).

3. **`src/services/complaintToTheBoard.js`** - added `listGrievances` and
   `getGrievance`, same shape as above, over the `Grievance` model.

4. **`src/services/consentManagerRequest.js`** - added `listConsentManagerRequests`.
   The module previously exported a bare function (`module.exports =
   consentManagerRequest`); I attached the new function as a property on that same
   export (`module.exports.listConsentManagerRequests = ...`) rather than restructure
   the export shape, so every existing caller (`router.js`, `index.js`) that does
   `require("../services/consentManagerRequest")` and calls it directly keeps working
   unchanged.

5. **`src/http/router.js`** - six new authenticated `GET` routes, each placed next to
   the mutating routes for the same resource. Every handler reads only
   `req.principalId` (set by `requireAuth` from `resolvePrincipal(req)`); none reads
   `req.query` or `req.body`.

6. **`src/index.js`** - exported `getConsentState`, `listRightsRequests`,
   `getRightsRequest`, `listGrievances`, `getGrievance`, and
   `listConsentManagerRequests` alongside the existing service exports. Verified by
   requiring the module directly and checking every expected key is a function - see
   "Self-review" below.

7. **`test/readpath.test.js`** (new) - the two tests given verbatim in the brief, plus
   six more I wrote to cover the property the task said matters most (see below).

## TDD evidence

**RED** - `node --test test/readpath.test.js` before `src/services/consentState.js`
existed:

```
Error: Cannot find module '../src/services/consentState'
...
✖ test/readpath.test.js (198.339833ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

Expected and correct: the test file requires a module that does not exist yet.

After writing `consentState.js` but before wiring the router, running again showed
the service works standalone while the route is still missing:

```
✔ a principal's full consent history can be read back (810.621292ms)
✖ GET /consent returns the ledger to the authenticated owner only (828.942166ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  404 !== 200
```

(Unmatched `GET /consent` falls through to Express's default 404, which the test
correctly rejects since it expected 200 for the owner.)

**GREEN** - after wiring all six routes and the three services' list/get functions,
`node --test test/readpath.test.js`:

```
✔ a principal's full consent history can be read back (824.264ms)
✔ getConsentState returns pii for a principal who has not been erased, and erasedAt is null (803.174584ms)
✔ GET /consent returns the ledger to the authenticated owner only (832.499666ms)
✔ GET /rights/requests and GET /rights/requests/:refId are scoped to the owner - a stranger gets 404, not 403 (838.101625ms)
✔ GET /grievances and GET /grievances/:refId are scoped to the owner - a stranger gets 404, not 403 (827.985334ms)
✔ GET /consent-manager/requests is scoped to the owner (825.915291ms)
✔ GET /consent for an erased principal surfaces erasedAt and never resurrects pii (801.807917ms)
✔ a principalId in the query string is ignored on a read route - identity comes only from the session (811.423625ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

The brief's Step 1 test file has exactly 2 tests and both pass (tests 1 and 3 in the
list above, in file order the brief's originals are tests 1 and 3 since I inserted one
extra service-level test between them). I added six more tests beyond the brief's
minimum - see "Extra tests" below for why.

## Full-suite result

```
node --test
ℹ tests 102
ℹ suites 0
ℹ pass 102
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36010.19
```

102 = 94 baseline + 8 new (`readpath.test.js`). Wall clock ~36s (real ~36.6s per
`time`), consistent with the baseline's ~33-35s given the added tests each spin up an
in-memory MongoDB. All 94 pre-existing tests still pass unchanged.

## Files changed

- `data-fiduciary-toolkit/src/services/consentState.js` (new)
- `data-fiduciary-toolkit/src/services/dataPrincipalRights.js` (added
  `listRightsRequests`, `getRightsRequest`)
- `data-fiduciary-toolkit/src/services/complaintToTheBoard.js` (added
  `listGrievances`, `getGrievance`)
- `data-fiduciary-toolkit/src/services/consentManagerRequest.js` (added
  `listConsentManagerRequests`)
- `data-fiduciary-toolkit/src/http/router.js` (six new `GET` routes + imports)
- `data-fiduciary-toolkit/src/index.js` (exported the six new functions)
- `data-fiduciary-toolkit/test/readpath.test.js` (new)

Not touched: `src/http/forms.js`, `examples/server.js` (Tasks 12-14's), `README.md`
(no read-path documentation was requested in the brief's steps).

Untouched but present in the working tree, deliberately not staged or committed:
`docs/superpowers/plans/2026-08-07-dpdp-audit-remediation/tasks/task-14-brief.md`
(the caller's own documentation edit).

## Routes added

| Route | Auth | Scoping | On miss/cross-principal |
|---|---|---|---|
| `GET /consent` | `requireAuth` | `getConsentState` filters `ConsentRecord.findOne({ principalId })` on `req.principalId` | 404 |
| `GET /rights/requests` | `requireAuth` | `listRightsRequests` filters `RightsRequest.find({ principalId })` | empty array (never another principal's rows) |
| `GET /rights/requests/:refId` | `requireAuth` | `getRightsRequest` filters `RightsRequest.findOne({ principalId, refId })` - combined filter, not filter-then-check | 404 |
| `GET /grievances` | `requireAuth` | `listGrievances` filters `Grievance.find({ principalId })` | empty array |
| `GET /grievances/:refId` | `requireAuth` | `getGrievance` filters `Grievance.findOne({ principalId, refId })` | 404 |
| `GET /consent-manager/requests` | `requireAuth` | `listConsentManagerRequests` filters `ConsentManagerRequest.find({ principalId })` | empty array |

Every handler passes `principalId: req.principalId` - the value `requireAuth` put
there from `resolvePrincipal(req)` - and none reads `req.params` for anything but
`refId`, nor `req.query`/`req.body` for identity.

## Judgement questions

**1. Should `getConsentState` resolve `noticeVersion` into the notice body?**

No - kept `notice` as the pointer `{ version, language, shownAt }`, matching the
brief's exact code and the plan's decision #3. Reasons:

- The evidence for what notice was shown for a *specific* event is that event's own
  `noticeVersion` in the ledger, not the top-level `lastNotice` pointer - resolving
  only the pointer would answer "what notice is currently on file" but not "what did
  this principal see when they granted marketing consent in March", which is the
  access right's more interesting content. Resolving properly would mean resolving
  per-ledger-event, which is a bigger change than a single lookup.
- `NoticeVersion` bodies can be arbitrary-shaped (`Schema.Types.Mixed`) and are
  content-addressed precisely so they don't need to travel with every read - a caller
  who wants the body for a specific version already has everything needed
  (`models.NoticeVersion.findOne({ version })`) to fetch it directly, once, only when
  they need it.
- Resolving eagerly on every `GET /consent` costs a lookup whether or not the caller
  cares about notice text, and grows the response for API clients that only want
  `state`/`ledger`.

I did not resolve it. If a future task wants a one-call "give me everything including
the exact text I was shown," that is an additive, backward-compatible change (a
`resolveNotice: true` option or a bulk-resolve helper), not a reason to change this
task's shape now.

**2. Is the `GET /consent` 404 for "no consent record" reachable, and is 404 right?**

I traced every path that creates a `Principal`: the only one is
`findOrCreatePrincipal` in `src/utils/principalId.js`, called exclusively from
`persistPIIwithconsent`. That same function *always* ends up calling
`ConsentRecord.save()` for the principal it just resolved - even when
`consentTypes` is omitted and no event is appended (`newEvents.length === 0`), the
`new models.ConsentRecord({...})` document is still saved. So within this library's
own write paths, a `Principal` and its `ConsentRecord` are always created together in
the same call; there is no code path inside this package where a `Principal` exists
with zero matching `ConsentRecord` documents.

The 404 is still reachable, though, for two reasons outside that guarantee:

- A host application can use `buildModels(connection)` directly and write a
  `Principal` document through its own code, bypassing `persistPIIwithconsent`
  entirely (the models are exported specifically so integrators can do this).
- `resolvePrincipal(req)` is the host's own session lookup. A stale session, a
  session issued against a different environment/database, or any resolver bug can
  return a syntactically valid 64-hex-char id that doesn't correspond to any
  `Principal` at all - `requireAuth` only checks the *shape* of what `resolvePrincipal`
  returns, not that a `Principal` exists.

404 is the right status for both, and deliberately the *same* 404 for both: `getConsentState`
never checks `Principal` existence to decide the status code - it only checks whether a
`ConsentRecord` matches. That means "this principalId belongs to nobody" and "this
principal exists but somehow has no ledger" are indistinguishable from the response,
which is consistent with the task's own reasoning for why cross-principal reads must be
404 rather than 403: giving a different status for "principal exists, no ledger" vs
"principal doesn't exist at all" would leak information about which principalIds are
real to anyone who can get a `resolvePrincipal` hook to return an arbitrary value (or,
in a host with its own auth bugs, to a caller probing ids). I verified this is exactly
what the code does by reading it again after tracing the reachability question - no
change was needed.

## Self-review

- **Can any read return another principal's data?** I tried to break every new route,
  not just the one the brief tested. Added tests authenticate as principal A, create a
  `RightsRequest`/`Grievance`/`ConsentManagerRequest` for A, then re-authenticate as a
  second real principal B and confirm: (a) `GET .../{refId}` for A's ref returns 404
  to B, and (b) `GET .../` (list) for B returns `[]`, not A's rows. All pass.
- **Does a cross-principal read return 404 rather than 403?** Yes, for `GET /consent`
  (brief's own test, against a syntactically-valid but non-existent principalId) and
  for `GET /rights/requests/:refId` and `GET /grievances/:refId` (my tests, against a
  second *real* principal B, which is the stronger case - it proves the query itself
  excludes B's access rather than merely that B's id happens not to resolve to
  anything).
- **Does an erased principal's read leak PII?** Tested directly: erase a principal via
  `erasePrincipalPII`, then `GET /consent` as that same principal - `pii` is `null`,
  `erasedAt` is a timestamp, and the ledger (`state.marketing.status === "granted"`)
  is untouched, confirming erasure only clears `Principal`, never `ConsentRecord`
  events, matching the plan's append-only constraint.
- **Is `currentState()` finally called by something?** Yes, inside
  `getConsentState`. Worth noting for the record: the task's "what is wrong today"
  section says it "has zero call sites," but by the time this task ran (after Task 5,
  per the stated execution order), `persistPIIwithconsent` and `withdrawConsent`
  already called it internally to compute deltas and to populate their own response's
  `state` field. So `currentState()` was not literally uncalled - but there was still no
  way to fetch it *later*, independent of a write, which is the actual gap this task
  closes and the one the Section 11 access right needs. I did not change or touch the
  write-path call sites.
- **Does any route read an identifier from the request rather than the session?**
  Checked by reading every new handler: each passes only `req.principalId` (from
  `requireAuth`) into its service call, and `req.params.refId` is used only where the
  brief's route table specifies a `:refId` segment. Backed by a test:
  `GET /consent?principalId=<other principal>` while authenticated as A returns A's
  own record, proving the query string is never consulted.
- **Test output pristine? Any em dash or en dash?** Full suite output has no
  unexpected warnings, no `console.error` output. Grepped every changed/new file for
  U+2013/U+2014; matches exist only in pre-existing lines I did not touch (confirmed
  by diffing against `+`-only lines, which had zero matches).

## Extra tests beyond the brief's minimum

The brief's Step 1 gives the exact content for `test/readpath.test.js`'s first two
tests, and Step 6 only asks to confirm those 2/2 pass. The task's own "property that
matters most" section and "self-review" checklist, however, explicitly ask for
scoping to be proven on more than the one route the brief's sample test exercises
("try to break it, do not just assert the happy path"). I kept the brief's two tests
verbatim and added six more:

1. `getConsentState` returns `pii` for a non-erased principal (closes the other half
   of decision #2, which the brief's own test doesn't check).
2. `GET /rights/requests` + `GET /rights/requests/:refId` scoping, against a second
   real principal.
3. `GET /grievances` + `GET /grievances/:refId` scoping, same shape.
4. `GET /consent-manager/requests` scoping.
5. Erased principal's `GET /consent` does not leak PII.
6. A query-string `principalId` is ignored by `GET /consent`.

## Concerns

None that block. Two things worth flagging for whoever reads this next:

- `listConsentManagerRequests` is exported and routed (`GET /consent-manager/requests`)
  but there is no `getConsentManagerRequest`/`GET /consent-manager/requests/:refId` -
  the brief's own route table only lists the collection route for that resource, not
  an item route, so I did not add one. If a later task wants item-level lookup for
  consent-manager requests, the shape to copy is `getGrievance`/`getRightsRequest`
  (combined `{ principalId, refId }` filter, 404 on miss).
- `consentManagerRequest.js`'s export is a callable function with a property attached
  (`module.exports.listConsentManagerRequests = ...`) rather than a plain object,
  because that's how it already worked before this task and every existing caller
  depends on calling it directly. It's a slightly unusual export shape but changing it
  would be an unrelated, larger refactor outside this task's scope.
