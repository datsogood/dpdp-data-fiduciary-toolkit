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

// The first configured language is the default shown when a caller states
// none. Not hardcoded to "en" - a deployment that configures NOTICE_LANGUAGES
// without "en" would otherwise have every default-language notice throw.
const DEFAULT_NOTICE_LANGUAGE = SUPPORTED_NOTICE_LANGUAGES[0];

function buildNotice({ language = DEFAULT_NOTICE_LANGUAGE } = {}) {
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
    // Rule 3(b)(i) - an itemised description of the personal data, not just
    // the purposes it is used for.
    personalData: [
      { field: "name", description: "Your full name" },
      { field: "email", description: "Your email address" },
      { field: "phone", description: "Your mobile number" },
      { field: "dob", description: "Your date of birth" },
      { field: "pan", description: "Your PAN, where we are required to collect it" },
      { field: "address", description: "Your postal address" },
    ],
    rights: RIGHTS_CATALOG.map((r) => ({ key: r.key, title: r.title, section: r.section, description: r.description })),
    // Rule 3(c)(i) - how to withdraw, with ease comparable to giving consent.
    withdrawal: {
      description: "You can withdraw consent for any consent-based purpose at any time, as easily as you gave it.",
      path: "/consent/withdraw",
    },
    grievance: {
      route: "Raise it with our Grievance Officer first. If it is not resolved within the stated period, you may complain to the Data Protection Board.",
      slaDays: FIDUCIARY.grievanceSlaDays,
    },
    // Section 5(1)(iii) - the manner of complaining to the Board.
    boardComplaint: {
      description:
        "Raise it with our Grievance Officer first. If it is not resolved within the stated period, you may complain to the Data Protection Board of India directly.",
      grievancePath: "/grievance/new",
    },
    dpo: { name: FIDUCIARY.dpoName, email: FIDUCIARY.dpoEmail },
    statute: "Digital Personal Data Protection Act, 2023",
  };

  // Content-addressed version: the same catalog and config always produce the
  // same version, and any change to what we tell people produces a new one.
  const version = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { ...body, version, generatedAt: new Date() };
}

module.exports = { buildNotice, SUPPORTED_NOTICE_LANGUAGES, DEFAULT_NOTICE_LANGUAGE, EIGHTH_SCHEDULE };
