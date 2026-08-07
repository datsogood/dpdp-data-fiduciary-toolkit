const { Schema } = require("mongoose");

const grievanceSchema = new Schema({
  principalId: { type: String, required: true, index: true },
  refId: { type: String, required: true, unique: true },
  subject: { type: String, required: true, maxlength: 200 },
  description: { type: String, required: true, maxlength: 10000 },
  addressedTo: { type: String, required: true }, // the fiduciary's Grievance Officer, per Section 13
  status: { type: String, enum: ["open", "in_progress", "resolved", "escalated"], default: "open" },
  slaDueAt: { type: Date, required: true },
  escalatedToBoard: { type: Boolean, default: false },
  escalatedAt: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = {
  schema: grievanceSchema,
  build: (connection) => connection.model("Grievance", grievanceSchema),
};
