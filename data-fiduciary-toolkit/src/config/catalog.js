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
};

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
    retentionMonths: 24,
  },
  {
    type: "analytics",
    title: "Product analytics and improvement",
    purpose: "Understanding how our product is used so we can improve it.",
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true,
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
  { key: "grievance", title: "Right to grievance redressal", section: "Section 13",
    description: "Raise a complaint with our Grievance Officer. If it is not resolved in time, you may complain to the Data Protection Board." },
];

module.exports = {
  FIDUCIARY,
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
