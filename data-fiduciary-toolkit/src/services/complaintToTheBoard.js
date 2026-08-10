const { FIDUCIARY } = require("../config/catalog");
const { generateDocRef } = require("../utils/principalId");
const { assertPrincipalId, assertNonEmptyString } = require("../utils/validate");
const { AppError } = require("../utils/errors");

/**
 * Files a grievance. Named to match what the person clicks ("complain to
 * the Board"), but per Section 13 a complaint must first go to the
 * fiduciary's own Grievance Officer - the Board only hears it if that isn't
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
    // "Recorded and assigned", never "sent". This package has no outbound
    // channel - no mail transport, no ticketing integration - so a grievance
    // is written to a collection and nothing leaves the process. Telling a
    // data principal it "has been sent" is a false assurance that stops them
    // following it up, and the SLA date they need in order to escalate was
    // not even in the sentence.
    note:
      `This grievance has been recorded and assigned to ${FIDUCIARY.name}'s Grievance Officer ` +
      `(${FIDUCIARY.dpoName}). If it is not resolved by ${slaDueAt.toISOString().slice(0, 10)}, ` +
      `you may escalate it to the Data Protection Board.`,
  };
}

/**
 * Escalates an existing grievance to the Data Protection Board. Only
 * meaningful once the SLA has lapsed without resolution - enforced here
 * rather than left to the caller.
 *
 * principalId is required and is folded into the lookup itself, not checked
 * afterwards - see getGrievance below for why a 403 here would turn this
 * endpoint into an existence oracle for other principals' GR- references.
 * The router takes principalId from resolvePrincipal, never from the
 * request.
 *
 * @param {object} input
 * @param {object} input.models      - model registry, must include Grievance
 * @param {string} input.refId       - the GR- reference returned when it was filed
 * @param {string} input.principalId - the owner, from resolvePrincipal
 * @returns {Promise<{ refId: string, status: string, escalatedAt: Date }>}
 */
async function escalateToBoard({ models, refId, principalId } = {}) {
  assertNonEmptyString(refId, "refId", 64);
  // principalId is now required. Without it this took any refId and never
  // consulted the grievance's owner, so anyone holding or guessing a GR-
  // reference could escalate someone else's complaint (M8).
  assertPrincipalId(principalId);

  // principalId is part of the filter itself, not checked after the fact -
  // a refId belonging to another principal simply does not match and comes
  // back as the same 404 as a refId that does not exist at all. A 403 here
  // would confirm the refId is real, letting anyone who has seen or guessed
  // a GR- reference distinguish "exists, not yours" from "does not exist" -
  // exactly the existence oracle getGrievance was written to avoid.
  const grievance = await models.Grievance.findOne({ refId, principalId });
  if (!grievance) throw new AppError("No grievance found with that reference", 404);
  if (grievance.status === "resolved") throw new AppError("This grievance is already marked resolved", 409);
  // Null-safe: a document could reach "escalated" by a route this plan does
  // not control (a direct database edit, or a future caller), so escalatedAt
  // is not guaranteed to be set even though escalateToBoard itself always
  // sets it before status.
  if (grievance.status === "escalated") {
    const when = grievance.escalatedAt ? grievance.escalatedAt.toISOString() : "earlier";
    throw new AppError(`This grievance was already escalated on ${when}`, 409);
  }
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

/**
 * Every grievance filed by one principal, most recent first. Scoped by
 * construction - the query filters on principalId, so this can never return
 * another principal's grievances. Capped at 200 rows - this is a
 * per-principal list, not a report, and an unbounded query would let one
 * principal with an unusually large history make a read arbitrarily
 * expensive.
 */
async function listGrievances({ models, principalId }) {
  assertPrincipalId(principalId);
  const rows = await models.Grievance.find({ principalId }).sort({ createdAt: -1 }).limit(200).lean();
  return rows.map(
    ({ refId, subject, description, addressedTo, status, slaDueAt, resolution, escalatedToBoard, escalatedAt, createdAt, updatedAt }) => ({
      refId, subject, description, addressedTo, status, slaDueAt, resolution, escalatedToBoard, escalatedAt, createdAt, updatedAt,
    })
  );
}

/**
 * A single grievance, scoped to its owner. principalId is part of the query
 * filter itself, not checked afterwards, so a refId belonging to another
 * principal simply does not match and comes back as the same 404 as a refId
 * that does not exist at all - a 403 here would confirm the refId is real,
 * turning this endpoint into an existence oracle for other principals'
 * reference numbers.
 */
async function getGrievance({ models, principalId, refId }) {
  assertPrincipalId(principalId);
  assertNonEmptyString(refId, "refId", 64);
  const row = await models.Grievance.findOne({ principalId, refId }).lean();
  if (!row) throw new AppError("No grievance found with that reference", 404);
  const { subject, description, addressedTo, status, slaDueAt, resolution, escalatedToBoard, escalatedAt, createdAt, updatedAt } = row;
  return { refId, subject, description, addressedTo, status, slaDueAt, resolution, escalatedToBoard, escalatedAt, createdAt, updatedAt };
}

module.exports = { complaintToTheBoard, escalateToBoard, listGrievances, getGrievance };
