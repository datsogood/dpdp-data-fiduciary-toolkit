const { normalizeBasePath } = require("../core/routeRegistry");

/**
 * Apply an HttpResult to an Express response.
 * @param {import("express").Response} res
 * @param {import("./types").HttpResult} result
 */
function sendExpressResult(res, result) {
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) res.set(k, v);
  }
  if (result.html !== undefined) return res.status(result.status).type("html").send(result.html);
  return res.status(result.status).json(result.json);
}

/**
 * @param {import("express").Request} req
 * @returns {import("./types").HttpContext}
 */
function expressContext(req) {
  /** @type {Record<string, string|undefined>} */
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return {
    method: req.method,
    basePath: normalizeBasePath(req.baseUrl),
    headers,
    query: req.query,
    params: req.params,
    body: req.body || {},
    principalId: req.principalId ?? null,
    host: req.get("host") || "",
    req,
  };
}

module.exports = { sendExpressResult, expressContext };
