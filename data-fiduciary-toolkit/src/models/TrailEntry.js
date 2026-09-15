const { Schema } = require("mongoose");

/**
 * One entry in a data principal's audit trail.
 *
 * NOT named AuditEvent: ConsentRecord.js already says of the ledger "this is
 * the audit trail DPDP expects a fiduciary to be able to produce", and a
 * second collection claiming that word would contradict a comment that ships
 * today. A trail ENTRY is a part of the trail; the trail itself is the merged
 * read across this collection and four primary ones.
 *
 * The partition rule this schema exists to serve: a row is written here only
 * for a fact that is destroyed, or never written, anywhere else. Anything a
 * read can recover from a primary collection - a grant, a withdrawal, a
 * grievance being filed, an erasure - is derived at read time from its own
 * observed timestamp and is never copied here. That is what makes
 * double-reporting impossible by construction instead of by a dedup pass.
 *
 * It holds no free text and no direct PII, and it survives erasure as
 * pseudonymous evidence exactly as ConsentRecord does. There is deliberately
 * no contact-hash field of any kind: a row carrying both a contact hash and a
 * principalId would rebuild the email-to-person index erasure exists to
 * destroy, and on a lookup that matched nobody it would mint a permanent
 * contact-derived identifier for someone who is not a data principal of this
 * fiduciary at all. An earlier draft closed the first hazard with a schema
 * validator enforcing mutual exclusion; that does not hold, because updateOne
 * does not run document validators and a later $set would co-store both
 * silently. A field that does not exist cannot be set.
 */

// role: `unattributed` is NOT a synonym for `system`. It means the library
// genuinely does not know who acted - a direct service call from host code -
// and claiming "system" would be a claim it cannot back.
//
// ref: set only for an operator. Host-supplied and opaque, guarded by
// assertOpaqueRef in utils/validate.js before it ever reaches this schema.
// Indexed because detecting insider enumeration is a question of per-operator
// volume, and that index is the whole answer to it.
const actorSchema = new Schema(
  {
    role: { type: String, enum: ["principal", "operator", "system", "unattributed"], required: true },
    ref: { type: String, index: true },
    channel: { type: String, enum: ["html", "api", "library"], required: true },
  },
  { _id: false }
);

// Eleven kinds. Every one exists because something is otherwise destroyed -
// there is no kind here whose fact could be read back off a primary
// collection instead.
const KINDS = [
  "consent_not_applied",
  "consent_refused",
  "withdrawal_not_applied",
  "age_gate_refused",
  "request_status_changed",
  "escalation_refused",
  "contact_corrected",
  "contact_mismatch_refused",
  "withdrawal_hook_not_fired",
  "operator_lookup",
  "operator_trail_read",
];

const REASON_CODES = [
  "regrant_not_requested",
  "prohibited_for_child",
  // Written by withdrawal_not_applied only (Task 4). The spec's kind table also
  // pairs it with consent_refused, but that pair is deliberately never written:
  // persistPIIwithconsent.js:83-84 throws AppError 400 on an unknown type before
  // any principal is resolved and before any write, so there is no subject to
  // file the row under and no act to record beyond the 400 itself.
  "unknown_consent_type",
  "record_erased",
  "not_withdrawable",
  "not_granted",
  "parental_consent_required",
  "already_resolved",
  "already_escalated",
  "sla_not_lapsed",
  "not_own_contact",
  "no_match",
];

const trailEntrySchema = new Schema({
  // Absent - not null - on the two kinds that have no subject: an age-gate
  // refusal is thrown before findOrCreatePrincipal runs, and a back-office
  // lookup that matched nobody has no principal to file under. A stored null
  // would be a subject-shaped hole a later read could mistake for one.
  principalId: { type: String, index: true },
  at: { type: Date, required: true, default: Date.now },
  kind: { type: String, enum: KINDS, required: true },
  // recorded  - the act took effect
  // refused   - the library declined it and said so
  // no_change - the caller got a 2xx and nothing happened
  //
  // Required, because it is the single field that stops a refusal from ever
  // being read back as a state change.
  outcome: { type: String, enum: ["recorded", "refused", "no_change"], required: true },
  reasonCode: { type: String, enum: REASON_CODES },
  // Required on every row, including the ones whose honest answer is
  // `unattributed`. A trail entry that does not say who acted is not evidence.
  actor: { type: actorSchema, required: true },
  // Reference ids only, never free text. All are random and carry no PII.
  refId: { type: String }, // RQ- / GR- / CM-
  receiptId: { type: String }, // RC-
  // A LIST, because one call refusing three purposes writes one row naming
  // three rather than three rows. Verified - a scalar String path rejects an
  // array with "Cast to string failed ... (type Array)".
  //
  // Every element is validated against getValidConsentTypes() BY THE WRITER
  // and dropped when it does not match. A withdrawal naming an unknown purpose
  // carries caller-supplied text verbatim, and assertStringArray applies no
  // content check, so an email typed into consentTypes would otherwise reach a
  // collection that survives erasure.
  consentTypes: { type: [String], default: undefined },
  // The transition requestLifecycle overwrites in place. updatedAt holds only
  // the last change, so a status that moved received -> in_progress -> closed
  // has its middle transition destroyed unless it is stored here.
  //
  // contact_corrected is the one kind that is not a lifecycle transition: it
  // reuses toStatus to name which contact field changed ("email", "phone" or
  // "email+phone", never a value or a hash of one) and never sets fromStatus.
  fromStatus: { type: String },
  toStatus: { type: String },
  // Collapsed refusals: one row per (kind, reasonCode) per call. Without it a
  // submission naming 200 consent types would write 200 rows.
  count: { type: Number },
  // The adopter's own ticket reference for a back-office access, so the record
  // says WHY someone was looked up and not only by whom. Host-supplied and
  // opaque; carried only on operator_lookup and operator_trail_read, never
  // rendered back to a data principal. Guarded by assertOpaqueRef.
  caseRef: { type: String },
});

// No compound index, no unique index, no schema.index() call. The repo has
// none today, and under the partition rule the per-principal volume is single
// digits - a compound index would be the first deviation, bought with nothing.
// Ordering is (at desc, _id desc); within one millisecond, insertion order by
// ObjectId is honest and adequate.

module.exports = {
  schema: trailEntrySchema,
  build: (connection) => connection.model("TrailEntry", trailEntrySchema),
};
