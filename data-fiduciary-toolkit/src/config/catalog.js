require("dotenv").config();

// ---------------------------------------------------------------------------
// Identity of the organisation using this toolkit. Swap via env vars — never
// hardcode a real org's details in source.
// ---------------------------------------------------------------------------
const FIDUCIARY = {
  name: process.env.FIDUCIARY_NAME || "Kavach Finance",
  dpoName: process.env.FIDUCIARY_DPO_NAME || "Data Protection Officer",
  dpoEmail: process.env.FIDUCIARY_DPO_EMAIL || "dpo@example.com",
  grievanceSlaDays: Number(process.env.GRIEVANCE_SLA_DAYS || 7),
};

// ---------------------------------------------------------------------------
// Consent catalog — the set of purposes this fiduciary processes data for.
// `required: true` means processing rests on a legal/contractual basis under
// Section 7, not consent, so it CANNOT be withdrawn while the relationship
// is active. Only `required: false` entries are eligible for withdrawal.
// A real deployment would likely load this from its own DB/config service
// rather than a source file, but the shape below is what the rest of the
// toolkit expects.
// ---------------------------------------------------------------------------
const CONSENT_CATALOG = [
  {
    type: "kyc",
    title: "Identity verification (KYC)",
    basis: "Legal obligation — Prevention of Money Laundering Act, 2002",
    required: true,
  },
  {
    type: "underwriting",
    title: "Loan underwriting & credit assessment",
    basis: "Necessary to perform your loan contract",
    required: true,
  },
  {
    type: "marketing",
    title: "Marketing & personalised offers",
    basis: "Your consent",
    required: false,
  },
  {
    type: "analytics",
    title: "Product analytics & improvement",
    basis: "Your consent",
    required: false,
  },
];

const REQUIRED_CONSENT_TYPES = CONSENT_CATALOG.filter((c) => c.required).map((c) => c.type);
const VALID_CONSENT_TYPES = CONSENT_CATALOG.map((c) => c.type);

// ---------------------------------------------------------------------------
// Rights catalog — Chapter III, DPDP Act 2023.
// ---------------------------------------------------------------------------
const RIGHTS_CATALOG = [
  {
    key: "access",
    title: "Right to access information",
    section: "Section 11",
    description: "Get a summary of what personal data we hold about you and who we've shared it with.",
  },
  {
    key: "correction",
    title: "Right to correction & completion",
    section: "Section 12",
    description: "Ask us to fix inaccurate or incomplete personal data.",
  },
  {
    key: "erasure",
    title: "Right to erasure",
    section: "Section 12",
    description: "Ask us to delete personal data no longer needed for the purposes it was collected for.",
  },
  {
    key: "nominate",
    title: "Right to nominate",
    section: "Section 14",
    description: "Name someone to exercise these rights on your behalf if you're incapacitated or pass away.",
  },
  {
    key: "grievance",
    title: "Right to grievance redressal",
    section: "Section 13",
    description: "Raise a complaint with our Grievance Officer, and escalate to the Data Protection Board if unresolved.",
  },
];

module.exports = {
  FIDUCIARY,
  CONSENT_CATALOG,
  REQUIRED_CONSENT_TYPES,
  VALID_CONSENT_TYPES,
  RIGHTS_CATALOG,
};
