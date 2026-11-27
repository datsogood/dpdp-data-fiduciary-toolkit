const { assertNonEmptyString } = require("../utils/validate");
const { AppError } = require("../utils/errors");
const { recordTrail, UNATTRIBUTED } = require("./consentTrail");

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

/**
 * `models` is the registry, threaded in from the wrappers purely so the
 * transition can be recorded - `model` (singular) stays what it always was,
 * the one collection being advanced. `kind` is the human label used in the
 * error messages ("rights request"); the trail's own kind is the literal
 * "request_status_changed" below, and the two are not related.
 */
async function advance({ models, model, map, kind, refId, status, resolution, extraFields = {}, actor = UNATTRIBUTED }) {
  assertNonEmptyString(refId, "refId", 64);
  assertNonEmptyString(status, "status", 32);
  const row = await model.findOne({ refId });
  if (!row) throw new AppError(`No ${kind} found with that reference`, 404);
  assertTransition(map, row.status, status, kind);

  // Captured BEFORE the assignment below. `row.status = status` overwrites the
  // prior value in place, and nothing else on the document remembers it -
  // updatedAt holds only the moment of the LAST change - so a request that
  // moved received -> in_progress -> closed becomes indistinguishable from one
  // that went straight to closed. That destruction is the whole reason this
  // transition is stored rather than derived at read time.
  const fromStatus = row.status;

  row.status = status;
  if (resolution !== undefined) row.resolution = resolution;
  Object.assign(row, extraFields);
  row.updatedAt = new Date();
  await row.save();

  // After the save, and only on a transition that actually happened: an
  // illegal one throws above and writes nothing, so no row can claim a change
  // the document did not make. recordTrail is fail-open and never throws, so
  // an unavailable trail cannot fail a transition that already persisted.
  await recordTrail(models, {
    principalId: row.principalId,
    kind: "request_status_changed",
    outcome: "recorded",
    actor,
    refId: row.refId,
    fromStatus,
    toStatus: status,
  });

  return row.toObject();
}

const advanceRightsRequest = ({ models, refId, status, resolution, actor }) =>
  advance({ models, model: models.RightsRequest, map: RIGHTS_TRANSITIONS, kind: "rights request", refId, status, resolution, actor });

const advanceGrievance = ({ models, refId, status, resolution, actor }) =>
  advance({ models, model: models.Grievance, map: GRIEVANCE_TRANSITIONS, kind: "grievance", refId, status, resolution, actor });

const advanceConsentManagerRequest = ({ models, refId, status, actor }) =>
  advance({ models, model: models.ConsentManagerRequest, map: CM_TRANSITIONS, kind: "consent manager request", refId, status, actor });

module.exports = { advanceRightsRequest, advanceGrievance, advanceConsentManagerRequest, RIGHTS_TRANSITIONS, GRIEVANCE_TRANSITIONS, CM_TRANSITIONS };
