const { AppError } = require("./errors");

const PRINCIPAL_ID_RE = /^[a-f0-9]{64}$/;

// A host-supplied reference to one of the host's own records - a staff id in
// actor.ref, a ticket id in caseRef. Positive shape, deliberately not a
// blocklist: it admits a staff id, a UUID, an LDAP uid and a ticket
// reference, and admits no address, no phone number with punctuation and no
// space, so free text and contact details cannot arrive by accident.
const OPAQUE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Guards a principalId before it is ever used in a query filter. Mongoose
 * does NOT strip query operators during schema casting - `{$gt: ""}` on a
 * String path reaches MongoDB verbatim and matches every document - so a
 * shape check here is the actual control, not a nicety.
 */
function assertPrincipalId(value, field = "principalId") {
  if (typeof value !== "string" || !PRINCIPAL_ID_RE.test(value)) {
    throw new AppError(`${field} must be a 64-character hex string`, 400);
  }
  return value;
}

function assertNonEmptyString(value, field, maxLength = 2000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(`${field} is required and must be a string`, 400);
  }
  if (value.length > maxLength) {
    throw new AppError(`${field} must be at most ${maxLength} characters`, 400);
  }
  return value;
}

/**
 * Guards actor.ref and caseRef before either is stored on a trail entry or
 * used in a query filter.
 *
 * The shape is positive because this file's only existing discipline is a
 * positive regex (PRINCIPAL_ID_RE above). An earlier draft rejected any value
 * containing "@", which stops an email and nothing else - a staff member's
 * name or a phone number passed it unharmed.
 *
 * It bounds the shape, not the meaning. "johnsmith" still passes, so a host
 * that wires its SSO subject straight through can still put personal data on
 * a collection nothing deletes from. The README states that as a residual
 * rather than implying otherwise.
 */
function assertOpaqueRef(value, field) {
  if (typeof value !== "string" || !OPAQUE_REF_RE.test(value)) {
    throw new AppError(
      `${field} must be 1-64 characters of letters, digits, dot, underscore, colon or hyphen, starting with a letter or digit`,
      400
    );
  }
  return value;
}

function assertStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new AppError(`${field} must be an array of strings`, 400);
  }
  return value;
}

module.exports = { assertPrincipalId, assertNonEmptyString, assertStringArray, assertOpaqueRef };
