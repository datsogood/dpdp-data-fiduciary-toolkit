const { Schema } = require("mongoose");

// Under Section 6(7)-(9), a Consent Manager is a separate, Board-registered
// entity a data principal can route their consent through. This model
// captures a principal asking to be connected to one - it is NOT the
// fiduciary's own consent record.
const consentManagerRequestSchema = new Schema({
  principalId: { type: String, required: true, index: true },
  refId: { type: String, required: true, unique: true },
  message: { type: String, default: "", maxlength: 5000 },
  preferredConsentManager: { type: String, default: "", maxlength: 200 }, // optional, if the principal names one
  status: { type: String, enum: ["received", "connected", "closed"], default: "received" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = {
  schema: consentManagerRequestSchema,
  build: (connection) => connection.model("ConsentManagerRequest", consentManagerRequestSchema),
};
