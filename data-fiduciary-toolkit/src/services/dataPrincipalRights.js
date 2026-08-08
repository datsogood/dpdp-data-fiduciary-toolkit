const { RIGHTS_CATALOG, contactBlock } = require("../config/catalog");
const { generateDocRef } = require("../utils/principalId");
const { assertPrincipalId, assertNonEmptyString } = require("../utils/validate");
const { AppError } = require("../utils/errors");

/** Powers the "Data Principal Rights" page — just the static catalog, Chapter III. */
function listRights() {
  return RIGHTS_CATALOG;
}

/**
 * Files a request against one specific right (what happens when a principal
 * clicks a right on that page and confirms). Grievance redressal itself is
 * handled by complaintToTheBoard/escalateToBoard, not here, since it has its
 * own SLA and escalation path.
 *
 * @param {object} input
 * @param {object} input.models - model registry, must include RightsRequest
 * @param {string} input.principalId
 * @param {string} input.right - one of RIGHTS_CATALOG keys, excluding 'grievance' and 'withdrawal'
 * @param {string} [input.details] - e.g. what field to correct, for 'correction'
 * @returns {Promise<{ refId: string, right: string, status: string, contact: { dpoName, dpoEmail } }>}
 */
async function exerciseRight({ models, principalId, right, details = "" } = {}) {
  // A plain Error has no .status and name === "Error", so the router's error
  // mapper would report every malformed request here as 500 "internal error".
  // These are deliberate rejections written for the caller - they carry their
  // own status.
  assertPrincipalId(principalId);
  assertNonEmptyString(right, "right", 64);
  if (details !== undefined && details !== "") assertNonEmptyString(details, "details", 5000);

  const entry = RIGHTS_CATALOG.find((r) => r.key === right);
  if (!entry) throw new AppError(`Unknown right: ${right}`, 400);
  if (right === "grievance") {
    throw new AppError(
      "Use complaintToTheBoard to raise a grievance - it carries its own SLA and escalation path",
      400
    );
  }
  // withdrawal is immediate and self-service, unlike the manually-processed
  // rights below - filing it as a RightsRequest would return a refId and a
  // "received" status while leaving every purpose exactly as granted as it
  // was, which is indistinguishable from an erasure or correction request
  // that genuinely does need manual handling.
  if (right === "withdrawal") {
    throw new AppError(
      "Use withdrawConsent (PUT or POST /consent/withdraw) to withdraw consent - it takes effect immediately, it is not a request someone has to action",
      400
    );
  }

  const request = await models.RightsRequest.create({
    principalId,
    refId: generateDocRef("RQ"),
    right,
    details,
    status: "received",
  });

  return { refId: request.refId, right, status: request.status, contact: contactBlock() };
}

module.exports = { listRights, exerciseRight };
