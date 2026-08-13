const { createHttpCore } = require("../core/createHttpCore");
const { routeRegistry, toFastifyPath, normalizeBasePath } = require("../core/routeRegistry");
const { checkOrigin, noStoreHeaders, resolveAuth } = require("../core/middleware");
const { mapError } = require("../core/mapError");
const { buildOpenApiDocument } = require("../../openapi/buildSpec");
const { sendFastifyResult, fastifyContext } = require("./fastifyContext");

/**
 * @param {object} opts
 * @param {object} opts.db
 * @param {Function} [opts.resolvePrincipal] - (request) => principalId | Promise<principalId>
 * @param {Function} [opts.onWithdrawal]
 * @param {Function} [opts.onGrievanceFiled]
 * @param {string[]} [opts.allowedOrigins]
 * @returns {Function} Fastify plugin factory
 */
function createPlugin({ db, resolvePrincipal, onWithdrawal, onGrievanceFiled, allowedOrigins = [] } = {}) {
  const core = createHttpCore({ db, onWithdrawal, onGrievanceFiled, allowedOrigins });

  return async function dpdpPlugin(fastify, pluginOpts) {
    const basePath = normalizeBasePath(pluginOpts?.prefix ?? "");

    await fastify.register(require("@fastify/formbody"));

    const document = buildOpenApiDocument({ basePath });
    await fastify.register(require("@fastify/swagger"), {
      mode: "static",
      specification: { document },
    });
    await fastify.register(require("@fastify/swagger-ui"), {
      routePrefix: "/docs",
      staticCSP: true,
    });

    fastify.addHook("onRoute", (routeOptions) => {
      if (!routeOptions.config) routeOptions.config = {};
      if (routeOptions.bodyLimit === undefined) routeOptions.bodyLimit = 102400;
    });

    fastify.get("/openapi.json", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return reply.code(200).send(document);
    });

    for (const entry of routeRegistry) {
      const handler = core.handlers[entry.operationId];
      const preHandler = async (request, reply) => {
        const ctx = fastifyContext(request, basePath);
        const blocked = checkOrigin(ctx, core.allowedOrigins);
        if (blocked) {
          sendFastifyResult(reply, blocked);
          return;
        }
        if (entry.auth) {
          const auth = await resolveAuth(ctx, resolvePrincipal, request);
          if (typeof auth === "object" && auth.status) {
            sendFastifyResult(reply, auth);
            return;
          }
          request.principalId = auth;
          ctx.principalId = auth;
        }
        if (entry.noStore) {
          const h = noStoreHeaders();
          reply.header("Cache-Control", h["Cache-Control"]);
          reply.header("Vary", h.Vary);
        }
      };

      fastify.route({
        method: entry.method.toUpperCase(),
        url: toFastifyPath(entry.path),
        preHandler,
        handler: async (request, reply) => {
          if (reply.sent) return;
          const ctx = fastifyContext(request, basePath);
          const result = await handler(ctx);
          return sendFastifyResult(reply, result);
        },
      });
    }

    fastify.setErrorHandler((err, request, reply) => {
      sendFastifyResult(reply, mapError(err, fastifyContext(request, basePath).req));
    });
  };
}

module.exports = { createPlugin };
