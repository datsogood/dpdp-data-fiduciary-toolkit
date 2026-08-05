# dpdp-fiduciary-toolkit

A reference implementation of a data fiduciary's obligations under India's
Digital Personal Data Protection Act, 2025 (DPDP Act): capturing consent,
honouring withdrawal, letting a data principal exercise their rights, routing
grievances, and handing off to a Consent Manager.

The following is a summary of all the responsibilities of a data fiduciary (the organization collecting PII data) towards a data principal (the user) that we intend to codify as part of this toolkit - 

1. Consent needs to provided clearly to the Data Principal - across all languages.
2. Information to be provided to the Data Principal on the personal data collected, purpose for collection and how data will be processed.
3. Information to be provided to the Data Principal on how consent can be revoked, their rights can be exercised and complaints to the board can be raise.
4. Ease of consent withdrawal by a Data Principal should be the same as accepting consent.
5. Data Fiduciary shall ask data processors to cease processing the data principal's PII data, within reasonable time on consent revocation.
6. Data Principal may engage with a designated consent manager to liaise with a Data Fiduciary.
7. Audit trail of the consent should be available at any point in time.
8. Technical and organizational measures to ensure effective adherence of the policies
9. Data breaches to be intimated on time and mitigated promptly with established SLAs.
10. Prior collected personal data needs to be erased on revocation of consent. Data processor (3rd party data processing entity, if any) should also be intimated on the erasure of data.
11. Data Protection Officer contact should be provided and be valid at all times.
12. Consent from parents are required when personal data is collected, concerning children.
13. A signficant data fiduciary is one that has a huge public impact on the nature of the personal data that they're collecting. They should appoint a DPO and an independent data auditor. Periodic data protection impact assessment and audit needs to be performed.


Five service functions, each usable directly or via a pre-wired Express
router.

## Setup

```bash
npm install
cp .env.example .env   # set MONGO_URI and your org's identity
```

```js
const { connect, createRouter } = require("dpdp-fiduciary-toolkit");
const express = require("express");

await connect(process.env.MONGO_URI);
const app = express();
app.use("/", createRouter());
app.listen(4000);
```

Or run the bundled example: `npm run example` (needs a Mongo instance at
`MONGO_URI`).

## The five APIs

### 1. `persistPIIwithconsent` — `POST /consent`

Saves PII plus the consent choices made, timestamped, and confirms with a
receipt (`docRef`). Required purposes (KYC, underwriting — legal/contractual
basis) are always logged as granted; only optional purposes reflect what the
principal actually chose.

```js
POST /consent
{
  "pii": { "name": "Asha Rao", "email": "asha@example.com", "phone": "9876543210" },
  "consentTypes": ["marketing"]
}
→ 201 { docRef: "CN-...", principalId: "sha256...", events: [...], requiredPurposes: [...] }
```

`principalId` is derived from the email (SHA-256) — save it client-side, it's
what every other endpoint uses to find this person's records.

### 2. `withdrawConsent` — `PUT /consent/withdraw`

Appends a `withdrawn` event per purpose — it never edits or deletes history.
Attempting to withdraw a required (legal-basis) purpose is rejected with a
reason rather than silently ignored.

```js
PUT /consent/withdraw
{ "principalId": "sha256...", "consentTypes": ["marketing"] }
→ 200 { docRef, withdrawn: ["marketing"], rejected: [], effectiveFrom }
```

### 3. Data Principal Rights — `GET /rights`, `POST /rights/exercise`

`GET /rights` renders the rights page (Chapter III: access, correction,
erasure, nomination) as HTML for a browser, or JSON for an API client.
Submitting a request against one of them creates a trackable `refId`.

```js
POST /rights/exercise
{ "principalId": "sha256...", "right": "erasure", "details": "close my account" }
→ 201 { refId: "RQ-...", right: "erasure", status: "received" }
```

### 4. `complaintToTheBoard` — `GET /grievance/new`, `POST /grievance`

**Legal note:** under Section 13, a complaint must first go to the
fiduciary's own Grievance Officer — the Data Protection Board only hears it
if that's not resolved in time. So this opens a form addressed to your DPO
(set via `FIDUCIARY_DPO_NAME`/`FIDUCIARY_DPO_EMAIL`) and starts an SLA clock
(`GRIEVANCE_SLA_DAYS`, default 7). A separate `escalateToBoard(refId)` /
`POST /grievance/:refId/escalate` is provided for once that SLA lapses
unresolved — it's blocked from firing early.

```js
POST /grievance
{ "principalId": "sha256...", "subject": "Unwanted marketing calls", "description": "..." }
→ 201 { refId: "GR-...", addressedTo: "Meera Iyer, ...", slaDueAt, note }
```

### 5. `consentManagerRequest` — `GET /consent-manager/new`, `POST /consent-manager`

Opens a form to request being connected with a Consent Manager — the
independent, Board-registered entity under Section 6(7)-(9) that can manage
a principal's consent across services. This toolkit only logs and hands off
the request; it doesn't act as a Consent Manager itself.

```js
POST /consent-manager
{ "principalId": "sha256...", "message": "I'd like one consent manager for all my finance apps" }
→ 201 { refId: "CM-...", status: "received" }
```

## Data model

- **ConsentRecord** — one per principal, `events[]` is an append-only ledger
  (`{ type, status, basis, timestamp }`). Current state = latest event per
  type, via `record.currentState()`.
- **RightsRequest**, **Grievance**, **ConsentManagerRequest** — one document
  per request, all keyed by `principalId`.

## What this is not

- Not legal advice, and not a certified/audited compliance product — it's a
  structural reference for how the pieces fit together.
- PII is stored in plain fields for clarity. A production deployment should
  encrypt PII at rest (e.g. field-level encryption) and review what's
  actually necessary to retain.
- The consent/rights catalogs in `src/config/catalog.js` are a worked
  example (a fictional lender, "Kavach Finance") — replace them with your
  own purposes, retention periods, and DPO details before using this for
  real.
