require("dotenv").config();

// ---------------------------------------------------------------------------
// Identity of the organisation using this toolkit. Swap via env vars - never
// hardcode a real org's details in source.
// ---------------------------------------------------------------------------
const FIDUCIARY = {
  name: process.env.FIDUCIARY_NAME || "Kavach Finance",
  dpoName: process.env.FIDUCIARY_DPO_NAME || "Data Protection Officer",
  dpoEmail: process.env.FIDUCIARY_DPO_EMAIL || "dpo@example.com",
  grievanceSlaDays: Number(process.env.GRIEVANCE_SLA_DAYS || 7),
  rightsSlaDays: Number(process.env.RIGHTS_SLA_DAYS || 30),
};

// A DPO address that is a placeholder is worse than no address at all: the
// grievance page renders it to data principals, so the fiduciary looks like it
// has published Grievance Officer contact details while every complaint sent
// there goes nowhere.
//
// No "" entry: FIDUCIARY.dpoEmail already collapses an unset or empty env var
// to the placeholder via `||`, so listing "" here would read as coverage that
// nothing can reach. The shape check below is what catches the values that
// ARE reachable and just as useless - " ", "tbd", "not-an-email".
const PLACEHOLDER_EMAILS = ["dpo@example.com"];

// Deliberately NOT RFC 5322. That grammar accepts addresses no mail system
// routes, and wrongly rejecting a real Grievance Officer's address would be a
// worse failure than letting an odd one through. This catches the shapes that
// actually get committed to a .env: blank, no domain, no dot in the domain,
// stray whitespace from a copy-paste.
const PLAUSIBLE_EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function assertPositiveInteger(value, envName) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${envName} must be a positive integer, got: ${process.env[envName]}`);
  }
}

/**
 * Fails fast on configuration that would be shown to a data principal, and on
 * the two settings whose absence only surfaces mid-request.
 *
 * A grievance page telling people to contact dpo@example.com fails the duty
 * to publish valid Grievance Officer contact details while looking like it
 * satisfies it - so this is a startup error, not a warning. Likewise a
 * non-integer SLA: Number("seven") is NaN, which makes every slaDueAt an
 * Invalid Date and fails every grievance at the moment someone tries to file
 * one. Failing to boot is loud, immediate, and fixed by one env var; the
 * alternative fails silently, in front of the data principal.
 *
 * Called by createRouter, so a misconfigured deployment never reaches listen().
 */
function assertConfigured() {
  if (PLACEHOLDER_EMAILS.includes(FIDUCIARY.dpoEmail)) {
    throw new Error(
      "FIDUCIARY_DPO_EMAIL is unset or still the placeholder (dpo@example.com). " +
        "The Act requires published, valid Grievance Officer contact details - set it before serving traffic."
    );
  }
  // Not a placeholder, but not an address either. A grievance page publishing
  // "tbd" satisfies the duty exactly as little as one publishing example.com.
  if (!PLAUSIBLE_EMAIL.test(FIDUCIARY.dpoEmail)) {
    throw new Error(
      `FIDUCIARY_DPO_EMAIL does not look like an email address, got: ${JSON.stringify(FIDUCIARY.dpoEmail)}. ` +
        "It is published to data principals as the Grievance Officer contact, so it has to be reachable."
    );
  }
  assertPositiveInteger(FIDUCIARY.grievanceSlaDays, "GRIEVANCE_SLA_DAYS");
  // Same defect, same consequence: exerciseRight builds slaDueAt from this,
  // and an Invalid Date fails the RightsRequest schema on save.
  assertPositiveInteger(FIDUCIARY.rightsSlaDays, "RIGHTS_SLA_DAYS");

  // The one required secret this function did not check, while .env.example
  // ships it EMPTY and the README tells you to copy that file. Left unset the
  // router builds fine, health checks pass and GET /consent/new renders - and
  // the FIRST POST /consent returns 500, because lookupHash throws. Exactly
  // the failure mode the paragraph above rejects for the DPO address: silent
  // at boot, loud in front of a data principal, fixed by one env var.
  //
  // Read from the environment rather than from FIDUCIARY: this is a secret,
  // and it has no business sitting in an object the toolkit exports for
  // introspection. The floor matches utils/principalId.js's own secret().
  const secret = process.env.PRINCIPAL_ID_SECRET;
  if (typeof secret !== "string" || secret.trim().length < 32) {
    throw new Error(
      "PRINCIPAL_ID_SECRET is unset or shorter than 32 characters. It keys the lookup hash for every data " +
        "principal's email and phone, so a weak one is guessable and an absent one makes the first consent " +
        "submission fail with a 500. Generate one with: openssl rand -hex 32"
    );
  }

  // Required lazily, INSIDE the function, on purpose: config/notice.js
  // requires this module at load time, so a top-level require here would be
  // circular and leave notice.js destructuring a half-built exports object.
  // By the time createRouter calls this, both modules are fully loaded.
  const { SUPPORTED_NOTICE_LANGUAGES } = require("./notice");
  const untranslated = SUPPORTED_NOTICE_LANGUAGES.filter((lang) => lang !== "en");
  if (untranslated.length) {
    throw new Error(
      `NOTICE_LANGUAGES names ${untranslated.join(", ")}, but only "en" has a notice catalog in this toolkit. ` +
        "buildNotice validates the language and stamps it onto the body, while every string still comes from " +
        "the single English catalog - so a request for another language returns an ENGLISH notice labelled as " +
        "that language, stored under its own content hash and referenced by every consent event written under " +
        "it. That manufactures affirmative false evidence of Section 5(3) compliance on an append-only ledger. " +
        "Remove it, or register a translated catalog for it first."
    );
  }
}

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
    prohibitedForChildren: false,
    retentionMonths: 60,
  },
  {
    type: "marketing",
    title: "Marketing and personalised offers",
    purpose: "Telling you about products we think you will want.",
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true,
    // Behavioural advertising to a child is exactly what Section 9 restricts
    // - so this purpose must be an explicit false-by-decision, not a
    // false-by-accident omission that Task 9's branching would silently trust.
    prohibitedForChildren: true,
    retentionMonths: 24,
  },
  {
    type: "analytics",
    title: "Product analytics and improvement",
    purpose: "Understanding how our product is used so we can improve it.",
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true,
    // Same reasoning as marketing: profiling usage patterns is the kind of
    // monitoring Section 9 keeps away from a child's data.
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

// ---------------------------------------------------------------------------
// Rights catalog - Chapter III, DPDP Act 2023.
// ---------------------------------------------------------------------------
const RIGHTS_CATALOG = [
  { key: "access", title: "Right to access information", section: "Section 11",
    description: "Get a summary of the personal data we hold about you, what we are doing with it, and who we have shared it with." },
  { key: "correction", title: "Right to correction and completion", section: "Section 12",
    description: "Ask us to correct inaccurate personal data, complete what is incomplete, or update what is out of date." },
  { key: "erasure", title: "Right to erasure", section: "Section 12",
    description: "Ask us to delete the personal data we hold about you. We must comply unless the law requires us to keep it - we will tell you which, and why." },
  { key: "nominate", title: "Right to nominate", section: "Section 14",
    description: "Name someone to exercise these rights on your behalf if you die or become incapacitated." },
  { key: "withdrawal", title: "Right to withdraw consent", section: "Section 6(4)",
    description: "Withdraw your consent for any consent-based purpose at any time, as easily as you gave it." },
  { key: "grievance", title: "Right to grievance redressal", section: "Section 13",
    description: "Raise a complaint with our Grievance Officer. If it is not resolved in time, you may complain to the Data Protection Board." },
];

// The DPO contact, for a response that tells a data principal who to reach
// after exercising a right or withdrawing consent (L6).
const contactBlock = () => ({ dpoName: FIDUCIARY.dpoName, dpoEmail: FIDUCIARY.dpoEmail });

module.exports = {
  FIDUCIARY,
  assertConfigured,
  contactBlock,
  // Functions - always read the catalog live, so a runtime customisation is
  // reflected immediately rather than needing a process restart (M3).
  getCatalog,
  getValidConsentTypes,
  getWithdrawableTypes,
  getConsentBasedTypes,
  getCatalogEntry,
  // Backwards compatibility with src/index.js and other direct consumers.
  CONSENT_CATALOG,
  RIGHTS_CATALOG,
};
