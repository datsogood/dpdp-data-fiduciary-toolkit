const { getValidConsentTypes } = require("../config/catalog");
const { assertOpaqueRef } = require("../utils/validate");
const { AppError } = require("../utils/errors");

// The date this feature shipped. The trail is not retroactive and no backfill
// is possible or permitted, so a read returns this verbatim: a trail with
// nothing in it says "we were not recording before this date" rather than
// implying nothing happened. A module constant, not a stored marker row -
// a marker row cannot be written against a schema whose `actor` and `outcome`
// are both required, and under the fail-open rule below that failure would
// have been silent.
const COVERAGE_FROM = "2026-09-04";

// The honest default. `unattributed` is NOT a synonym for `system`: it means
// the library genuinely does not know who acted, and claiming otherwise would
// be a claim it cannot back. Task 1's `role` enum still admits "system" for a
// host that has a real automated actor to name, but this module deliberately
// exports no constant for it: nothing in the library acts as `system`, and a
// ready-made SYSTEM sitting beside UNATTRIBUTED invites precisely the swap
// this comment exists to prevent.
const UNATTRIBUTED = { role: "unattributed", channel: "library" };

/**
 * Logs a lost trail write with err.name and err.code and NOTHING else.
 *
 * err.message quotes the offending value back - mongoose's cast and duplicate
 * key messages both do - so logging it is how a caller-supplied email reaches
 * a log file. The router's error mapper already holds this line for the same
 * reason (router.js, the CastError branch), and test/auth.test.js pins it.
 */
function logTrailFailure(err) {
  console.error("[dpdp] trail write failed", { name: err && err.name, code: err && err.code });
}

/**
 * Builds the document from a caller-supplied entry.
 *
 * Throws AppError(..., 400) for a caseRef or actor.ref that is not an opaque
 * reference. recordTrail swallows that; recordTrailStrict lets it out, because
 * a malformed reference is the caller's mistake and not an outage.
 */
function buildDoc(entry) {
  const source = entry.actor || UNATTRIBUTED;
  const actor = { role: source.role, channel: source.channel };
  if (source.ref !== undefined) actor.ref = assertOpaqueRef(source.ref, "actor.ref");

  // Every element is checked against the live catalog and dropped when it does
  // not match. withdrawConsent pushes caller-supplied text verbatim and
  // assertStringArray applies no content check, so without this an email typed
  // into consentTypes would reach a collection that survives erasure.
  const types = Array.isArray(entry.consentTypes)
    ? entry.consentTypes.filter((t) => getValidConsentTypes().includes(t))
    : [];

  const doc = {
    // undefined values are not stored, so a row with no subject - an age-gate
    // refusal thrown before any principal exists, or a lookup that matched
    // nobody - has the field ABSENT rather than null.
    principalId: entry.principalId,
    kind: entry.kind,
    outcome: entry.outcome,
    reasonCode: entry.reasonCode,
    actor,
    refId: entry.refId,
    receiptId: entry.receiptId,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    count: entry.count,
  };
  // Omitted rather than stored as []: an empty array would read as "the call
  // named no purposes", which is false - it named some this writer refused.
  if (types.length) doc.consentTypes = types;
  if (entry.caseRef !== undefined) doc.caseRef = assertOpaqueRef(entry.caseRef, "caseRef");
  return doc;
}

/**
 * Records one trail entry. FAIL-OPEN: this never throws.
 *
 * The trail must never take down consent capture, a withdrawal, or the refusal
 * message a data principal needs to read - turning a 422 into a 500 would
 * leave a minor with no explanation. The precedent is onGrievanceFiled, whose
 * throws deliberately do not fail the request. The cost is stated rather than
 * hidden: the trail is evidence of what was recorded, not proof that nothing
 * else happened.
 */
async function recordTrail(models, entry) {
  try {
    await models.TrailEntry.create(buildDoc(entry));
  } catch (err) {
    logTrailFailure(err);
  }
}

/**
 * Records one trail entry. FAIL-CLOSED: throws AppError(..., 503) if the write
 * fails. Back-office disclosure paths only.
 *
 * No record, no disclosure. An unaudited people-search over a fiduciary's data
 * principals is worse than no people-search at all, so if the access record
 * cannot be written the disclosure does not happen: 503, and no data. The
 * precedent is the other half of the same pair as recordTrail's: onWithdrawal
 * throws DO fail the request.
 *
 * A malformed caseRef or actor.ref still surfaces as the 400 assertOpaqueRef
 * throws - that is the caller's payload, not an outage, and answering 503
 * would send an operator to look for a database that is fine.
 */
async function recordTrailStrict(models, entry) {
  const doc = buildDoc(entry);
  try {
    await models.TrailEntry.create(doc);
  } catch (err) {
    logTrailFailure(err);
    throw new AppError("The access record could not be written, so this request was not completed", 503);
  }
}

module.exports = { COVERAGE_FROM, UNATTRIBUTED, recordTrail, recordTrailStrict };
