# Task 12 report - HTTP layer: negotiation, errors, config validation, hooks

**Status:** DONE_WITH_CONCERNS
**Commit:** `e52eb7f` - `fix: correct content negotiation, form actions, config guards, and CSRF exposure`
**Branch:** `fix/dpdp-audit-remediation`
**Findings closed:** H5, H7, M1, M2, M11, L2, and the CSRF gap Task 5 opened. M6 verified, not re-implemented.

---

## 1. What I implemented

### H5 - content negotiation

New `src/http/negotiate.js` exporting `wantsHtml(req)`, which is
`req.accepts(["json", "html"]) === "html"`. Listing `json` first makes it win the
wildcard tie-break, so `Accept: */*` - what curl and `fetch` send by default -
resolves to JSON.

All four negotiating routes now use it, replacing `req.accepts("html")`:

| Route | Before, with `Accept: */*` | After |
|---|---|---|
| `GET /rights` | 200 HTML page | 200 JSON catalog |
| `POST /rights/exercise` | 200 HTML fragment | 201 JSON |
| `POST /grievance` | 200 HTML fragment | 201 JSON |
| `POST /consent-manager` | 200 HTML fragment | 201 JSON |

`grep -n "req.accepts" src/http/*.js` now returns hits only inside
`negotiate.js`, so there is no second negotiation idiom left in the codebase.

I also gave the HTML branches the same status as the JSON branches (`201` where
something was created). A browser is not a reason to report 200 for a creation,
and the asymmetry would have been a second, quieter version of the same bug.

`GET /grievance/new` and `GET /consent-manager/new` deliberately still return
HTML unconditionally - they are pages, not negotiated resources.

### The CSRF gap Task 5 created

`checkOrigin` in `src/http/router.js`, registered with `router.use(checkOrigin)`
**before every route and before `requireAuth`**, so a forged request is refused
without the session ever being consulted. Implemented as the brief specifies:
skip `GET`/`HEAD`; absent `Origin` **and** `Referer` means allow; an
unparseable origin is 403; otherwise compare hosts against `allowedOrigins`, or
against `req.get("host")` when that list is empty.

`createRouter` gains `allowedOrigins` (default `[]`), validated at boot as an
array of strings so a typo fails loudly rather than silently disabling the
check via `"https://x".length` being truthy.

### M11, L2 - configuration validation

`assertConfigured()` in `src/config/catalog.js`, called by `createRouter`
before it builds a single route:

- `FIDUCIARY_DPO_EMAIL` unset or still `dpo@example.com` throws.
- `GRIEVANCE_SLA_DAYS` not a positive integer throws.
- `RIGHTS_SLA_DAYS` not a positive integer throws - **this one is beyond the
  brief**, see Deviations.

### M1 - mount-relative forms, plus `escapeHtml`

`renderRightsPage`, `renderGrievanceForm` and `renderConsentManagerForm` now
take `{ basePath }` and build every `action` from it; the router passes
`req.baseUrl`. Mounted at `/`, express reports `req.baseUrl` as `""`, so the
actions stay `/rights/exercise` with no special case - covered by its own test.

`escapeHtml` is exported from `forms.js` and applied to every interpolated
value in all three templates and in the router's three HTML response
fragments. Nothing reaching them is attacker-controlled today; the point is
that T13 adds user-supplied fields and an escaper retrofitted afterwards is one
somebody forgets on a single line.

### H7 - grievance copy

`complaintToTheBoard`'s `note` is now "This grievance has been recorded and
assigned to `<name>`'s Grievance Officer (`<dpoName>`). If it is not resolved by
`<YYYY-MM-DD>`, you may escalate it to the Data Protection Board." It also now
names the SLA *date*, which the old copy referred to as "the SLA date" without
ever stating it - the one fact a principal needs in order to escalate.

The router's HTML branch said `Sent to ...`; it now says `Recorded for ...` with
the same due date. The grievance form's submit button said "Send to the
Grievance Officer"; it now says "File this grievance".

### M2 - README signature drift

`README.md`: `escalateToBoard(refId)` corrected to
`escalateToBoard({ refId, principalId })`, and the full JSDoc `@param` block
added to the function in `complaintToTheBoard.js`.

I also added two README sections: **Configuration is checked at boot** and
**Cross-site request forgery**. The latter says plainly that hosts must still
set `SameSite=Lax`/`Strict` on their session cookie and that this library
cannot issue CSRF tokens, rather than implying the origin check alone suffices.

### The two carry-along items

- **`slaDueAt` in the rights-request projections.** Added to both
  `listRightsRequests` and `getRightsRequest` in `dataPrincipalRights.js`, with
  a test. Same class as the `resolution` gap Task 11 closed: the due date is
  exactly what tells a principal their request is overdue.
- **`onGrievanceFiled`'s try/catch had no test.** Now it does - a throwing hook
  must still yield 201, a `GR-` refId, and a grievance that actually resolves
  when looked up by that refId.

### M6 - verified, not re-implemented

Exactly one error middleware exists (`src/http/router.js:503`, the 4-argument
`router.use`), registered after every route. I did not add a second.
`grep -n "catch" src/http/router.js` finds four catch blocks: two inside
`checkOrigin` (URL parsing, both 403), one in `requireAuth` (401), and the
deliberate non-fatal `onGrievanceFiled` one. **No per-route catch swallows a
fault into a `res.status(400)`** - the only `res.status(400)` in the file is
inside the mapper itself.

---

## 2. TDD evidence

`test/http.test.js` written first, at 18 tests (the brief's 7, plus 11 for the
CSRF work, the negotiation sweep, the root-mount case, the SLA guard, the hook,
and the projection).

**Run before implementation** - `node --test test/http.test.js`:

```
ℹ tests 18
ℹ pass 7
ℹ fail 11
```

Failing exactly where expected: negotiation (2), mount path (1), error mapping
(1), origin check (3), config guards (2), copy (1), projection (1). The 7 that
passed were the ones asserting behaviour that already held - HTML for a browser,
400 for a validation error, root-mounted actions, the no-Origin case, GET
passthrough, same-origin success, and the untested-but-working
`onGrievanceFiled` catch.

**Run after implementation:**

```
ℹ tests 18
ℹ pass 18
ℹ fail 0
ℹ duration_ms 5936.88
```

One failure was a real defect **in the brief's own test**, not in the
implementation - see Deviations.

---

## 3. Full-suite result

```
$ npm test
ℹ tests 131
ℹ suites 0
ℹ pass 131
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 22479.71

npm test  18.72s user 6.97s system 110% cpu 23.311 total
```

**113 baseline + 18 new = 131. All 113 pre-existing tests still pass.** Wall
clock 23.3s against a 20.6s baseline; the delta is this file's own mongod work.

Output is clean apart from two `console.error` lines that are the *point* of two
tests - the injected `onWithdrawal` fault reaching the mapper's server-side log,
and the injected `onGrievanceFiled` fault being logged and swallowed. Both prove
the logging path works. No warnings, no unhandled rejections, no phantom tests.

---

## 4. Files changed

| File | Change |
|---|---|
| `data-fiduciary-toolkit/src/http/negotiate.js` | **new** - `wantsHtml` |
| `data-fiduciary-toolkit/test/http.test.js` | **new** - 18 tests |
| `data-fiduciary-toolkit/src/http/router.js` | `checkOrigin` + `allowedOrigins`, `assertConfigured()` call, `wantsHtml` on 4 routes, `basePath` on 3 form routes, `escapeHtml` on 3 fragments, grievance copy |
| `data-fiduciary-toolkit/src/http/forms.js` | `escapeHtml`, `{ basePath }` on all three renderers, button copy |
| `data-fiduciary-toolkit/src/config/catalog.js` | `assertConfigured`, `assertPositiveInteger`, `PLACEHOLDER_EMAILS`, export |
| `data-fiduciary-toolkit/src/services/complaintToTheBoard.js` | `note` copy, `escalateToBoard` JSDoc |
| `data-fiduciary-toolkit/src/services/dataPrincipalRights.js` | `slaDueAt` in both projections |
| `data-fiduciary-toolkit/README.md` | `escalateToBoard` signature, boot-check section, CSRF/SameSite section |

Staged by explicit path. `git add -A` was not used.

---

## 5. Answers to the two judgement questions

### Q1: The origin check treats missing Origin *and* Referer as same-origin. Can an attacker suppress both, from a browser, on a state-changing request?

**No. The design is sound, and it is sound for a specific spec-level reason
worth writing down.**

The Fetch specification's "append a request `Origin` header" step returns early
**only for `GET` and `HEAD`**. For every other method the header is
*unconditionally appended*. Referrer policy does not remove it - it can only
change the *value* to the literal string `null`, which happens under
`no-referrer`, or under the default `strict-origin-when-cross-origin` on an
https to http downgrade, or under `same-origin` when cross-origin. The header is
never omitted.

A cross-site HTML form POST is a navigation request, mode `navigate`, not
`cors`, and it still carries `Origin` - the browser has no API that removes it.
JavaScript cannot set or delete `Origin`; it is a forbidden header name.

So the "no Origin and no Referer" branch is **unreachable from a browser on a
state-changing method**. It is reachable only by curl and server-to-server
clients, which is exactly the intent, and which is why it does not weaken the
control: those clients have no ambient credential to ride.

**The one thing that had to be right, and I tested it:** `Origin: null` is a
*value*, not an absent header. `req.get("origin")` returns the truthy string
`"null"`, so control does **not** fall through to the allow branch - it reaches
`new URL("null")`, which throws, and the request is refused with 403. Treating
`null` as "no origin" would have reopened the entire hole via a sandboxed iframe
or a redirected cross-origin POST. `test/http.test.js` asserts this explicitly,
including that the ledger stays empty.

Residual weaknesses, none of which the missing-header branch causes:

1. **Only the host is compared, not the scheme.** An attacker with a plaintext
   `http://` foothold on the same hostname could forge against the `https://`
   site. Comparing schemes needs `req.protocol`, which depends on the host's
   `trust proxy` setting - something this library does not own. Documented in
   the code comment; `allowedOrigins` is the escape hatch for anyone who needs
   scheme-exact matching.
2. **`req.get("host")` behind a proxy.** A reverse proxy that rewrites `Host`
   to an internal name makes every browser POST 403. Loud, not silent, and
   fixed with `allowedOrigins`. Called out in the README.

### Q2: Should `assertConfigured()` throw at `createRouter()` time, or warn loudly?

**Throw. I agree with your choice, and I would not soften it.**

Compare the two failure modes:

- **Throw:** the process dies at boot, before `listen()`. Every orchestrator -
  systemd, Kubernetes, a PaaS health check - surfaces this within seconds, and a
  rolling deploy will not replace a working instance with a broken one. Fixed by
  setting one environment variable.
- **Warn:** the service starts and serves a grievance page telling data
  principals to write to `dpo@example.com`. The fiduciary appears to have
  published Grievance Officer contact details. Nobody reads that mailbox. The
  complaints are lost, the SLA clock the toolkit starts is meaningless, and
  nothing distinguishes this state from a working one until a principal tries to
  escalate. A startup warning in a log stream nobody greps is not a control.

The asymmetry is the whole argument: the throw fails *loudly and early*, the
warning fails *silently and in front of the data principal*. That is the
Global Constraint - "a placeholder default that would be shown to a data
principal must fail startup instead" - and it is right.

The SLA case is if anything stronger. `Number("seven")` is `NaN`, so `slaDueAt`
becomes an Invalid Date, the `RightsRequest`/`Grievance` schema rejects it on
save, and *every* filing fails - at the exact moment someone is trying to
complain. Failing at boot converts a 100% runtime failure rate into a config
error the operator sees before any traffic arrives.

One real cost, which I want on the record: **this is a breaking change for
existing adopters.** Anyone running 0.2.0 who left the placeholder in place has
a service that boots today and will not boot after upgrading. That is correct
behaviour - they were non-compliant and did not know - but it needs a changelog
entry and a minor-version bump at minimum. `.env.example` already documented the
refusal before I got here; the README now does too.

---

## 6. Deviations from the brief

1. **The brief's fault-injection test was broken as written, and I fixed it.**
   It seeds `persistPIIwithconsent({ ..., consentTypes: [] })`, so `marketing`
   is recorded as **denied**, never granted. `withdrawConsent` then classifies
   the withdrawal as `noChange`, never saves, and **never calls
   `onWithdrawal`** - so the fault is never injected and the route returns 200,
   not 500. Changed the seed to `["marketing"]` with a comment explaining why.
   The test now genuinely exercises the mapper. Verified: it failed before the
   fix for this reason, and passes after.

2. **`RIGHTS_SLA_DAYS` is validated too.** The brief names only
   `GRIEVANCE_SLA_DAYS`. `RIGHTS_SLA_DAYS` has the byte-identical defect -
   `exerciseRight` builds `slaDueAt` from it and an Invalid Date fails the
   schema on save - and fixing one of two identical defects in an audit
   remediation is arbitrary. Three lines, shared helper, same error text shape.

3. **Two pre-existing em dashes removed**, in `complaintToTheBoard.js:9` and
   `dataPrincipalRights.js:6` - both in files this commit already changes. See
   Concerns for the ones I left alone.

4. **`boot()` in the test file takes an options object** rather than the
   brief's positional `basePath`, so tests can supply `allowedOrigins` and host
   hooks. Behaviourally identical for the brief's own cases.

---

## 7. Self-review checklist

| Check | Result |
|---|---|
| Cross-origin withdrawal leaves the ledger untouched? | **Yes, asserted.** The test reads `ConsentRecord.events` before and after, asserts the length is unchanged **and** that zero events have `status: "withdrawn"` - not just the 403. |
| Default `curl` gets JSON with the documented status from every negotiating route? | **Yes.** One test sweeps `GET /rights`, `POST /grievance`, `POST /consent-manager` with no `Accept` header, plus the brief's `POST /rights/exercise` test. All JSON, 201 where created. |
| Forms work mounted at `/compliance/dpdp`? | **Yes**, and all three are asserted, not just the rights page. A second test covers the root mount, where `req.baseUrl` is `""`. |
| `createRouter` refuses the placeholder DPO email? | **Yes**, plus a second test for the non-integer SLA. |
| Exactly one error middleware? | **Yes** - one 4-arg `router.use` at line 503, registered last. No per-route catch swallows into a 400. |
| Test output pristine? | **Yes** - 131/131, no warnings, no unhandled rejections. Two `console.error` lines are the deliberate injected faults being logged, which is what two of the tests exist to prove. |
| Any em dash or en dash introduced? | **None.** `grep '—\|–'` over every changed file and over the added README lines returns nothing. |

---

## 8. Concerns

1. **`allowedOrigins` replaces the same-host default rather than adding to it.**
   The brief specifies this and I implemented it as specified, but it is a
   footgun: an operator who adds one partner origin silently loses same-origin
   acceptance and their own forms start 403ing. The failure is loud and
   immediate (you notice in the first browser click) and there is no security
   loss either way, so I did not deviate - but **union semantics, where the
   same host is always allowed and the list is additive, would be strictly
   safer and less surprising**, and I would take that change if you want it. I
   documented the replace behaviour in both the JSDoc and the README.

2. **Only the host is compared, not the scheme.** Detailed under Q1. Acceptable
   given `req.protocol` depends on the host's `trust proxy` setting, but worth a
   line in whatever hardening notes the plan ends with.

3. **`assertConfigured()` is a breaking change for existing adopters.** Detailed
   under Q2. Needs a changelog entry and a version bump - I did not touch
   `package.json`, since I do not know which task owns the release.

4. **The forms still carry `<input name="principalId" required />`.** Left
   deliberately: Task 13's own test asserts these fields are *gone*, so removing
   them here would be taking Task 13's work. Flagging only so nobody reads it as
   an oversight - as of this commit, a browser user genuinely cannot submit the
   grievance form, because the field is `required` and inert.

5. **`escapeHtml` is applied but not yet load-bearing.** No value reaching those
   templates is attacker-controlled at this commit. It exists so that T13's
   user-supplied fields land in an already-escaped template rather than
   requiring an escaper to be remembered. If T13 adds interpolation, it must use
   it - worth calling out in that task's review.

6. **Em dashes remain elsewhere in the package**, in files this task had no
   reason to open: `README.md` (15), `src/index.js` (1),
   `src/models/ConsentManagerRequest.js` (1),
   `src/services/consentManagerRequest.js` (1). A repo-wide sweep belongs to
   whichever task owns the documentation pass, not here.

7. **`POST /consent-manager`'s form button still says "Send request".** I fixed
   the grievance copy because H7 is about a *response* making a factual claim
   about delivery. "Send request" on a submit button is ordinary form language
   and no reader concludes an email was sent, so I drew the line there. If you
   want the consent-manager surface held to the same standard, it is a one-word
   change.
