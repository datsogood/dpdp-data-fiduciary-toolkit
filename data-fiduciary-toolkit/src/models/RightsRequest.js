const { Schema } = require("mongoose");

const rightsRequestSchema = new Schema({
  principalId: { type: String, required: true, index: true },
  refId: { type: String, required: true, unique: true },
  right: { type: String, required: true }, // 'access' | 'correction' | 'erasure' | 'nominate'
  details: { type: String, default: "", maxlength: 5000 }, // free-text specifics, e.g. what to correct
  status: { type: String, enum: ["received", "in_progress", "closed"], default: "received" },
  slaDueAt: { type: Date, required: true },
  resolution: { type: String, default: "", maxlength: 5000 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = {
  schema: rightsRequestSchema,
  build: (connection) => connection.model("RightsRequest", rightsRequestSchema),
};
