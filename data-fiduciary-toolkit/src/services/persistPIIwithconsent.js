const { getCatalog, getValidConsentTypes } = require("../config/catalog");
const { findOrCreatePrincipal, generateDocRef } = require("../utils/principalId");
const { assertStringArray } = require("../utils/validate");
const { AppError } = require("../utils/errors");

/**
 * Records a data principal's consent decisions.
 *
 * Non-destructive by design. An earlier version appended an event for every
 * purpose on every call, which meant a profile update silently withdrew live
 * consents and a re-post silently resurrected a withdrawn one. Here the
 * service computes the delta against current state and appends only events
 * that represent a real change - and reversing a withdrawal requires the
 * caller to say so explicitly with regrant: true.
 *
 * @param {object}   input
 * @param {object}   input.models
 * @param {object}   input.pii            - { name, email?, phone?, dob?, pan?, address? }
 * @param {string[]} [input.consentTypes] - omit entirely for a PII-only update
 * @param {boolean}  [input.regrant]      - allow reversing a prior withdrawal
 * @param {object}   [input.notice]       - Section 5 notice snapshot (Task 8)
 * @returns {Promise<{ docRef, receiptId, principalId, created, events, state }>}
 */
async function persistPIIwithconsent({ models, pii, consentTypes, regrant = false, notice } = {}) {
  // Omitting consentTypes and submitting [] are different acts: the first is
  // "no consent decision was made", the second is "I decline everything".
  //
  // null must count as omission, not as a decline. assertStringArray maps both
  // undefined and null to [], so treating null as a submission would walk the
  // granted-plus-absent row for every live optional purpose and withdraw it - and
  // a JSON body may legally carry "consentTypes": null, which is how a client
  // that serialises an absent value rather than dropping the key would revoke
  // every consent it had. The ledger is append-only, so that is unrecoverable.
  const consentSubmitted = consentTypes !== undefined && consentTypes !== null;
  const chosen = assertStringArray(consentTypes, "consentTypes");

  const unknown = chosen.filter((t) => !getValidConsentTypes().includes(t));
  if (unknown.length) throw new AppError(`Unknown consent type(s): ${unknown.join(", ")}`, 400);

  const { principal, created } = await findOrCreatePrincipal({ models, pii });
  const principalId = principal.principalId;
  const now = new Date();
  // One receipt per submission. The docRef identifies the record and stays put
  // for the life of the principal; the receiptId identifies this act, and every
  // event this call appends carries it.
  const receiptId = generateDocRef("RC");

  /**
   * The delta for a given state. Taking state as an argument rather than
   * closing over one is what lets the duplicate-key recovery below recompute
   * against the winning document instead of replaying a stale decision.
   */
  const decideFor = (state) => {
    const events = [];
    for (const entry of getCatalog()) {
      const current = state[entry.type] ? state[entry.type].status : undefined;
      const target = decide({ entry, current, chosen, consentSubmitted, regrant });
      if (!target || target === current) continue;
      events.push({
        type: entry.type,
        status: target,
        basis: entry.lawfulBasis.description,
        lawfulBasisKind: entry.lawfulBasis.kind,
        receiptId,
        timestamp: now,
      });
    }
    return events;
  };

  // Task 8 replaces this with the full notice snapshot. Keep it in one place so
  // both the first attempt and the recovery below apply the same thing.
  const snapshotNotice = (doc) => {
    if (notice) doc.lastNotice = notice;
  };

  // The unique index on principalId is the only thing stopping two concurrent
  // first submissions from creating two ledgers for one person, and mongoose
  // builds indexes in the background - so wait for it before relying on it.
  // init() is memoized, so this costs nothing once the index exists.
  await models.ConsentRecord.init();

  let record = await models.ConsentRecord.findOne({ principalId });
  if (!record) {
    record = new models.ConsentRecord({
      principalId,
      docRef: generateDocRef("CN"),
      events: [],
      createdAt: now,
    });
  }

  let newEvents = decideFor(record.currentState());
  if (newEvents.length) {
    record.events.push(...newEvents);
  }
  // Refreshing the notice snapshot is a modification of the record too, so it
  // moves updatedAt even when no consent changed. A submission that changes
  // neither leaves the document untouched.
  if (newEvents.length || notice) {
    record.updatedAt = now;
  }
  snapshotNotice(record);

  try {
    await record.save();
  } catch (err) {
    if (!err || err.code !== 11000) throw err;

    // Another request created this principal's record between our findOne and
    // our save. Re-read the winner and recompute the delta against ITS state.
    // Replaying newEvents would append a duplicate grant or decline for every
    // purpose - and the ledger is append-only, so nothing could remove them.
    const winner = await models.ConsentRecord.findOne({ principalId });
    if (!winner) throw err;

    record = winner;
    newEvents = decideFor(record.currentState());
    if (newEvents.length) {
      record.events.push(...newEvents);
    }
    if (newEvents.length || notice) {
      record.updatedAt = now;
    }
    // The notice snapshot was set on the losing document and would otherwise be
    // dropped, taking the evidence that notice was given with it.
    snapshotNotice(record);
    await record.save();
  }

  return {
    docRef: record.docRef,
    receiptId,
    principalId,
    created,
    // The events actually appended - recomputed, so this stays truthful even
    // when the save above lost the create race.
    events: newEvents,
    state: record.currentState(),
  };
}

/** Implements the state table in the plan. Returns the target status, or null for no change. */
function decide({ entry, current, chosen, consentSubmitted, regrant }) {
  // A legitimate use does not depend on choice - record it once, for notice.
  if (entry.lawfulBasis.kind === "legitimate_use") return current ? null : "granted";
  // A PII-only update carries no consent decision at all.
  if (!consentSubmitted) return null;

  const wants = chosen.includes(entry.type);
  if (wants) {
    if (current === "granted") return null;
    if (current === "withdrawn") return regrant ? "granted" : null;
    return "granted"; // undefined or denied
  }
  // Omitting a non-withdrawable purpose must not withdraw it. No catalog this
  // plan ships can reach here - every consent-based entry is withdrawable - but
  // an adopter who hand-authors a consent-based, non-withdrawable purpose would
  // otherwise find POST /consent silently withdrawing what withdrawConsent
  // explicitly refuses to withdraw. Keep the two in agreement by construction.
  if (current === "granted") return entry.withdrawable ? "withdrawn" : null;
  return current ? null : "denied";
}

module.exports = persistPIIwithconsent;
