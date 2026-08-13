/**
 * @param {import("fastify").FastifyReply} reply
 * @param {import("../core/types").HttpResult} result
 */
function sendFastifyResult(reply, result) {
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
  }
  if (result.html !== undefined) {
    return reply.code(result.status).type("text/html").send(result.html);
  }
  return reply.code(result.status).send(result.json);
}

/**
 * @param {import("fastify").FastifyRequest} request
 * @param {string} basePath
 * @returns {import("../core/types").HttpContext}
 */
function fastifyContext(request, basePath) {
  /** @type {Record<string, string|undefined>} */
  const headers = {};
  for (const [k, v] of Object.entries(request.headers)) {
    if (v === undefined) continue;
    headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : String(v);
  }
  const acc = require("accepts")({ headers: request.headers });
  const req = {
    accepts(types) {
      return acc.types(types);
    },
  };
  return {
    method: request.method,
    basePath,
    headers,
    query: request.query,
    params: request.params,
    body: request.body || {},
    principalId: request.principalId ?? null,
    host: request.headers.host || "",
    req,
  };
}

module.exports = { sendFastifyResult, fastifyContext };
