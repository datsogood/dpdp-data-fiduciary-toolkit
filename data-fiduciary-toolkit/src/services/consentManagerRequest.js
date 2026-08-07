const { generateDocRef } = require("../utils/principalId");

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
  if (!principalId) throw new Error("principalId is required");
  if (!message) throw new Error("message is required");

  const request = await models.ConsentManagerRequest.create({
    principalId,
    refId: generateDocRef("CM"),
    message,
    preferredConsentManager,
    status: "received",
  });

  return { refId: request.refId, status: request.status };
}

module.exports = consentManagerRequest;
