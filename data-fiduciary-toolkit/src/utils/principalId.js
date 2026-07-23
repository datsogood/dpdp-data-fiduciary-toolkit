const crypto = require("crypto");

/**
 * Derives a stable, non-reversible identifier for a data principal from
 * their email. Used as the correlation key across consent records, rights
 * requests, grievances, and consent-manager requests — so we're not passing
 * raw PII around as a lookup key.
 */
function derivePrincipalId(email) {
  if (!email || typeof email !== "string") {
    throw new Error("A valid email is required to derive a principal ID");
  }
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function generateDocRef(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

module.exports = { derivePrincipalId, generateDocRef };
