const { mongoose } = require("../db/connection");
const { Schema } = mongoose;

const rightsRequestSchema = new Schema({
  principalId: { type: String, required: true, index: true },
  refId: { type: String, required: true, unique: true },
  right: { type: String, required: true }, // 'access' | 'correction' | 'erasure' | 'nominate'
  details: { type: String, default: "", maxlength: 5000 }, // free-text specifics, e.g. what to correct
  status: { type: String, enum: ["received", "in_progress", "closed"], default: "received" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.RightsRequest || mongoose.model("RightsRequest", rightsRequestSchema);
