const { Schema } = require("mongoose");

// Every grant, decline AND withdrawal is its own event, never overwritten -
// this is the audit trail DPDP expects a fiduciary to be able to produce.
// This document holds NO PII: PII lives on Principal so it can be erased
// without destroying the consent evidence.
const consentEventSchema = new Schema(
  {
    type: { type: String, required: true },
    status: { type: String, enum: ["granted", "denied", "withdrawn"], required: true },
    basis: { type: String, required: true },
    lawfulBasisKind: { type: String, enum: ["consent", "legitimate_use"], required: true },
    receiptId: { type: String, required: true },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

// The Section 5 notice shown at the moment of the most recent submission -
// the evidence of what the principal was told, not just that they consented.
// One snapshot per record, overwritten on each submission. This is the
// spec's choice, made for size - see the Task 8 report for the case that the
// evidentiary argument runs the other way, since it means an older event's
// notice is unrecoverable once a later submission overwrites this field.
const noticeSnapshotSchema = new Schema(
  {
    version: { type: String, required: true },
    language: { type: String, required: true },
    body: { type: Schema.Types.Mixed },
    shownAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const consentRecordSchema = new Schema({
  principalId: { type: String, required: true, unique: true, index: true },
  docRef: { type: String, required: true, unique: true },
  events: { type: [consentEventSchema], default: [] },
  lastNotice: { type: noticeSnapshotSchema, default: undefined },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

/** Current status per consent type, derived from the latest event of each type. */
consentRecordSchema.methods.currentState = function currentState() {
  const latestByType = {};
  for (const event of this.events) {
    const existing = latestByType[event.type];
    if (!existing || event.timestamp >= existing.timestamp) latestByType[event.type] = event;
  }
  return latestByType;
};

module.exports = {
  schema: consentRecordSchema,
  build: (connection) => connection.model("ConsentRecord", consentRecordSchema),
};
