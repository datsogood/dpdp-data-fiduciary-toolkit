const { assertPrincipalId } = require("../utils/validate");
const { AppError } = require("../utils/errors");

/**
 * Erases a data principal's PII while preserving the consent ledger.
 *
 * The ledger is the fiduciary's own evidence that it had a lawful basis for
 * the processing it already did, so it is retained - pseudonymously, keyed
 * only by the random principalId. Erasure therefore clears the Principal
 * document's contact details, its lookup hashes, and the guardian's contact
 * details where a child's record carries them, which also means neither the
 * data principal nor their guardian can ever be re-identified from this
 * system by email or phone.
 *
 * Two fields are retained deliberately, and neither names anybody:
 * `isMinor` and `parentalConsent.verifiedAt`. See the inline note below for
 * why - they are what keeps the retained ledger legible as evidence.
 *
 * This is irreversible by design.
 *
 * KNOWN LIMIT, and it must stay documented rather than implied away: this
 * clears the Principal document only. A data principal who typed their own
 * name, email or address into the free-text body of a grievance, a rights
 * request or a consent-manager request still has that text in those
 * collections, and this function does not touch it. Redacting free text is a
 * judgement call an automated pass gets wrong, so it is left to the
 * fiduciary's own process - but a deployment that treats this function as
 * completing a Section 12 erasure request, without also reviewing those three
 * collections, has not completed it.
 */
async function erasePrincipalPII({ models, principalId }) {
  assertPrincipalId(principalId);

  const principal = await models.Principal.findOne({ principalId });
  if (!principal) throw new AppError("No principal found for that id", 404);
  if (principal.erasedAt) return { principalId, erasedAt: principal.erasedAt, alreadyErased: true };

  const erasedAt = new Date();
  principal.pii = { name: undefined, email: undefined, phone: undefined, dob: undefined, pan: undefined, address: undefined };
  principal.emailHash = undefined;
  principal.phoneHash = undefined;
  // The GUARDIAN's personal data, written by persistPIIwithconsent. Clearing
  // pii and the two hashes left this behind entirely, and the asymmetry was
  // the worst part of it: the child's own email is stored as a keyed HMAC and
  // is destroyed above, while the parent's is stored in PLAINTEXT and
  // survived - on a document stamped erasedAt, which getConsentState reports
  // as `pii: null`, so the toolkit's own Section 11 read concealed it.
  //
  // verifiedAt is RETAINED, deliberately. It names no one: it is a fact about
  // the fiduciary's own process, not personal data about the guardian. And it
  // is the only surviving evidence that the consent events kept in the ledger
  // below had the lawful basis Section 9 requires for a child - the same
  // trade the ledger itself makes, and for the same reason. Destroy the
  // identity, keep the pseudonymous evidence.
  principal.parentalConsent = {
    name: undefined,
    email: undefined,
    relationship: undefined,
    verifiedAt: principal.parentalConsent ? principal.parentalConsent.verifiedAt : undefined,
  };
  // isMinor is RETAINED for the same reason, and it is not personal data once
  // the PII and both hashes are gone - it is a bare boolean on a pseudonymous
  // record. It is also what makes the retained ledger legible: a child's
  // ledger has no marketing or analytics events because Section 9 prohibits
  // them, and without this flag that absence cannot be told apart from an
  // adult who simply declined.
  principal.erasedAt = erasedAt;
  principal.updatedAt = erasedAt;
  await principal.save();

  return { principalId, erasedAt, alreadyErased: false };
}

module.exports = { erasePrincipalPII };
