const { mongoose } = require("../db/connection");
const { Schema } = mongoose;

// Every grant AND every withdrawal is its own event, never overwritten —
// this is the audit trail DPDP expects a fiduciary to be able to produce.
const consentEventSchema = new Schema(
  {
    type: { type: String, required: true }, // e.g. 'marketing'
    status: { type: String, enum: ["granted", "withdrawn"], required: true },
    basis: { type: String, required: true }, // legal basis snapshot at time of event
    timestamp: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

const consentRecordSchema = new Schema({
  principalId: { type: String, required: true, unique: true, index: true },
  docRef: { type: String, required: true, unique: true }, // consent receipt id
  pii: {
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    dob: Date,
    pan: String,
    address: String,
  },
  events: { type: [consentEventSchema], default: [] },
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

module.exports = mongoose.models.ConsentRecord || mongoose.model("ConsentRecord", consentRecordSchema);
