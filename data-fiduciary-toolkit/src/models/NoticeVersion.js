const { Schema } = require("mongoose");

// One row per DISTINCT notice ever shown, not one per consent event. The
// same notice is shown to every data principal until the catalog or config
// changes, so storage grows with the number of versions, not the number of
// submissions - upserted with $setOnInsert in persistPIIwithconsent so a
// repeat of an unchanged notice writes nothing new here.
const noticeVersionSchema = new Schema({
  version: { type: String, required: true, unique: true, index: true },
  language: { type: String, required: true },
  body: { type: Schema.Types.Mixed, required: true },
  firstSeenAt: { type: Date, default: Date.now },
});

module.exports = {
  schema: noticeVersionSchema,
  build: (connection) => connection.model("NoticeVersion", noticeVersionSchema),
};
