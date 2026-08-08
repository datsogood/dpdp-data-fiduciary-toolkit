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
  if (!s || !s.trim() || s.trim().length < 32) {
    throw new AppError(
      "PRINCIPAL_ID_SECRET is not set or too weak - it must be at least 32 characters to derive contact lookup hashes safely. Generate one with: openssl rand -hex 32",
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
 *   - no email       -> match NOTHING. Always create.
 *
 * A phone number is not a person, and it is not a weaker identifier either -
 * it is not an identifier at all. The stated audience is social and public
 * sector beneficiaries, who often have no email and routinely share one
 * handset across a household, so "same phone" cannot mean "same data
 * principal".
 *
 * Falling back to phoneHash when there was no email looked like a harmless
 * concession to that population and was the opposite: a mother registering
 * phone-only, then her daughter registering the same handset with no email of
 * her own, matched the mother's document - and the router's pre-write
 * existence check turned that match into a 409, so the daughter could not
 * register AT ALL. That is the exact population the design names, permanently
 * locked out. Two members of one household who both lack an email is not an
 * edge case for this audience, it is the common case.
 *
 * The residual cost is a duplicate record when a phone-only person resubmits,
 * because nothing on file can tell "the same woman again" from "her sister".
 * That is recoverable by the host - it holds whatever real-world knowledge
 * would disambiguate them. A permanently unregistrable beneficiary is not
 * recoverable, and an account takeover is worse than either.
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

  // mongoose builds indexes in the background after a model is first
  // registered - without waiting for that, the unique index on emailHash
  // (the actual backstop for the race below) is not yet enforced, and two
  // concurrent signups for the same email can both succeed. init() is a
  // memoized no-op after the first call, so this costs nothing once the
  // index exists.
  await models.Principal.init();

  const emailHash = email ? lookupHash(email) : undefined;
  const phoneHash = phone ? lookupHash(phone) : undefined;

  // Email is the ONLY thing signup matches on. With no email there is nothing
  // here that identifies anybody, so this always creates - see the docstring
  // for why matching on a shared handset locked a household out entirely.
  let principal = emailHash ? await models.Principal.findOne({ emailHash }) : null;
  const created = !principal;

  if (created) {
    principal = new models.Principal({ principalId: newPrincipalId() });
  }

  principal.pii = { ...(principal.pii ? principal.pii.toObject() : {}), ...pii };
  if (emailHash) principal.emailHash = emailHash;
  if (phoneHash) principal.phoneHash = phoneHash;
  principal.updatedAt = new Date();
  try {
    await principal.save();
  } catch (err) {
    // Two concurrent signups for the same email can both pass the findOne
    // check above before either has written - the unique index on emailHash
    // is the backstop. Without this catch, the loser of that race would
    // surface as a raw Mongo duplicate-key error instead of a clean conflict.
    if (err && err.code === 11000) {
      throw new AppError("That email is already registered to another data principal", 409);
    }
    throw err;
  }

  return { principal, created };
}

/**
 * Read-only lookup by contact details. Creates nothing, modifies nothing.
 *
 * This is the building block for a host's own sign-in: turn a contact detail
 * the host has ALREADY verified the person controls - a clicked email link, a
 * completed OTP - into the principalId resolvePrincipal must return.
 *
 * A phone number never resolves on its own to a single data principal, so the
 * phone branch REFUSES an ambiguous number instead of guessing. It used to
 * answer a deliberately non-unique phoneHash with findOne, which returns an
 * arbitrary match: a mother registers phone-only, her daughter registers her
 * own email on the same handset, and the lookup for that number answers with
 * the MOTHER. A daughter completing an OTP on the household handset would be
 * issued a session for her mother - reading her PII and her consent ledger,
 * and able to append irreversible withdrawals to it. Verifying control of the
 * handset is not the same as verifying which household member is holding it,
 * and only the host can close that gap.
 *
 * The router does NOT use the phone branch. Its pre-write existence check on
 * POST /consent passes email only, matching findOrCreatePrincipal, which
 * matches on emailHash and nothing else - a phone-only signup must always
 * create rather than 409 a beneficiary who shares a handset.
 */
async function findPrincipalByContact({ models, email, phone }) {
  if (email && typeof email === "string") {
    return models.Principal.findOne({ emailHash: lookupHash(email) });
  }
  if (phone && typeof phone === "string") {
    // limit(2) - one row is enough to answer with, two is enough to refuse
    // with, and nothing here needs to count the whole household.
    const rows = await models.Principal.find({ phoneHash: lookupHash(phone) }).limit(2);
    if (rows.length > 1) {
      throw new AppError(
        "That phone number identifies more than one data principal - it cannot be used on its own to sign in",
        409
      );
    }
    return rows[0] || null;
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

  // See the matching call in findOrCreatePrincipal: the unique index on
  // emailHash is only an effective backstop once mongoose has finished
  // building it, and init() is a memoized no-op after the first call.
  await models.Principal.init();

  const principal = await models.Principal.findOne({ principalId });
  if (!principal) throw new AppError("No principal found for that id", 404);

  // Erasure is terminal. Without this, an authenticated caller - or anyone
  // holding a session issued before the erasure - can write PII straight back
  // onto an erased record, leaving a document that claims erasedAt while
  // holding live PII. That is the worst possible artefact to hand a regulator.
  if (principal.erasedAt) {
    throw new AppError("This data principal's record has been erased and cannot be updated", 409);
  }

  // Email uniqueness only. phoneHash is deliberately non-unique because a
  // household shares a handset, so a phone clash is NOT an error - and checking
  // it would 409 a beneficiary merely for resubmitting their own unchanged
  // phone number, locking the stated audience out of the Section 12 correction
  // right entirely.
  if (pii.phone) principal.phoneHash = lookupHash(pii.phone);

  if (pii.email) {
    const hash = lookupHash(pii.email);
    // Resubmitting your own unchanged email is never a clash.
    if (principal.emailHash !== hash) {
      // NO query operator here, deliberately. connect() sets sanitizeFilter on
      // every connection this library opens, which rewrites { $ne: x } into
      // { $eq: { $ne: x } } - and casting that object onto a String path
      // throws CastError. So the previous { principalId: { $ne: principalId } }
      // filter made EVERY real email correction throw, which the router's
      // error mapper reported as "400 Invalid value for: principalId", naming
      // a field the caller never supplied, and the documented 409-on-clash
      // guarantee below never executed at all. emailHash is unique, so at most
      // one document can match; comparing the id in JavaScript needs no
      // operator and cannot be rewritten out from under us.
      const clash = await models.Principal.findOne({ emailHash: hash });
      if (clash && clash.principalId !== principalId) {
        throw new AppError("That email is already registered to another data principal", 409);
      }
      principal.emailHash = hash;
    }
  }

  principal.pii = { ...(principal.pii ? principal.pii.toObject() : {}), ...pii };
  principal.updatedAt = new Date();
  try {
    await principal.save();
  } catch (err) {
    // Backstop for the same check-then-act race as findOrCreatePrincipal: two
    // concurrent corrections claiming the same new email can both pass the
    // findOne check above before either has written.
    if (err && err.code === 11000) {
      throw new AppError("That email is already registered to another data principal", 409);
    }
    throw err;
  }
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
