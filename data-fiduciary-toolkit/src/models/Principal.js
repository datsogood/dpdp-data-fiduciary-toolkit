const { Schema } = require("mongoose");

/**
 * A data principal's identity and contact details.
 *
 * Deliberately separate from ConsentRecord: the Act requires PII to be
 * erasable on request AND requires the fiduciary to retain proof it had a
 * lawful basis. With PII and the ledger in one document those two duties are
 * mutually exclusive - deleting the document destroys the evidence, and
 * blanking required PII fields fails validation. Splitting them lets erasure
 * clear this document while the pseudonymous ledger survives.
 *
 * emailHash / phoneHash are keyed HMACs, not bare hashes, so knowing an
 * email does not let anyone compute the lookup key. They are the only
 * queryable form of the contact details.
 */
const principalSchema = new Schema({
  principalId: { type: String, required: true, unique: true, index: true },
  emailHash: { type: String, index: true, sparse: true },
  phoneHash: { type: String, index: true, sparse: true },
  pii: {
    name: String,
    email: String,
    phone: String,
    dob: Date,
    pan: String,
    address: String,
  },
  erasedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = {
  schema: principalSchema,
  build: (connection) => connection.model("Principal", principalSchema),
};
