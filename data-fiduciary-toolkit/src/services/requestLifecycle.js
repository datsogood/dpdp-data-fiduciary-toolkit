const { assertNonEmptyString } = require("../utils/validate");
const { AppError } = require("../utils/errors");

/**
 * Fiduciary-side status transitions.
 *
 * Three models declared multi-state status enums that no code could advance,
 * so every request ever filed sat at its initial value forever: a data
 * principal got a refId that could never change state, and the guard in
 * escalateToBoard that checks for a resolved grievance was unreachable.
 *
 * These are back-office operations. They are deliberately NOT mounted on the
 * principal-facing router - a data principal must not be able to close their
 * own grievance, and the fiduciary's staff auth is the host's concern.
 */
const RIGHTS_TRANSITIONS = { received: ["in_progress", "closed"], in_progress: ["closed"], closed: [] };
// "escalated" is deliberately NOT reachable from here. escalateToBoard is the
// only path into that state, because it is the only one that checks the SLA has
// lapsed and sets escalatedAt/escalatedToBoard. Allowing it here would let a
// grievance sit in status "escalated" with escalatedAt null and
// escalatedToBoard false - two fields contradicting each other in the audit
// record - and the re-escalation guard would then dereference null and return
// 500 to a data principal exercising an escalation right.
const GRIEVANCE_TRANSITIONS = { open: ["in_progress", "resolved"], in_progress: ["resolved"], resolved: [], escalated: ["resolved"] };
const CM_TRANSITIONS = { received: ["connected", "closed"], connected: ["closed"], closed: [] };

function assertTransition(map, from, to, kind) {
  const allowed = map[from];
  if (!allowed) throw new AppError(`${kind} is in an unknown state: ${from}`, 409);
  if (!allowed.includes(to)) {
    throw new AppError(`Cannot move ${kind} from ${from} to ${to}. Allowed: ${allowed.join(", ") || "none"}`, 409);
  }
}

async function advance({ model, map, kind, refId, status, resolution, extraFields = {} }) {
  assertNonEmptyString(refId, "refId", 64);
  assertNonEmptyString(status, "status", 32);
  const row = await model.findOne({ refId });
  if (!row) throw new AppError(`No ${kind} found with that reference`, 404);
  assertTransition(map, row.status, status, kind);

  row.status = status;
  if (resolution !== undefined) row.resolution = resolution;
  Object.assign(row, extraFields);
  row.updatedAt = new Date();
  await row.save();
  return row.toObject();
}

const advanceRightsRequest = ({ models, refId, status, resolution }) =>
  advance({ model: models.RightsRequest, map: RIGHTS_TRANSITIONS, kind: "rights request", refId, status, resolution });

const advanceGrievance = ({ models, refId, status, resolution }) =>
  advance({ model: models.Grievance, map: GRIEVANCE_TRANSITIONS, kind: "grievance", refId, status, resolution });

const advanceConsentManagerRequest = ({ models, refId, status }) =>
  advance({ model: models.ConsentManagerRequest, map: CM_TRANSITIONS, kind: "consent manager request", refId, status });

module.exports = { advanceRightsRequest, advanceGrievance, advanceConsentManagerRequest, RIGHTS_TRANSITIONS, GRIEVANCE_TRANSITIONS, CM_TRANSITIONS };
