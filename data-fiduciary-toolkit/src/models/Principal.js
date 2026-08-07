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
  // Unique: email is the stronger identifier, so two principals answering to
  // the same emailHash would make findOne({ emailHash }) resolve to an
  // arbitrary one of them. Sparse, so erased documents (which $unset this
  // field) and phone-only principals (which never set it) don't collide.
  emailHash: { type: String, index: true, unique: true, sparse: true },
  // Deliberately NOT unique: a household shares one handset, so two
  // legitimate principals sharing a phoneHash is normal, not a conflict.
  phoneHash: { type: String, index: true, sparse: true },
  pii: {
    name: String,
    email: String,
    phone: String,
    dob: Date,
    pan: String,
    address: String,
  },
  // Set by persistPIIwithconsent's age gate from pii.dob at the time of that
  // call - Section 9 of the Act requires a child's data to be treated
  // differently, so this determination has to live somewhere the rest of the
  // toolkit can trust rather than being recomputed ad hoc.
  isMinor: { type: Boolean },
  // Server-side only: no route or form accepts this field. A child typing a
  // parent's name and a verifiedAt timestamp into a public form is not
  // verifiable parental consent - see the README's "What this is not".
  parentalConsent: {
    name: String,
    email: String,
    relationship: String,
    verifiedAt: Date,
  },
  erasedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = {
  schema: principalSchema,
  build: (connection) => connection.model("Principal", principalSchema),
};
