const { getCatalogEntry, getValidConsentTypes, getWithdrawableTypes, contactBlock } = require("../config/catalog");
const { assertPrincipalId, assertStringArray } = require("../utils/validate");
const { generateDocRef } = require("../utils/principalId");
const { AppError } = require("../utils/errors");
const { recordTrail, UNATTRIBUTED } = require("./consentTrail");

/**
 * Withdraws consent for one or more purposes. Append-only: never edits or
 * deletes history.
 *
 * Withdrawal triggers a duty to cease processing and erase - which this
 * library cannot perform on the integrator's behalf, since it does not know
 * where else the data went. So it reports what changed through onWithdrawal
 * and leaves the pipeline to the host. Logging the withdrawal without giving
 * the host a way to act on it would be worse than not logging it.
 *
 * @param {object}   input
 * @param {object}   input.models
 * @param {string}   input.principalId
 * @param {string[]} input.consentTypes   - purposes to withdraw
 * @param {Function} [input.onWithdrawal] - called once, only if something changed
 * @param {object}   [input.actor]        - who is acting, for the audit trail.
 *                                          Defaults to UNATTRIBUTED: a direct
 *                                          library call genuinely has no
 *                                          identity, and claiming "system"
 *                                          would be a claim this library
 *                                          cannot back.
 * @returns {Promise<{ docRef, receiptId, withdrawn, rejected, noChange, effectiveFrom, contact: { dpoName, dpoEmail } }>}
 *          effectiveFrom is null when withdrawn is empty.
 */
async function withdrawConsent({ models, principalId, consentTypes, onWithdrawal, actor = UNATTRIBUTED } = {}) {
  assertPrincipalId(principalId);
  // Deduplicated: a purpose named twice in one request is one decision, and
  // without this the second pass would read the same pre-loop state and append
  // a second identical event that the append-only ledger could never shed.
  const types = [...new Set(assertStringArray(consentTypes, "consentTypes"))];
  if (!types.length) throw new AppError("consentTypes must include at least one purpose to withdraw", 400);

  const record = await models.ConsentRecord.findOne({ principalId });
  if (!record) throw new AppError("No consent record found for this principal", 404);

  const now = new Date();
  const receiptId = generateDocRef("RC");
  const state = record.currentState();
  const withdrawn = [];
  const rejected = [];
  const noChange = [];
  // Collected per REASON, not per purpose. One call naming 200 purposes must
  // write one row per reason and not 200 rows - an authenticated principal
  // could otherwise force thousands of inserts from one request.
  const unknownTypes = [];
  const notWithdrawableTypes = [];
  const notGrantedTypes = [];

  for (const type of types) {
    // Unknown first: an unknown type has no catalog entry, so every branch
    // below that reads one must be unreachable for it.
    if (!getValidConsentTypes().includes(type)) {
      rejected.push({ type, reason: "Unknown consent type" });
      unknownTypes.push(type);
      continue;
    }
    const entry = getCatalogEntry(type);
    if (!getWithdrawableTypes().includes(type)) {
      rejected.push({
        type,
        reason: `This purpose rests on ${entry.lawfulBasis.clause} (${entry.lawfulBasis.description}), not on your consent, so it cannot be withdrawn`,
      });
      notWithdrawableTypes.push(type);
      continue;
    }
    const current = state[type] ? state[type].status : undefined;
    if (current !== "granted") {
      // Already withdrawn, declined, or never granted - nothing to revoke.
      noChange.push(type);
      notGrantedTypes.push(type);
      continue;
    }
    record.events.push({
      type,
      status: "withdrawn",
      basis: entry.lawfulBasis.description,
      lawfulBasisKind: entry.lawfulBasis.kind,
      receiptId,
      timestamp: now,
    });
    withdrawn.push(type);
  }

  // Only persist when something actually changed.
  if (withdrawn.length) {
    record.updatedAt = now;
    await record.save();
    if (typeof onWithdrawal === "function") {
      await onWithdrawal({ principalId, types: withdrawn, effectiveFrom: now, receiptId });
    }
  }

  // The trail write happens whether or not the save above ran - that is the
  // whole point. A refused or no-op withdrawal skips save() entirely, so these
  // rows are the only record anywhere that the person asked and was told no.
  //
  // AFTER the save, never before: a row must not claim a decision the ledger
  // write then failed to make. What did succeed is in the ledger with a real
  // timestamp and is derived at read time, so it is not repeated here.
  //
  // recordTrail is fail-open and never throws, so an unavailable trail cannot
  // turn a withdrawal into a 500.
  for (const group of [
    { types: unknownTypes, outcome: "refused", reasonCode: "unknown_consent_type" },
    { types: notWithdrawableTypes, outcome: "refused", reasonCode: "not_withdrawable" },
    { types: notGrantedTypes, outcome: "no_change", reasonCode: "not_granted" },
  ]) {
    if (!group.types.length) continue;
    await recordTrail(models, {
      principalId,
      kind: "withdrawal_not_applied",
      outcome: group.outcome,
      reasonCode: group.reasonCode,
      actor,
      receiptId,
      // recordTrail drops every element that is not in the live catalog, so
      // the unknown-type row keeps its count and loses its strings. An unknown
      // type is caller-supplied text that assertStringArray does not
      // content-check, so an email typed into consentTypes must never reach a
      // collection that survives erasure.
      consentTypes: group.types,
      count: group.types.length,
    });
  }

  return {
    docRef: record.docRef,
    receiptId,
    withdrawn,
    rejected,
    noChange,
    // null when nothing was withdrawn: reporting a moment for a revocation that
    // did not happen would have a host act on nothing.
    effectiveFrom: withdrawn.length ? now : null,
    contact: contactBlock(),
  };
}

module.exports = withdrawConsent;
