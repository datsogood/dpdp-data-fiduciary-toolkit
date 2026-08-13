const { escapeHtml } = require("../forms");
const { wantsHtml } = require("../negotiate");

/**
 * @param {unknown} err
 * @param {{ accepts: (types: string[]) => string|false }} req
 * @returns {import("./types").HttpResult}
 */
function mapError(err, req) {
  const html = wantsHtml(req);

  if (err && (err.name === "ValidationError" || err.name === "CastError")) {
    const fields = err.errors ? Object.keys(err.errors).join(", ") : err.path;
    const message = `Invalid value for: ${fields}`;
    if (html) return { status: 400, html: `<p>${escapeHtml(message)}</p>` };
    return { status: 400, json: { error: message } };
  }

  if (err && typeof err.status === "number" && err.status < 500) {
    if (html) return { status: err.status, html: `<p>${escapeHtml(err.message)}</p>` };
    return { status: err.status, json: { error: err.message } };
  }

  console.error("[dpdp-toolkit] unhandled error:", err);
  const status = err && typeof err.status === "number" ? err.status : 500;
  if (html) {
    return { status, html: "<p>Something went wrong at our end. Please try again later.</p>" };
  }
  return { status, json: { error: "internal error" } };
}

module.exports = { mapError };
