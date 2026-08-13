/**
 * True when the client actually prefers HTML.
 *
 * Express req.accepts("html") is the trap: it returns "html" for a wildcard
 * Accept (the default curl and fetch send) and for a missing Accept header.
 * Listing json first makes it win the wildcard tie-break.
 *
 * @param {string|undefined} acceptHeader - raw Accept header value
 */
function wantsHtml(acceptHeader) {
  if (acceptHeader === undefined || acceptHeader === "") return false;
  const parts = acceptHeader.split(",").map((p) => p.trim().split(";")[0].toLowerCase());
  const jsonIdx = parts.indexOf("application/json");
  const htmlIdx = parts.indexOf("text/html");
  if (jsonIdx === -1 && htmlIdx === -1) {
    // */* or other - JSON wins (curl/fetch default)
    return parts.includes("*/*") ? false : htmlIdx !== -1;
  }
  if (jsonIdx === -1) return htmlIdx !== -1;
  if (htmlIdx === -1) return false;
  return htmlIdx < jsonIdx;
}

module.exports = { wantsHtml };
