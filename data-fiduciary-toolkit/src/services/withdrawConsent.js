const { CONSENT_CATALOG, REQUIRED_CONSENT_TYPES, VALID_CONSENT_TYPES } = require("../config/catalog");
const { assertPrincipalId, assertStringArray } = require("../utils/validate");
const { AppError } = require("../utils/errors");

const basisByType = Object.fromEntries(CONSENT_CATALOG.map((c) => [c.type, c.basis]));

/**
 * Withdraws consent for one or more purposes. This never deletes or
 * overwrites history — it appends a new 'withdrawn' event per type, dated
 * now, so the ledger always shows what was true and when. Required
 * (legal-basis) purposes cannot be withdrawn while the relationship is
 * active; attempting to do so is reported back rather than silently ignored.
 *
 * @param {object} input
 * @param {object} input.models - model registry, must include ConsentRecord
 * @param {string} input.principalId
 * @param {string[]} input.consentTypes - purposes to withdraw
 * @returns {Promise<{ docRef, withdrawn: string[], rejected: {type, reason}[] }>}
 */
async function withdrawConsent({ models, principalId, consentTypes } = {}) {
  assertPrincipalId(principalId);
  const types = assertStringArray(consentTypes, "consentTypes");
  if (!types.length) throw new AppError("consentTypes must include at least one purpose to withdraw", 400);

  const record = await models.ConsentRecord.findOne({ principalId });
  if (!record) throw new Error("No consent record found for this principal");

  const now = new Date();
  const withdrawn = [];
  const rejected = [];

  for (const type of consentTypes) {
    if (!VALID_CONSENT_TYPES.includes(type)) {
      rejected.push({ type, reason: "Unknown consent type" });
      continue;
    }
    if (REQUIRED_CONSENT_TYPES.includes(type)) {
      rejected.push({ type, reason: "This purpose rests on a legal/contractual basis and can't be withdrawn while the account is active" });
      continue;
    }
    record.events.push({ type, status: "withdrawn", basis: basisByType[type], timestamp: now });
    withdrawn.push(type);
  }

  record.updatedAt = now;
  await record.save();

  return { docRef: record.docRef, withdrawn, rejected, effectiveFrom: now };
}

module.exports = withdrawConsent;
