const { getCatalog, getValidConsentTypes } = require("../config/catalog");
const { findOrCreatePrincipal, generateDocRef } = require("../utils/principalId");
const { assertStringArray, assertPrincipalId } = require("../utils/validate");
const { AppError } = require("../utils/errors");
const { ageInYears, ADULT_AGE } = require("../utils/age");
const { recordTrail, UNATTRIBUTED } = require("./consentTrail");

/**
 * Verifiable parental consent, as far as this library can check it: a named
 * parent or guardian, contact details, a stated relationship, and the moment
 * the fiduciary verified it. This is NOT identity verification - the library
 * has no way to confirm that whoever passed these details is telling the
 * truth. It exists so a caller who has already done that verification
 * through its own trusted process has a shape to record the result in.
 *
 * `parentalConsent` is a server-side parameter only. Nothing wires it into a
 * route or a form - a child typing a parent's name and a verifiedAt
 * timestamp into a public form is not verifiable parental consent, it is a
 * text box. See the README's "What this is not" for the consequence.
 */
function isVerifiedParentalConsent(parentalConsent) {
  if (!parentalConsent || typeof parentalConsent !== "object") return false;
  const { name, email, relationship, verifiedAt } = parentalConsent;
  if (typeof name !== "string" || !name.trim()) return false;
  if (typeof email !== "string" || !email.trim()) return false;
  if (typeof relationship !== "string" || !relationship.trim()) return false;
  const t = verifiedAt instanceof Date ? verifiedAt : new Date(verifiedAt);
  return !Number.isNaN(t.getTime());
}

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
 * pii.dob is required - an age gate cannot exist without it - and it runs
 * before any write, so a minor rejected for want of parental consent leaves
 * no Principal and no ConsentRecord behind. A minor with verifiable parental
 * consent still never gets a purpose the catalog marks prohibitedForChildren:
 * parental consent does not unlock behavioural advertising or tracking aimed
 * at a child.
 *
 * @param {object}   input
 * @param {object}   input.models
 * @param {object}   input.pii              - { name, email?, phone?, dob, pan?, address? }
 * @param {string[]} [input.consentTypes]   - omit entirely for a PII-only update
 * @param {boolean}  [input.regrant]        - allow reversing a prior withdrawal
 * @param {object}   [input.notice]         - Section 5 notice snapshot (Task 8)
 * @param {object}   [input.parentalConsent] - { name, email, relationship, verifiedAt } - server-side only, see above.
 *   Optional on the principalId branch: the record written at registration is
 *   used when the caller passes none, so a registered minor is not locked out
 *   of every later consent update by a gate no route can satisfy.
 * @param {string}   [input.principalId]  - when the caller ALREADY knows who this
 *   is (an authenticated update), pass it and skip contact-hash resolution
 *   entirely. Without it this function re-derives identity from pii via
 *   findOrCreatePrincipal, which is right for signup and wrong for an update:
 *   phoneHash is deliberately non-unique, so a household sharing a handset can
 *   have two candidate documents and the winner is decided by insertion order
 *   rather than by anything asserted. Worse, if PRINCIPAL_ID_SECRET is ever
 *   rotated, every stored emailHash goes stale and an authenticated update
 *   would MINT A NEW PRINCIPAL carrying the old one's PII, return the new id to
 *   the caller, and append the consent event to a forked ledger, orphaning the
 *   original record with live PII.
 * @param {object}   [input.actor] - who is acting, for the AUDIT TRAIL ONLY. Defaults
 *   to UNATTRIBUTED, which is not a synonym for "system": a direct service call
 *   genuinely does not tell this library who is behind it, and claiming otherwise
 *   would be a claim it cannot back. Nothing about the consent decision, the
 *   ledger, or the returned object depends on this value.
 * @returns {Promise<{ docRef, receiptId, principalId, created, events, state, refusedForChild }>}
 */
async function persistPIIwithconsent({ models, pii, consentTypes, regrant = false, notice, parentalConsent, principalId, actor = UNATTRIBUTED } = {}) {
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

  // The age gate runs before any write - findOrCreatePrincipal included - so
  // a rejected minor leaves no Principal and no ConsentRecord behind.
  //
  // It runs on EVERY path, signup and authenticated update alike. Skipping it
  // for an update would leave isMinor stale and let a purpose the catalog marks
  // prohibitedForChildren be granted to a child through the update route, which
  // is the whole restriction Section 9 imposes.
  const age = ageInYears(pii && pii.dob);
  if (age === null) {
    throw new AppError(
      "pii.dob is required and must be a valid date - the Act requires a child's data to be treated differently, which cannot be done without it",
      400
    );
  }
  const isMinor = age < ADULT_AGE;

  // An authenticated caller already knows the principal. Resolve by id and
  // never by contact hash - see the principalId param note above.
  //
  // On THAT branch the resolution has to happen BEFORE the age gate below,
  // because the stored record is where a registered minor's parental consent
  // lives. No route forwards parentalConsent (and none may - it must never be
  // exposed to a form), and the service used not to fall back to what it had
  // itself written at registration, so the gate rejected every consent update
  // by a registered minor with 422 - forever - telling them parental consent
  // was required when it was on file two collections away. Principal.
  // parentalConsent and Principal.isMinor were written here and read by
  // nothing.
  //
  // The SIGNUP branch keeps the opposite ordering deliberately: the gate runs
  // before findOrCreatePrincipal, so a rejected minor still leaves no
  // Principal and no ConsentRecord behind. Reading a document is not a write,
  // so resolving first on the authenticated branch does not weaken that.
  let principal;
  let created = false;
  let effectiveParentalConsent = parentalConsent;
  if (principalId) {
    assertPrincipalId(principalId);
    principal = await models.Principal.findOne({ principalId });
    if (!principal) throw new AppError("No principal found for that id", 404);
    if (!effectiveParentalConsent) effectiveParentalConsent = principal.parentalConsent;
  }

  if (isMinor && !isVerifiedParentalConsent(effectiveParentalConsent)) {
    // Written BEFORE the throw, because the throw IS the record: this 422
    // leaves no Principal and no ConsentRecord behind by design, so without
    // this row nothing anywhere says a child was turned away.
    //
    // principalId is present only on the AUTHENTICATED branch, where the
    // principal was loaded above. On the SIGNUP branch the gate deliberately
    // runs before findOrCreatePrincipal, so there is no subject at all and the
    // row is written with principalId absent - `principal` is the only honest
    // source for it, since the parameter can be any falsy value the caller
    // passed and "" would store a subject-shaped hole.
    await recordTrail(models, {
      principalId: principal ? principal.principalId : undefined,
      kind: "age_gate_refused",
      outcome: "refused",
      reasonCode: "parental_consent_required",
      actor,
    });
    throw new AppError("Verifiable parental consent is required before processing a child's personal data", 422);
  }

  if (!principal) {
    ({ principal, created } = await findOrCreatePrincipal({ models, pii }));
    principalId = principal.principalId;
  }

  // Persist the determination and the parental consent record (if any) on
  // the principal's identity document, not on the append-only ledger. Only a
  // CALLER-supplied record is written back - assigning the stored one onto
  // itself would be a no-op that reads like the caller had re-verified.
  principal.isMinor = isMinor;
  if (parentalConsent) principal.parentalConsent = parentalConsent;
  await principal.save();

  const now = new Date();
  // One receipt per submission. The docRef identifies the record and stays put
  // for the life of the principal; the receiptId identifies this act, and every
  // event this call appends carries it.
  const receiptId = generateDocRef("RC");

  // Upsert the notice body once per distinct version, before any event below
  // can reference it - so a stored noticeVersion can never point at a row
  // that does not exist yet. $setOnInsert means the same notice shown again
  // writes nothing new here: one row per distinct notice, not one per
  // submission.
  if (notice) {
    // The unique index on `version` is what makes this upsert an actual
    // dedup rather than a race between two concurrent submissions under the
    // same notice - and mongoose builds indexes in the background, so wait
    // for it first, same reasoning as ConsentRecord.init() below. Memoized,
    // so this costs nothing once the index exists. Content-addressing means
    // a lost race here could at worst duplicate a row with byte-identical
    // content, never corrupt or fork evidence the way an unindexed
    // ConsentRecord race would - but there is no reason to accept even that.
    await models.NoticeVersion.init();
    await models.NoticeVersion.updateOne(
      { version: notice.version },
      { $setOnInsert: { version: notice.version, language: notice.language, body: notice, firstSeenAt: now } },
      { upsert: true }
    );
  }

  /**
   * The delta for a given state. Taking state as an argument rather than
   * closing over one is what lets the duplicate-key recovery below recompute
   * against the winning document instead of replaying a stale decision.
   */
  const decideFor = (state) => {
    const events = [];
    const refused = [];
    const suppressed = [];
    for (const entry of getCatalog()) {
      // Parental consent unlocks nothing here: behavioural advertising and
      // tracking aimed at a child are refused outright, not merely
      // un-consented, and no event is written for them at all.
      if (isMinor && entry.prohibitedForChildren) {
        refused.push(entry.type);
        continue;
      }
      const current = state[entry.type] ? state[entry.type].status : undefined;
      const target = decide({ entry, current, chosen, consentSubmitted, regrant });
      // The one silent no-op in the state table: a re-grant of a WITHDRAWN
      // purpose submitted without regrant: true. decide() returns null for it
      // (see the `current === "withdrawn"` line in decide below), the caller
      // gets a 200 and a receipt naming no event, and nothing else records
      // that they asked at all. The condition is restated here rather than
      // reported by decide(), because decide() is pure, its return type is a
      // status or null, and 23 tests pin it.
      //
      // `!target` confirms decide() really returned null rather than a status
      // that happens to equal `current`. The lawfulBasis check keeps this in
      // exact step with decide's own early return for legitimate_use.
      if (
        !target &&
        entry.lawfulBasis.kind === "consent" &&
        current === "withdrawn" &&
        chosen.includes(entry.type) &&
        !regrant
      ) {
        suppressed.push(entry.type);
      }
      if (!target || target === current) continue;
      events.push({
        type: entry.type,
        status: target,
        basis: entry.lawfulBasis.description,
        lawfulBasisKind: entry.lawfulBasis.kind,
        receiptId,
        timestamp: now,
        // The notice IN FORCE WHEN THIS EVENT WAS WRITTEN, not the record's
        // most recent one - so an old event stays evidenced even after a
        // later submission's notice overwrites lastNotice below.
        noticeVersion: notice ? notice.version : undefined,
      });
    }
    return { events, refused, suppressed };
  };

  // A lightweight pointer only - the evidence itself is the NoticeVersion row
  // upserted above, plus each event's own noticeVersion. Kept in one place so
  // both the first attempt and the recovery below apply the same pointer.
  const snapshotNotice = (doc) => {
    if (notice) {
      doc.lastNotice = { version: notice.version, language: notice.language, shownAt: now };
    }
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

  let { events: newEvents, refused: refusedForChild, suppressed } = decideFor(record.currentState());
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
    ({ events: newEvents, refused: refusedForChild, suppressed } = decideFor(record.currentState()));
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

  // Instrumentation. Everything above is unchanged and nothing above depends
  // on any of it.
  //
  // It runs AFTER the save for two reasons. A submission that failed to save
  // must leave no trail row claiming it happened; and the duplicate-key
  // recovery above recomputes all three lists against the WINNING document,
  // so by here they are already the truthful ones. Recording inside decideFor,
  // or before the try, would double-write every row on the recovery path.

  if (refusedForChild.length) {
    await recordTrail(models, {
      principalId,
      kind: "consent_refused",
      outcome: "refused",
      reasonCode: "prohibited_for_child",
      actor,
      // ONE row naming N purposes, never N rows. An authenticated principal
      // can otherwise force roughly 17,000 inserts from one 100kb request.
      consentTypes: refusedForChild,
      count: refusedForChild.length,
      receiptId,
    });
  }

  if (suppressed.length) {
    await recordTrail(models, {
      principalId,
      kind: "consent_not_applied",
      outcome: "no_change",
      reasonCode: "regrant_not_requested",
      actor,
      consentTypes: suppressed,
      count: suppressed.length,
      receiptId,
    });
  }

  // decide() returns "withdrawn" for exactly one reason: a purpose the caller
  // OMITTED from a submission that carried a consent decision. That withdrawal
  // is in the ledger, so it is derived at read time and is never copied here.
  // What is recorded nowhere at all is that the host was not told: this
  // function has no onWithdrawal parameter and the router passes none, so the
  // cease-processing pipeline never runs. It is the fact a fiduciary most
  // needs, because it names a Section 6(6) duty that may have gone
  // undischarged - and recording that the hook did not fire is not the same as
  // firing it. See the README's residuals.
  const withdrawnByOmission = newEvents.filter((e) => e.status === "withdrawn").map((e) => e.type);
  if (withdrawnByOmission.length) {
    await recordTrail(models, {
      principalId,
      kind: "withdrawal_hook_not_fired",
      outcome: "recorded",
      actor,
      consentTypes: withdrawnByOmission,
      count: withdrawnByOmission.length,
      receiptId,
    });
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
    // Purposes prohibited for a minor - recomputed alongside newEvents, so it
    // stays truthful under the same create-race recovery.
    refusedForChild,
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
