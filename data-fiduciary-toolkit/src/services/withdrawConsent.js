const { getCatalogEntry, getValidConsentTypes, getWithdrawableTypes, contactBlock } = require("../config/catalog");
const { assertPrincipalId, assertStringArray } = require("../utils/validate");
const { generateDocRef } = require("../utils/principalId");
const { AppError } = require("../utils/errors");

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
 * @returns {Promise<{ docRef, receiptId, withdrawn, rejected, noChange, effectiveFrom, contact: { dpoName, dpoEmail } }>}
 *          effectiveFrom is null when withdrawn is empty.
 */
async function withdrawConsent({ models, principalId, consentTypes, onWithdrawal } = {}) {
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

  for (const type of types) {
    // Unknown first: an unknown type has no catalog entry, so every branch
    // below that reads one must be unreachable for it.
    if (!getValidConsentTypes().includes(type)) {
      rejected.push({ type, reason: "Unknown consent type" });
      continue;
    }
    const entry = getCatalogEntry(type);
    if (!getWithdrawableTypes().includes(type)) {
      rejected.push({
        type,
        reason: `This purpose rests on ${entry.lawfulBasis.clause} (${entry.lawfulBasis.description}), not on your consent, so it cannot be withdrawn`,
      });
      continue;
    }
    const current = state[type] ? state[type].status : undefined;
    if (current !== "granted") {
      // Already withdrawn, declined, or never granted - nothing to revoke.
      noChange.push(type);
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
