# Task 5 report: Authentication hook, default-deny

**Status:** DONE_WITH_CONCERNS
**Commit:** `d3b8f42` - `feat: require an injected auth hook, default-deny`
**Closes:** C1 (authorisation half), M8, M6

---

## What I implemented

`src/http/router.js` rewritten wholesale. It had been broken since Task 3, because every
service signature changed underneath it and it was still passing `req.body` straight in.

**The auth control.** `createRouter({ db, resolvePrincipal, onWithdrawal, onGrievanceFiled })`.
`db` is required and validated at construction. `requireAuth` is the single middleware every
mutating route sits behind. With no `resolvePrincipal` configured it returns 401 without
consulting anything, so a misconfigured deployment fails closed. The hook is `await`ed, so an
async database lookup works; a throw from it is caught and becomes 401 rather than a 500. The
resolved value must match `/^[a-f0-9]{64}$/` before it is trusted as `req.principalId`.

**`POST /consent` - the 409 before any write.** The handler calls `findPrincipalByContact`
first. If it returns a principal the request is refused with 409 and nothing is written.
Reading `persistPIIwithconsent`'s `created` flag afterwards would have returned the same 409
with the victim's PII already overwritten and their ledger already appended to.

**`PUT /consent` - identity from the session.** Loads by `req.principalId`, then hands
`principal.pii.toObject()` - the *stored* record - to `persistPIIwithconsent`. There is no
contact detail a caller can supply that redirects the write, because the payload's PII is
never passed through. Supplied `email`/`phone` that do not hash to the session principal's own
stored hashes are refused with 403.

**Body normalisation.** `express.urlencoded({ extended: false })` per the brief, plus the
brief's `asArray`, `readConsentTypes` and `readPii`, and a small `isTrue` for `regrant`
(without it a form's `regrant=false` string would be truthy, and a form could never say no).
`req.body` is never spread into `pii`.

**The error mapper**, registered last, exactly as Step 3d specifies.

**Services.** The deliberate `throw new Error(...)` calls in `dataPrincipalRights.js`,
`complaintToTheBoard.js` and `consentManagerRequest.js` became `AppError` with real statuses,
and their string inputs are validated with `assertPrincipalId` / `assertNonEmptyString` at
lengths matching each schema's `maxlength`. `escalateToBoard` now requires `principalId` and
compares it against the grievance owner.

### Two deliberate additions beyond the literal step text

- **`onGrievanceFiled` is wired**, not just destructured. The brief names it in the `Produces`
  interface; accepting an option and silently ignoring it is worse than not accepting it. Two
  lines, called after a successful grievance write.
- **`PUT /consent` rejects an erased record with 409.** Erasure is terminal (established in
  Task 4's `updatePrincipalContact`). Without the guard an erased principal fails a few frames
  later with a confusing message about a missing `pii.name`. It fails closed either way; this
  makes it say what actually happened.

### Deliberately NOT done

- **`notice` and `parentalConsent` are never read from the request body.** `persistPIIwithconsent`
  accepts both. `parentalConsent` is documented in that file as server-side only - "a child
  typing a parent's name and a verifiedAt timestamp into a public form is not verifiable
  parental consent, it is a text box" - and `notice` is Task 8's to construct. Passing either
  from `req.body` would write caller-controlled content into schema paths.
- **No `GET /consent`, `GET /consent/withdraw`, `GET /consent/new`.** The route table lists
  them, but `consentState.js` (Task 10) and the consent/withdrawal renderers (Task 13) do not
  exist yet. I left them to their owning tasks rather than stubbing them.

---

## TDD evidence

### RED

```
$ node --test test/auth.test.js
ℹ tests 11
ℹ pass 0
ℹ fail 11
```

Representative failures, all for the expected reasons:

```
✖ createRouter requires a db handle
  Missing expected exception (/db is required/)

✖ every mutating route is 401 when no resolvePrincipal is supplied
  PUT /consent must be 401 without auth
  401 !== 404

✖ an AppError carrying a 500 does not echo its message
  400 !== 500

✖ a mongoose cast failure is a 400 naming the field
  actual: "Cannot read properties of undefined (reading 'Principal')"
```

The last one is the Task 3 breakage showing through: the old router called
`persistPIIwithconsent(req.body)` with no `models`, so every write route died on
`models.Principal`. The `400 !== 500` is M6 exactly - the old per-route
`res.status(400).json({ error: err.message })` reported a configuration fault as a client error.

### GREEN

```
$ node --test test/auth.test.js
✔ createRouter requires a db handle (0.87ms)
✔ every mutating route is 401 when no resolvePrincipal is supplied (784.50ms)
✔ principalId in the request body is ignored - it never grants access (608.54ms)
✔ POST /consent creates a new principal unauthenticated, but refuses to update an existing one (755.92ms)
✔ a 409 on POST /consent writes nothing - the stored PII and the ledger are unchanged (773.09ms)
✔ the 409 does not lock out a household sharing one handset
✔ PUT /consent updates the session principal, and cannot reach another principal by email (777.75ms)
✔ an async resolvePrincipal is awaited - a Promise must not be read as an invalid id (754.84ms)
✔ a form posting one ticked checkbox is accepted, and an all-unchecked one records declines (762.14ms)
✔ escalateToBoard refuses a refId belonging to another principal (782.39ms)
✔ an AppError carrying a 500 does not echo its message (586.94ms)
✔ a mongoose cast failure is a 400 naming the field, not a 500 and not the raw value (774.26ms)
ℹ pass 12
ℹ fail 0
```

### Full suite

```
$ npm test
ℹ tests 77
ℹ pass 77
ℹ fail 0
ℹ duration_ms 27265
```

Baseline was 65/65 in ~25s. All 65 still pass; 12 new. Wall clock ~27.5s.

**One flake seen.** On one run, `principalId in the request body is ignored` failed with
`Error: Port "55335" already in use` from `MongoInstance.checkErrorInLine` - `mongodb-memory-server`
failing to bind before any library code runs. Three consecutive re-runs were 77/77 clean. See
Concerns.

---

## Files changed

| File | Change |
| --- | --- |
| `src/http/router.js` | Rewritten. Auth middleware, route table, body normalisation, error mapper. |
| `src/services/complaintToTheBoard.js` | `AppError` + validation; `escalateToBoard` ownership check (M8). |
| `src/services/dataPrincipalRights.js` | `AppError` + validation on `exerciseRight`. |
| `src/services/consentManagerRequest.js` | `AppError` + validation. |
| `test/auth.test.js` | New, 12 tests. |

---

## Route table as implemented

| Route | Auth | Notes |
| --- | --- | --- |
| `POST /consent` | **Public, signup only** | `findPrincipalByContact` first; 409 before any write if a principal exists |
| `PUT /consent` | `requireAuth` | Loads by `req.principalId`; stored PII passed to the service; 403 on a contact mismatch; 409 if erased |
| `PUT /consent/withdraw` | `requireAuth` | Shared handler |
| `POST /consent/withdraw` | `requireAuth` | Same handler - a form cannot issue PUT |
| `GET /rights` | **Public** | Static catalog |
| `POST /rights/exercise` | `requireAuth` | |
| `GET /grievance/new` | **Public** | Static form |
| `POST /grievance` | `requireAuth` | |
| `POST /grievance/:refId/escalate` | `requireAuth` | Ownership compared in the service |
| `GET /consent-manager/new` | **Public** | Static form |
| `POST /consent-manager` | `requireAuth` | |

Not yet present, owned by later tasks: `GET /consent`, `GET /rights/requests`,
`GET /grievances`, `GET /consent-manager/requests` (T10); `GET /consent/new`,
`GET /consent/withdraw` (T13).

---

## Your two judgement questions

### 1. The 409 as an account-existence oracle

**I agree with your call.** Keep it. The reasoning that decides it for me is not the balance of
the three options you named - it is that on this endpoint the oracle is *not actually a new
disclosure*. `POST /consent` is a self-service signup form. Every signup form that enforces
unique emails tells you whether an address is registered, because it must: the alternatives are
to create a duplicate identity or to silently write to an existing one. You chose the only
remaining option.

Two things make it weaker here than the generic case:

- It confirms registration, not any attribute. `principalId` is random now (Task 4) and the
  409 body carries nothing about the existing principal.
- `findOrCreatePrincipal` already throws a 409 with a *more* specific message ("That email is
  already registered to another data principal") on the unique-index race, so the oracle
  existed in the codebase regardless.

What I would do instead, if you ever want it closed, is the standard pattern and it is not a
router change: make `POST /consent` always return `202` with a neutral body, and send the
outcome by email - a receipt for a new registration, a "someone tried to sign up with your
address, sign in to change your consent" for an existing one. That closes the oracle
completely. It also requires an email channel this library does not have and should not grow,
so it belongs in the host application's signup flow, with this route reserved for API clients
that have already authenticated the address. Not worth doing on this branch.

One caveat worth recording, which is a *different* limit and not the oracle: two people who
share a handset and register with **no email at all** will collide, because with no email the
matching rule falls back to `phoneHash` and the second person gets a 409. That follows from
Task 4's documented "a phone number is not a person" rule, and the 409 is still better than the
alternative it replaced (silently returning the first person's record and overwriting their
PII). I added a test proving the mainstream household case - shared phone, *distinct* emails -
still registers both people, since that is the one the plan explicitly warns the existence
check could break.

### 2. Does any sub-500 `AppError` leak something a caller should not see?

**No.** I enumerated every `AppError` throw site in `src/`:

| Status | Site | Message safe to echo? |
| --- | --- | --- |
| 400 | `validate.js` x3, `withdrawConsent.js`, `persistPIIwithconsent.js` x2, `principalId.js` (pii.email/pii.phone type) | Yes - all describe the caller's own payload |
| 403 | `complaintToTheBoard.js`, router `assertOwnContact` | Yes |
| 404 | `withdrawConsent.js`, `principalId.js`, `erasure.js`, `complaintToTheBoard.js` | Yes |
| 409 | `principalId.js` x3, `complaintToTheBoard.js`, router | Existence oracle only - see above |
| 422 | `persistPIIwithconsent.js` (parental consent) | Yes |
| **500** | `principalId.js` (`PRINCIPAL_ID_SECRET`), `db/connection.js` (`MONGO_URI`) | **No - and both are correctly above the threshold, so the mapper suppresses them** |

The two dangerous messages are exactly the two at 500, which is what makes the mapper's branch
order load-bearing rather than stylistic. I proved the reachable one: `test/auth.test.js`
deletes `PRINCIPAL_ID_SECRET`, posts to the unauthenticated `POST /consent`, and asserts the
response is `{"error":"internal error"}` with no match for `/PRINCIPAL_ID_SECRET|openssl/`,
while still asserting the detail was logged server-side.

One adjacent leak the mapper closes that is not an `AppError` at all: mongoose's
`ValidationError` message quotes the offending value back
(`Cast to string failed for value "{ line1: 'x' }"`). The mapper sends only
`Invalid value for: pii.address`, and the test asserts the submitted value does not appear.

---

## Self-review findings

| Check | Result |
| --- | --- |
| Any route reading `principalId` from `req.body`/`req.query`? | **No.** `grep -rn "body\.principalId\|query\.principalId\|req\.query" src/` returns nothing. Every `req.body` read in the router is a named field or goes through `readPii`/`readConsentTypes`/`asArray`. |
| Does a 409 really leave the record untouched? | **Asserted, not assumed.** The test snapshots the `Principal` and `ConsentRecord` documents with `.lean()` before and after and compares `JSON.stringify` of each, plus `countDocuments() === 1`. |
| Can an authenticated principal reach another's record via `PUT /consent`? | **No.** Test signs in as Bhim, submits Asha's email, asserts 403, then asserts Asha's stored `pii.name` is unchanged and no event was appended to her ledger. |
| Does an async `resolvePrincipal` work? | **Yes**, test uses a hook that awaits a timer before returning, and asserts a 200 withdrawal. |
| Single-checkbox form? | **Yes**, 201 with `state.marketing.status === "granted"`. |
| All-unchecked form records declines? | **Yes**, `denied` for both optional purposes with the `consentSubmitted` marker - and the test also asserts that *without* the marker it stays a PII-only update (`state.marketing === undefined`), so the service's omission/decline distinction survives the router. |
| Does a 500 `AppError` leak? | **No** - asserted, see above. |
| Test output pristine? | **Yes.** `npm test` output is only the npm banner and `✔`/`ℹ` lines. The 500 test stubs `console.error` so the mapper's deliberate log does not pollute the run, and asserts it fired. |
| Em or en dashes? | **None** in `src/http/router.js`, `test/auth.test.js`, or any line I added to the three services. Pre-existing em dashes in untouched docstrings were left alone per the surgical-changes rule. |
| `git add -A`? | **Not used.** Five explicit paths staged. |

Two things I checked and deliberately did *not* change:

- `principal.pii.toObject()` in `PUT /consent` is unguarded. I probed mongoose 8.24 directly:
  a nested path is always materialised with a working `toObject`, even on a document created
  with no `pii` at all. A guard would be dead code.
- `assertOwnContact` compares against the session principal's own stored hash rather than
  looking the supplied contact up. That refuses a mismatched email without a second query and
  without adding another way to probe which addresses are registered.

---

## Concerns

1. **`examples/server.js` is now definitively broken.** It calls `createRouter()` with no
   arguments, which throws `db is required`. It was already broken by Task 3 (the services
   needed `models`), but this makes it fail at construction instead of at request time. Task 14
   owns that file. Flagging so it is not discovered as a surprise.

2. **The `README.md` still documents the C1 behaviour.** Lines 45-51 show `createRouter` and
   line 66-67 (per the spec) tell integrators that `principalId` is derived from the email and
   should be saved client-side. That guidance is now both wrong and unsafe. I did not touch it -
   the docs task owns it - but it should not ship in this state.

3. **Suite flakiness scales with test count.** Each `withDb` boots a fresh `mongod`, and I added
   12 more boots. I saw one `Port "..." already in use` failure in five full runs; three
   consecutive re-runs were clean. It is a `mongodb-memory-server` bind race, not a logic
   failure, but the suite will get flakier as later tasks add tests. A shared server per file
   would fix it. Out of scope here; worth a task.

4. **`escalateToBoard` returns 403 rather than 404 for a grievance that exists but is not
   yours.** That is what the brief's Step 4 code and its test specify, so I implemented it, but
   the brief's own comment on that line reads "Do not reveal whether the reference exists for
   someone else" - which is what a 404 would do, not a 403. I wrote a truthful comment instead
   of the contradictory one and kept the 403. The practical exposure is small now that `refId`
   carries 64 bits of entropy (Task 2 widened it), so guessing a reference to probe is not a
   real oracle. If you would rather it be a 404, it is a one-line change and one test line.

5. **No CSRF protection, and `POST /consent/withdraw` exists precisely so a browser form can
   reach it.** Once the host wires a cookie session into `resolvePrincipal`, every mutating
   route becomes CSRF-reachable, and withdrawal writes to an append-only ledger that by design
   cannot be undone. This is out of scope for Task 5 and the spec notes it under the C1
   follow-ups, but it is the most serious remaining gap in the HTTP layer and it is *created*
   by making auth work. It needs an owner before the browser surface (T13) ships.
