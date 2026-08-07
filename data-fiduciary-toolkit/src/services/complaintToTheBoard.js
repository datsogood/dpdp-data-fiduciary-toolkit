const { FIDUCIARY } = require("../config/catalog");
const { generateDocRef } = require("../utils/principalId");

/**
 * Files a grievance. Named to match what the person clicks ("complain to
 * the Board"), but per Section 13 a complaint must first go to the
 * fiduciary's own Grievance Officer — the Board only hears it if that isn't
 * resolved within the SLA. This function records the grievance as addressed
 * to the DPO and sets that SLA; use escalateToBoard() after it lapses.
 *
 * @param {object} input
 * @param {object} input.models - model registry, must include Grievance
 * @param {string} input.principalId
 * @param {string} input.subject
 * @param {string} input.description
 * @returns {Promise<{ refId, addressedTo, slaDueAt }>}
 */
async function complaintToTheBoard({ models, principalId, subject, description } = {}) {
  if (!principalId) throw new Error("principalId is required");
  if (!subject || !description) throw new Error("subject and description are required");

  const now = new Date();
  const slaDueAt = new Date(now.getTime() + FIDUCIARY.grievanceSlaDays * 24 * 60 * 60 * 1000);

  const grievance = await models.Grievance.create({
    principalId,
    refId: generateDocRef("GR"),
    subject,
    description,
    addressedTo: FIDUCIARY.dpoName,
    status: "open",
    slaDueAt,
    createdAt: now,
    updatedAt: now,
  });

  return {
    refId: grievance.refId,
    addressedTo: FIDUCIARY.dpoName,
    dpoEmail: FIDUCIARY.dpoEmail,
    slaDueAt,
    note: `This has been sent to ${FIDUCIARY.name}'s Grievance Officer. If it isn't resolved by the SLA date, you can escalate it to the Data Protection Board.`,
  };
}

/**
 * Escalates an existing grievance to the Data Protection Board. Only
 * meaningful once the SLA has lapsed without resolution — enforced here
 * rather than left to the caller.
 */
async function escalateToBoard({ models, refId, principalId } = {}) {
  if (!refId) throw new Error("refId is required");
  const grievance = await models.Grievance.findOne({ refId });
  if (!grievance) throw new Error("No grievance found with that reference");
  if (grievance.status === "resolved") throw new Error("This grievance is already marked resolved");
  if (new Date() < grievance.slaDueAt) {
    throw new Error(`The Grievance Officer's SLA hasn't lapsed yet (due ${grievance.slaDueAt.toISOString()})`);
  }

  grievance.status = "escalated";
  grievance.escalatedToBoard = true;
  grievance.escalatedAt = new Date();
  grievance.updatedAt = grievance.escalatedAt;
  await grievance.save();

  return { refId: grievance.refId, status: grievance.status, escalatedAt: grievance.escalatedAt };
}

module.exports = { complaintToTheBoard, escalateToBoard };
