# 0002 - PII-keyed retrieval ships as an unmounted function plus a separate back-office router

Date: 2026-09-04
Status: Accepted
Context: [issue #4](https://github.com/datsogood/dpdp-data-fiduciary-toolkit/issues/4), [design spec](../superpowers/plans/2026-09-04-consent-audit-trail/spec.md) sections 8.3 and 8.4

## Context

Issue #4 asks for a "GET API to retrieve the consent, given a direct PII". Taken
literally that is `GET /consent/audit?email=...`, and it collides with the rule
this codebase was rebuilt around. `src/utils/principalId.js` states it plainly:
**never infer identity from caller-supplied contact details.** That rule is the
C1 remediation, and `README.md` asserted it without qualification.

The collision is not only philosophical. A raw contact value in a URL lands in
access logs, browser history, `Referer` headers and CDN cache keys, none of which
`Cache-Control: no-store` reaches, because the cache *key* is the PII. `req.query`
is not governed by the router's `express.urlencoded({extended: false})` hardening -
that setting is app-level and this library cannot set it - so on an Express 4
host `?email[$ne]=` yields an operator object, reopening exactly the delivery
path `extended: false` was chosen to close. And `checkOrigin` exempts GET, so a
URL-borne lookup is reachable from a cross-site `<img>` or a prefetch.

Meanwhile the data principal does not need this. `GET /consent` already returns
their own state and full ledger, scoped to their session. A PII parameter on a
principal-facing route is either redundant (it must equal your own) or a
cross-principal read by construction. The only caller with a genuine need is
back-office staff answering a request that arrived by post, by phone, or at a
counter, holding an email rather than a 64-hex identifier.

## Decision

Two surfaces, and neither is on the principal-facing router.

**`findConsentTrailByContact({ models, email, phone })`** - exported from
`src/index.js`, deliberately mounted on nothing, in the same pattern the repo
already uses for `erasePrincipalPII`, `updatePrincipalContact` and
`findPrincipalByContact`. It keeps the phone branch and inherits
`findPrincipalByContact`'s 409-on-ambiguous-phone unchanged, because a direct
library caller is already inside the host's trust boundary.

**`createBackOfficeRouter({ db, resolveOperator, rateLimitedByHost })`** - a
*separate factory* from `createRouter`, so a people-search cannot be mounted on
the principal-facing router by a misconfigured `app.use`. The structural
separation is the control, not the documentation. Both its routes are POST:
`POST /principals/lookup` because raw PII must not enter a URL, and
`POST /principals/trail` because under ADR 0003 the read performs a write - the
access record - and a GET would make that write cross-site triggerable and
attributed to a signed-in operator.

The HTTP lookup is **email-only**. It refuses the phone branch that the library
function keeps, matching what `POST /consent` already does at signup. A phone
number identifies a household rather than a person, and the 409 "more than one
data principal" is itself a disclosure that two people share a handset.

The factory **refuses to build** without `rateLimitedByHost: true`, thrown as a
plain `Error` at construction the way `assertConfigured` throws. This ships a
read oracle over a guessable keyspace in a package that carries no rate limiting
by documented decision.

## Consequences

`principalId` is now read from a request body on exactly one route. That is a
named carve-out from a rule this branch otherwise treats as absolute, and the
README was rewritten to scope its claim to `createRouter`'s routes and to argue
the carve-out rather than mention it. It is sound because operator identity still
comes only from `resolveOperator(req)`; the operator is not the subject, so
naming a different id escalates nothing; `assertPrincipalId` runs before the
value reaches any filter; and every use is gated by operator authentication and a
fail-closed access record.

An erased principal is unreachable by PII, permanently and by design - erasure
unsets both lookup hashes. The retained pseudonymous ledger is therefore reachable
only by `principalId`, which is the other reason the trail read is id-keyed.

There is no contact-hash field on `TrailEntry` at all, and no task may add one. A
row carrying a hash beside a `principalId` would rebuild the email-to-person index
erasure exists to destroy, since the fiduciary holds `PRINCIPAL_ID_SECRET` and
could recompute the hash at any time. A hash on a lookup that matched nobody
would mint a permanent contact-derived identifier for a person who is not a data
principal of this fiduciary at all. An earlier draft enforced this with a schema
validator; that does not hold, because `updateOne` does not run document
validators and a later `$set` would co-store both silently. A field that does not
exist cannot be set.

## Alternatives rejected

**`GET` with the value in a query string or path segment.** The literal reading
of the issue. Rejected for the logging, history, `Referer`, cache-key,
query-parser and `checkOrigin` reasons above.

**A principal-facing PII lookup.** Redundant or cross-principal by construction,
and it would put a second identity source into a library whose entire
remediation narrative is that there is exactly one.

**Caller-supplied `lookupHash` instead of the raw value.** Requires sharing
`PRINCIPAL_ID_SECRET` with the caller, which is a worse trade than the problem it
solves.

**Mounting the back-office routes on `createRouter` behind a role check.** One
wrong `app.use` puts a people-search on the public mount. A separate factory
cannot be misconfigured that way.
