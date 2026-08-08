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

/**
 * Every rights request filed by one principal, most recent first. Scoped by
 * construction - the query filters on principalId, so this can never return
 * another principal's requests. Capped at 200 rows - this is a per-principal
 * list, not a report, and an unbounded query would let one principal with an
 * unusually large history make a read arbitrarily expensive.
 */
async function listRightsRequests({ models, principalId }) {
  assertPrincipalId(principalId);
  const rows = await models.RightsRequest.find({ principalId }).sort({ createdAt: -1 }).limit(200).lean();
  return rows.map(({ refId, right, details, status, createdAt, updatedAt }) => ({ refId, right, details, status, createdAt, updatedAt }));
}

/**
 * A single rights request, scoped to its owner. principalId is part of the
 * query filter itself, not checked afterwards, so a refId belonging to
 * another principal simply does not match and comes back as the same 404 as
 * a refId that does not exist at all - a 403 here would confirm the refId is
 * real, turning this endpoint into an existence oracle for other principals'
 * reference numbers.
 */
async function getRightsRequest({ models, principalId, refId }) {
  assertPrincipalId(principalId);
  assertNonEmptyString(refId, "refId", 64);
  const row = await models.RightsRequest.findOne({ principalId, refId }).lean();
  if (!row) throw new AppError("No rights request found with that reference", 404);
  const { right, details, status, createdAt, updatedAt } = row;
  return { refId, right, details, status, createdAt, updatedAt };
}

module.exports = { listRights, exerciseRight, listRightsRequests, getRightsRequest };
