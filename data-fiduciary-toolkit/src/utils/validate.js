const { AppError } = require("./errors");

const PRINCIPAL_ID_RE = /^[a-f0-9]{64}$/;

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

function assertStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new AppError(`${field} must be an array of strings`, 400);
  }
  return value;
}

module.exports = { assertPrincipalId, assertNonEmptyString, assertStringArray };
