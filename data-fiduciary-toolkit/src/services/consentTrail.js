const { getValidConsentTypes } = require("../config/catalog");
const { assertOpaqueRef } = require("../utils/validate");
const { AppError } = require("../utils/errors");
const { assertPrincipalId } = require("../utils/validate");
const { findPrincipalByContact } = require("../utils/principalId");

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

// ---------------------------------------------------------------------------
// The trail read (design section 8.1)
// ---------------------------------------------------------------------------

// The caller's window onto the merge. `limit` is caller-supplied, so it is
// bounded by shape like every other input in this library.
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

// How many rows the read loads from ONE source before it stops. `limit`
// bounds what the caller sees; this bounds what the read has to hold in order
// to count the merge honestly. It sits well above MAX_LIMIT, and under the
// partition rule - the trail stores only what nothing else records - a
// principal's stored entries are single digits, so nothing this library
// writes comes near it.
const MAX_SCAN = 5000;

/**
 * The actor on every derived entry, because none of the five primary
 * collections records one: ConsentRecord.events, RightsRequest, Grievance,
 * ConsentManagerRequest and Principal.erasedAt each store what happened and
 * not who did it.
 *
 * Read as a claim about a person it would be wrong on at least one kind -
 * principal_erased is a fiduciary-side act, since erasePrincipalPII is
 * exported and deliberately unmounted (src/index.js:35-37). What it means is
 * "this came out of the principal's own record, and nothing observed who
 * acted". The entries that genuinely name an actor are the stored ones, which
 * is the whole reason design section 4 puts `actor` in the stored half.
 *
 * Frozen because one object is shared by every derived entry of every read.
 */
const DERIVED_ACTOR = Object.freeze({ role: "principal", channel: "library" });

/** ConsentRecord.events[].status -> the derived kind. The enum is closed to these three. */
const LEDGER_KIND = {
  granted: "consent_granted",
  denied: "consent_denied",
  withdrawn: "consent_withdrawn",
};

/**
 * Drops undefined-valued keys.
 *
 * The timeline element has twelve fields and most are undefined on most
 * entries. Keeping them as present-but-undefined keys would make the object a
 * direct library caller sees differ from the one an HTTP caller sees -
 * JSON.stringify drops undefined - so a deepEqual written against one would
 * not hold against the other. Dropping them here makes the two identical. A
 * consumer still never branches on source: entry.refId reads as undefined
 * either way.
 */
function compact(entry) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * `limit` bounds a slice rather than a query, but it is validated before use
 * for the same reason everything else here is: there is no honest way to
 * report `truncated` for a limit that is not a number, and an unbounded read
 * is the one read in the toolkit whose size a data principal can grow.
 */
function assertLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new AppError(`limit must be an integer between 1 and ${MAX_LIMIT}`, 400);
  }
  return value;
}

/**
 * Ordering: `at` descending, then stored before derived at the same instant,
 * then insertion order descending - the stored row's _id, or the ledger
 * event's array position.
 *
 * The tiebreak is real rather than theoretical. persistPIIwithconsent.js:146
 * stamps every event of one submission with the same `now`, so a signup
 * deciding five purposes produces five entries with identical timestamps, and
 * consentEventSchema is declared {_id: false} (ConsentRecord.js:24) so they
 * have no id to fall back on.
 *
 * Every derived entry that is not a ledger event takes ordinal 0. Its source
 * document does have an _id, but two documents from different collections
 * stamped in the same millisecond have no meaningful order between them, and
 * inventing one would be a claim the data does not support.
 * Array.prototype.sort is stable, so anything all three rules leave equal
 * keeps the order collect() below pushed it in.
 */
function byRecency(a, b) {
  const byTime = b.at.getTime() - a.at.getTime();
  if (byTime !== 0) return byTime;
  if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
  if (a.ordinal === b.ordinal) return 0;
  return a.ordinal > b.ordinal ? -1 : 1;
}

/**
 * A data principal's whole lineage: the stored trail entries merged with the
 * events design section 4 derives from the primary collections, newest first.
 *
 * Bounded, and deliberately WITHOUT a cursor. sanitizeFilter is set on this
 * library's connections (db/connection.js:29), which rewrites {at: {$lt: c}}
 * into {at: {$eq: {$lt: c}}} and CastErrors; the query-builder spellings
 * .where("at").lt(c) and .lt("at", c) are broken by it too. The only escapes
 * are mongoose.trusted() and aggregate(), and trusted() is a total bypass of
 * the connection's one structural injection guard. Under the partition rule a
 * normal principal has single-digit stored entries, so an explicit
 * `truncated` flag with a `totalEntries` count is honest and needs neither.
 *
 * Scoped by construction: principalId is in every filter, never checked after
 * the fact, and an id belonging to nobody and an id belonging to somebody
 * else produce the same 404 - the same reasoning as consentState.js:12-16.
 *
 * The element carries no noticeVersion. The notice in force for a given
 * consent event stays on getConsentState's ledger projection
 * (consentState.js:37), which is where a consumer resolves it; repeating it
 * here would make the derived half a different shape from the stored half,
 * and one shape for both is the property this read exists to provide.
 *
 * @param {object}  input
 * @param {object}  input.models
 * @param {string}  input.principalId
 * @param {number}  [input.limit=500]  - MERGED entries, not stored rows.
 * @param {boolean} [input.includeOperatorRefs=false] - include actor.ref and
 *   caseRef. False on the principal-facing read: that an operator read their
 *   record is exactly what a data principal is owed under Section 11, and
 *   which operator is the adopter's own staff member's personal data. True on
 *   the back-office read, where who and why is the point.
 * @returns {Promise<{ principalId, docRef, coverageFrom, timeline, truncated, totalEntries }>}
 */
async function getConsentTrail({ models, principalId, limit = DEFAULT_LIMIT, includeOperatorRefs = false }) {
  assertPrincipalId(principalId);
  const max = assertLimit(limit);

  // Plain equality filters, .sort() and .limit() only. sanitizeFilter makes
  // an operator filter CastError, so {at: {$gte: d}} is not available to this
  // library's own queries and no code here should grow one.
  const [record, principal, storedRows, rightsRequests, grievances, cmRequests] = await Promise.all([
    models.ConsentRecord.findOne({ principalId }).lean(),
    models.Principal.findOne({ principalId }).lean(),
    models.TrailEntry.find({ principalId }).sort({ at: -1, _id: -1 }).limit(MAX_SCAN).lean(),
    models.RightsRequest.find({ principalId }).sort({ createdAt: -1 }).limit(MAX_SCAN).lean(),
    models.Grievance.find({ principalId }).sort({ createdAt: -1 }).limit(MAX_SCAN).lean(),
    models.ConsentManagerRequest.find({ principalId }).sort({ createdAt: -1 }).limit(MAX_SCAN).lean(),
  ]);

  if (!record && !principal) throw new AppError("No record found for this principal", 404);

  const merged = [];
  const collect = (sourceRank, ordinal, entry) =>
    merged.push({ at: entry.at, sourceRank, ordinal, entry: compact(entry) });

  // The stored half: facts destroyed or never written anywhere else.
  for (const row of storedRows) {
    collect(0, String(row._id), {
      at: row.at,
      kind: row.kind,
      source: "stored",
      outcome: row.outcome,
      actor: includeOperatorRefs
        ? compact({ role: row.actor.role, ref: row.actor.ref, channel: row.actor.channel })
        : { role: row.actor.role, channel: row.actor.channel },
      reasonCode: row.reasonCode,
      refId: row.refId,
      receiptId: row.receiptId,
      consentTypes: row.consentTypes,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      count: row.count,
      caseRef: includeOperatorRefs ? row.caseRef : undefined,
    });
  }

  // The derived half. Never copied into the trail, always read from the
  // collection that already observed it.
  if (record) {
    record.events.forEach((event, index) => {
      collect(1, index, {
        at: event.timestamp,
        kind: LEDGER_KIND[event.status],
        source: "derived",
        outcome: "recorded",
        actor: DERIVED_ACTOR,
        receiptId: event.receiptId,
        // A one-element list, so the field means the same thing on a derived
        // entry as on a stored one that collapsed three refused purposes.
        consentTypes: [event.type],
      });
    });
  }

  for (const row of rightsRequests) {
    collect(1, 0, {
      at: row.createdAt,
      kind: "rights_request_filed",
      source: "derived",
      outcome: "recorded",
      actor: DERIVED_ACTOR,
      refId: row.refId,
    });
  }

  for (const row of grievances) {
    collect(1, 0, {
      at: row.createdAt,
      kind: "grievance_filed",
      source: "derived",
      outcome: "recorded",
      actor: DERIVED_ACTOR,
      refId: row.refId,
    });
    // Two entries from one document: filing and escalating are separate acts
    // with separate observed moments, and Grievance stores both.
    if (row.escalatedAt) {
      collect(1, 0, {
        at: row.escalatedAt,
        kind: "grievance_escalated",
        source: "derived",
        outcome: "recorded",
        actor: DERIVED_ACTOR,
        refId: row.refId,
      });
    }
  }

  for (const row of cmRequests) {
    collect(1, 0, {
      at: row.createdAt,
      kind: "consent_manager_requested",
      source: "derived",
      outcome: "recorded",
      actor: DERIVED_ACTOR,
      refId: row.refId,
    });
  }

  if (principal && principal.erasedAt) {
    collect(1, 0, {
      at: principal.erasedAt,
      kind: "principal_erased",
      source: "derived",
      outcome: "recorded",
      actor: DERIVED_ACTOR,
    });
  }

  merged.sort(byRecency);
  const totalEntries = merged.length;
  const timeline = merged.slice(0, max).map((row) => row.entry);

  return {
    principalId,
    // Null only if a principal exists with no consent record at all. The
    // trail read does not require a ledger to be able to answer.
    docRef: record ? record.docRef : null,
    // A module constant, returned verbatim. It exists so a trail with nothing
    // in it can say "we were not recording before this date" rather than
    // implying nothing happened. See design section 6 for why it is not a
    // stored marker row.
    coverageFrom: COVERAGE_FROM,
    timeline,
    truncated: totalEntries > timeline.length,
    totalEntries,
  };
}

/**
 * The trail for whoever a contact detail belongs to - the "given a direct
 * PII" half of the issue this feature answers.
 *
 * Deliberately NOT mounted on createRouter, and not for the usual reason. The
 * principal-facing rule is that principalId is a credential, so it never
 * comes from a payload; the input here is a raw email or phone number, which
 * is worse. A route taking one would let anyone who knows an address read
 * that person's entire lineage, and nothing in this library can prove the
 * caller controls the mailbox. src/http/backOfficeRouter.js is the supported
 * transport, and it exists precisely so that reaching this data requires
 * operator authentication and leaves an access record behind.
 *
 * It keeps findPrincipalByContact's phone branch, including its refusal of a
 * number that matches more than one data principal (utils/principalId.js:158-175).
 * A direct library caller is already inside the host's trust boundary, so the
 * household-handset ambiguity is a question the host can answer and an HTTP
 * surface cannot - which is why the back-office route is email-only and this
 * function is not.
 *
 * Writes no access record. The fail-closed disclosure log needs an operator
 * to attribute a read to; a call from host code has none, and filing one
 * under `unattributed` would put a row in the accountability record that
 * answers nobody's question. A host that calls this instead of mounting the
 * router owes its own operator_trail_read row.
 *
 * Operator references are withheld, because this takes the principal-facing
 * default. A back office wanting actor.ref and caseRef calls getConsentTrail
 * with includeOperatorRefs: true itself.
 *
 * @returns {Promise<object|null>} the same shape getConsentTrail returns, or
 *   null when no principal holds that contact detail.
 */
async function findConsentTrailByContact({ models, email, phone }) {
  const principal = await findPrincipalByContact({ models, email, phone });
  if (!principal) return null;
  return getConsentTrail({ models, principalId: principal.principalId });
}

module.exports = { COVERAGE_FROM, UNATTRIBUTED, recordTrail, recordTrailStrict, getConsentTrail, findConsentTrailByContact };
