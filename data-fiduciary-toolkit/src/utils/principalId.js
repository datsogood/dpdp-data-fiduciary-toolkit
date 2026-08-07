const crypto = require("node:crypto");
const { AppError } = require("./errors");
const { assertPrincipalId } = require("./validate");

/**
 * A data principal's identifier is RANDOM, not derived.
 *
 * It used to be sha256(email), which meant anyone who knew a person's email
 * could compute their identifier and act as them against every endpoint.
 * A random id carries no information and cannot be guessed.
 */
function newPrincipalId() {
  return crypto.randomBytes(32).toString("hex");
}

function secret() {
  const s = process.env.PRINCIPAL_ID_SECRET;
  if (!s) {
    throw new AppError(
      "PRINCIPAL_ID_SECRET is not set - it is required to derive contact lookup hashes. Generate one with: openssl rand -hex 32",
      500
    );
  }
  return s;
}

/**
 * Keyed, one-way lookup hash for a contact detail. Keyed so that an attacker
 * who knows the email cannot compute the stored value; normalised so that
 * casing and stray whitespace still match the same person.
 *
 * Pseudonymous, not anonymous - the output is still personal data.
 */
function lookupHash(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("A non-empty string is required to derive a lookup hash", 400);
  }
  return crypto.createHmac("sha256", secret()).update(value.trim().toLowerCase()).digest("hex");
}

/**
 * Reference id. 8 random bytes rather than 3 - the old 24 bits inside a
 * single millisecond made same-millisecond collisions plausible, and the
 * timestamp prefix made references partially predictable.
 */
function generateDocRef(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
}

/**
 * SIGNUP path. Finds an existing principal by whichever contact detail is the
 * stronger identifier, and creates one if there is no match.
 *
 * Matching rule, and why it is not "either hash matches":
 *
 *   - email supplied -> match on emailHash ONLY.
 *   - no email       -> match on phoneHash.
 *
 * A phone number is not a person. The stated audience is social and public
 * sector beneficiaries, who routinely share one handset across a household, so
 * "same phone" cannot mean "same data principal": if a mother registers with
 * phone X and her daughter then registers a different email with phone X,
 * matching on phone would either hand the daughter her mother's record or - once
 * the router's existence check is in place - refuse to register the daughter at
 * all. Neither is acceptable.
 *
 * That means a plain email correction is NOT inferred here (an email that
 * matches nothing creates a new principal). Correcting an email is an
 * authenticated operation - see updatePrincipalContact, which takes identity
 * from the session rather than guessing it from the payload. That is the same
 * principle as C1: never infer identity from caller-supplied contact details.
 */
async function findOrCreatePrincipal({ models, pii }) {
  if (!pii || typeof pii !== "object") throw new AppError("pii is required", 400);
  const { name, email, phone } = pii;
  if (!name || typeof name !== "string") throw new AppError("pii.name is required", 400);
  if (!email && !phone) throw new AppError("pii.email or pii.phone is required", 400);
  if (email && typeof email !== "string") throw new AppError("pii.email must be a string", 400);
  if (phone && typeof phone !== "string") throw new AppError("pii.phone must be a string", 400);

  const emailHash = email ? lookupHash(email) : undefined;
  const phoneHash = phone ? lookupHash(phone) : undefined;

  // Email is the stronger identifier. Fall back to phone only when there is no
  // email at all - see the docstring on why a shared phone must not merge two
  // people.
  const filter = emailHash ? { emailHash } : { phoneHash };
  let principal = await models.Principal.findOne(filter);
  const created = !principal;

  if (created) {
    principal = new models.Principal({ principalId: newPrincipalId() });
  }

  principal.pii = { ...(principal.pii ? principal.pii.toObject() : {}), ...pii };
  if (emailHash) principal.emailHash = emailHash;
  if (phoneHash) principal.phoneHash = phoneHash;
  principal.updatedAt = new Date();
  await principal.save();

  return { principal, created };
}

/**
 * Read-only lookup by contact details. Creates nothing, modifies nothing.
 *
 * The router needs this to decide whether POST /consent is a signup or an
 * update BEFORE it writes anything. Deciding after the write - by reading
 * findOrCreatePrincipal's `created` flag - would mean an unauthenticated
 * caller had already overwritten an existing person's name, phone, PAN and
 * address by the time the 409 was sent, which is the whole of the C1 attack.
 */
async function findPrincipalByContact({ models, email, phone }) {
  // Must use the SAME matching rule as findOrCreatePrincipal, or the router's
  // existence check and the service's lookup disagree: the router would 409 a
  // person the service would have treated as new, or vice versa.
  if (email && typeof email === "string") {
    return models.Principal.findOne({ emailHash: lookupHash(email) });
  }
  if (phone && typeof phone === "string") {
    return models.Principal.findOne({ phoneHash: lookupHash(phone) });
  }
  return null;
}

/**
 * AUTHENTICATED contact correction. Identity comes from principalId - which the
 * router takes from resolvePrincipal, never from the payload - so correcting an
 * email cannot be used to reach another person's record.
 *
 * This is the path that satisfies the Section 12 right to correction without
 * orphaning the consent history, and it is deliberately separate from signup:
 * inferring "same person" from a shared phone number would merge two members of
 * a household who share a handset.
 */
async function updatePrincipalContact({ models, principalId, pii }) {
  assertPrincipalId(principalId);
  if (!pii || typeof pii !== "object") throw new AppError("pii is required", 400);

  const principal = await models.Principal.findOne({ principalId });
  if (!principal) throw new AppError("No principal found for that id", 404);

  // If the new contact detail already belongs to someone else, refuse rather
  // than silently merging two people's records.
  for (const [field, hashField] of [["email", "emailHash"], ["phone", "phoneHash"]]) {
    if (!pii[field]) continue;
    const hash = lookupHash(pii[field]);
    const clash = await models.Principal.findOne({ [hashField]: hash, principalId: { $ne: principalId } });
    if (clash) throw new AppError(`That ${field} is already registered to another data principal`, 409);
    principal[hashField] = hash;
  }

  principal.pii = { ...(principal.pii ? principal.pii.toObject() : {}), ...pii };
  principal.updatedAt = new Date();
  await principal.save();
  return principal;
}

async function findPrincipalById({ models, principalId }) {
  assertPrincipalId(principalId);
  return models.Principal.findOne({ principalId });
}

module.exports = {
  newPrincipalId,
  lookupHash,
  generateDocRef,
  findOrCreatePrincipal,
  findPrincipalByContact,
  findPrincipalById,
  updatePrincipalContact,
};
