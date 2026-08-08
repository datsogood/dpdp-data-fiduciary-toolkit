const { FIDUCIARY } = require("../config/catalog");
const { generateDocRef } = require("../utils/principalId");
const { assertPrincipalId, assertNonEmptyString } = require("../utils/validate");
const { AppError } = require("../utils/errors");

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
  // AppError, not Error: a plain Error has no .status, so the router's error
  // mapper would report a malformed request as 500 "internal error". The
  // lengths match the schema's maxlength, so a value that would fail
  // validation on save is refused here with a message that names the field.
  assertPrincipalId(principalId);
  assertNonEmptyString(subject, "subject", 200);
  assertNonEmptyString(description, "description", 10000);

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
 *
 * principalId is required and is compared against the grievance's owner. The
 * router takes it from resolvePrincipal, never from the request.
 */
async function escalateToBoard({ models, refId, principalId } = {}) {
  assertNonEmptyString(refId, "refId", 64);
  // principalId is now required. Without it this took any refId and never
  // consulted the grievance's owner, so anyone holding or guessing a GR-
  // reference could escalate someone else's complaint (M8).
  assertPrincipalId(principalId);

  const grievance = await models.Grievance.findOne({ refId });
  if (!grievance) throw new AppError("No grievance found with that reference", 404);
  // Ownership is checked before state, so the SLA and resolution messages
  // below cannot be used to read the status of a grievance that is not yours.
  if (grievance.principalId !== principalId) {
    throw new AppError("This grievance does not belong to you", 403);
  }
  if (grievance.status === "resolved") throw new AppError("This grievance is already marked resolved", 409);
  if (new Date() < grievance.slaDueAt) {
    throw new AppError(
      `The Grievance Officer's SLA hasn't lapsed yet (due ${grievance.slaDueAt.toISOString()})`,
      409
    );
  }

  grievance.status = "escalated";
  grievance.escalatedToBoard = true;
  grievance.escalatedAt = new Date();
  grievance.updatedAt = grievance.escalatedAt;
  await grievance.save();

  return { refId: grievance.refId, status: grievance.status, escalatedAt: grievance.escalatedAt };
}

module.exports = { complaintToTheBoard, escalateToBoard };
