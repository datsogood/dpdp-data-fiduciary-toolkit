const { generateDocRef } = require("../utils/principalId");
const { assertPrincipalId, assertNonEmptyString } = require("../utils/validate");

/**
 * Raises a request to speak to / be connected with a Consent Manager — a
 * separate, Board-registered entity under Section 6(7)-(9) through which a
 * data principal can manage consent across multiple fiduciaries. This
 * toolkit only logs the request and hands it off; it does not itself act
 * as a Consent Manager.
 *
 * @param {object} input
 * @param {object} input.models - model registry, must include ConsentManagerRequest
 * @param {string} input.principalId
 * @param {string} input.message
 * @param {string} [input.preferredConsentManager]
 * @returns {Promise<{ refId, status }>}
 */
async function consentManagerRequest({ models, principalId, message, preferredConsentManager = "" } = {}) {
  // AppError, not Error: a plain Error has no .status, so the router's error
  // mapper would report a malformed request as 500 "internal error". The
  // lengths match the schema's maxlength, so a value that would fail
  // validation on save is refused here with a message that names the field.
  assertPrincipalId(principalId);
  assertNonEmptyString(message, "message", 5000);
  if (preferredConsentManager) assertNonEmptyString(preferredConsentManager, "preferredConsentManager", 200);

  const request = await models.ConsentManagerRequest.create({
    principalId,
    refId: generateDocRef("CM"),
    message,
    preferredConsentManager,
    status: "received",
  });

  return { refId: request.refId, status: request.status };
}

/**
 * Every consent-manager request filed by one principal, most recent first.
 * Scoped by construction - the query filters on principalId, so this can
 * never return another principal's requests. Capped at 200 rows - this is a
 * per-principal list, not a report, and an unbounded query would let one
 * principal with an unusually large history make a read arbitrarily
 * expensive.
 */
async function listConsentManagerRequests({ models, principalId }) {
  assertPrincipalId(principalId);
  const rows = await models.ConsentManagerRequest.find({ principalId }).sort({ createdAt: -1 }).limit(200).lean();
  return rows.map(({ refId, message, preferredConsentManager, status, createdAt, updatedAt }) => ({
    refId, message, preferredConsentManager, status, createdAt, updatedAt,
  }));
}

module.exports = consentManagerRequest;
module.exports.listConsentManagerRequests = listConsentManagerRequests;
