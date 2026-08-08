const { Schema } = require("mongoose");

// Every grant, decline AND withdrawal is its own event, never overwritten -
// this is the audit trail DPDP expects a fiduciary to be able to produce.
// This document holds NO PII: PII lives on Principal so it can be erased
// without destroying the consent evidence.
//
// noticeVersion names the Section 5 notice that was in force when THIS event
// was written - not just the most recent one. The body it points to lives in
// NoticeVersion, content-addressed by this same string, so an old event's
// notice stays resolvable even after the catalog moves on and later events
// point at a different version. Not required: an event written by a direct
// service caller that passed no notice legitimately has none.
const consentEventSchema = new Schema(
  {
    type: { type: String, required: true },
    status: { type: String, enum: ["granted", "denied", "withdrawn"], required: true },
    basis: { type: String, required: true },
    lawfulBasisKind: { type: String, enum: ["consent", "legitimate_use"], required: true },
    receiptId: { type: String, required: true },
    timestamp: { type: Date, required: true, default: Date.now },
    noticeVersion: { type: String },
  },
  { _id: false }
);

// A lightweight pointer to the notice shown at the most recent submission -
// NOT the evidence itself. The evidence is the (version, body) pair in
// NoticeVersion, and the authoritative record of which version applied to a
// GIVEN event is that event's own noticeVersion above. This field exists only
// for a fast "what does this principal see right now" read.
const noticeSnapshotSchema = new Schema(
  {
    version: { type: String, required: true },
    language: { type: String, required: true },
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
