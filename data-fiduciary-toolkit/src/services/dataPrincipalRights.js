const { RIGHTS_CATALOG } = require("../config/catalog");
const { generateDocRef } = require("../utils/principalId");

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
 * @param {string} input.right - one of RIGHTS_CATALOG keys, excluding 'grievance'
 * @param {string} [input.details] - e.g. what field to correct, for 'correction'
 * @returns {Promise<{ refId: string, right: string, status: string }>}
 */
async function exerciseRight({ models, principalId, right, details = "" } = {}) {
  if (!principalId) throw new Error("principalId is required");
  const entry = RIGHTS_CATALOG.find((r) => r.key === right);
  if (!entry) throw new Error(`Unknown right: ${right}`);
  if (right === "grievance") {
    throw new Error("Use complaintToTheBoard to raise a grievance — it carries its own SLA and escalation path");
  }

  const request = await models.RightsRequest.create({
    principalId,
    refId: generateDocRef("RQ"),
    right,
    details,
    status: "received",
  });

  return { refId: request.refId, right, status: request.status };
}

module.exports = { listRights, exerciseRight };
