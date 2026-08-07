const { assertPrincipalId } = require("../utils/validate");
const { AppError } = require("../utils/errors");

/**
 * Erases a data principal's PII while preserving the consent ledger.
 *
 * The ledger is the fiduciary's own evidence that it had a lawful basis for
 * the processing it already did, so it is retained - pseudonymously, keyed
 * only by the random principalId. Erasure therefore clears the Principal
 * document's contact details and its lookup hashes, which also means the
 * person can never be re-identified from this system by email or phone.
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
  principal.erasedAt = erasedAt;
  principal.updatedAt = erasedAt;
  await principal.save();

  return { principalId, erasedAt, alreadyErased: false };
}

module.exports = { erasePrincipalPII };
