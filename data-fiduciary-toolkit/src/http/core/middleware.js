const { escapeHtml } = require("../forms");
const { wantsHtml } = require("../negotiate");

function originHost(value) {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/**
 * Same-origin check on state-changing requests. Returns an HttpResult to send,
 * or null when the request may proceed.
 *
 * @param {import("./types").HttpContext} ctx
 * @param {string[]} allowedOrigins
 * @returns {import("./types").HttpResult|null}
 */
function checkOrigin(ctx, allowedOrigins) {
  if (ctx.method === "GET" || ctx.method === "HEAD") return null;
  const fromOrigin = ctx.headers.origin;
  const origin = fromOrigin !== undefined ? fromOrigin : ctx.headers.referer;
  if (origin === undefined) return null;

  const host = originHost(origin);
  if (!host) return { status: 403, json: { error: "bad origin" } };

  const allowed =
    host === ctx.host || allowedOrigins.some((o) => (originHost(o) || o) === host);
  if (!allowed) return { status: 403, json: { error: "cross-origin request refused" } };
  return null;
}

function noStoreHeaders() {
  return { "Cache-Control": "no-store", Vary: "Cookie" };
}

/**
 * @param {import("./types").HttpContext} ctx
 * @returns {import("./types").HttpResult}
 */
function authRequiredResult(ctx) {
  if (wantsHtml(ctx.headers.accept)) {
    const signInUrl = escapeHtml(`${ctx.basePath}/consent/new`);
    return {
      status: 401,
      html: `<p>You need to sign in to reach this page. <a href="${signInUrl}">Return to notice and consent</a>.</p>`,
    };
  }
  return { status: 401, json: { error: "authentication required" } };
}

/**
 * Resolve principalId via host hook. Returns principalId string or an HttpResult (401).
 *
 * @param {import("./types").HttpContext} ctx
 * @param {Function|undefined} resolvePrincipal - (raw) => id | Promise<id>
 * @param {unknown} raw - Express req or Fastify request
 * @returns {Promise<string|import("./types").HttpResult>}
 */
async function resolveAuth(ctx, resolvePrincipal, raw) {
  if (typeof resolvePrincipal !== "function") return authRequiredResult(ctx);
  let id;
  try {
    id = await resolvePrincipal(raw);
  } catch {
    return authRequiredResult(ctx);
  }
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) return authRequiredResult(ctx);
  return id;
}

module.exports = { originHost, checkOrigin, noStoreHeaders, authRequiredResult, resolveAuth };
