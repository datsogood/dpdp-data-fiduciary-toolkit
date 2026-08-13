const express = require("express");

const { createHttpCore } = require("../core/createHttpCore");
const { routeRegistry, toExpressPath } = require("../core/routeRegistry");
const { checkOrigin, noStoreHeaders, resolveAuth } = require("../core/middleware");
const { mapError } = require("../core/mapError");
const { buildOpenApiDocument } = require("../../openapi/buildSpec");
const { sendExpressResult, expressContext } = require("./expressContext");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * @param {object}   opts
 * @param {object}   opts.db
 * @param {Function} [opts.resolvePrincipal] - (req) => principalId | Promise<principalId>
 * @param {Function} [opts.onWithdrawal]
 * @param {Function} [opts.onGrievanceFiled]
 * @param {string[]} [opts.allowedOrigins]
 */
function createRouter({ db, resolvePrincipal, onWithdrawal, onGrievanceFiled, allowedOrigins = [] } = {}) {
  const core = createHttpCore({ db, onWithdrawal, onGrievanceFiled, allowedOrigins });

  const router = express.Router();

  router.use((req, res, next) => {
    const ctx = expressContext(req);
    const blocked = checkOrigin(ctx, core.allowedOrigins);
    if (blocked) return sendExpressResult(res, blocked);
    next();
  });
  router.use(express.json({ limit: "100kb" }));
  router.use(express.urlencoded({ extended: false, limit: "100kb" }));

  router.get("/openapi.json", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json(buildOpenApiDocument({ basePath: req.baseUrl }));
  });

  for (const entry of routeRegistry) {
    const handler = core.handlers[entry.operationId];
    const stack = [];

    if (entry.auth) {
      stack.push(
        wrap(async (req, res, next) => {
          const auth = await resolveAuth(expressContext(req), resolvePrincipal, req);
          if (typeof auth === "object" && auth.status) return sendExpressResult(res, auth);
          req.principalId = auth;
          next();
        })
      );
    }
    if (entry.noStore) {
      stack.push((req, res, next) => {
        const h = noStoreHeaders();
        res.set("Cache-Control", h["Cache-Control"]);
        res.set("Vary", h.Vary);
        next();
      });
    }

    stack.push(
      wrap(async (req, res) => {
        const ctx = expressContext(req);
        const result = await handler(ctx);
        sendExpressResult(res, result);
      })
    );

    router[entry.method](toExpressPath(entry.path), ...stack);
  }

  router.use((err, req, res, _next) => {
    sendExpressResult(res, mapError(err, expressContext(req).headers.accept));
  });

  return router;
}

module.exports = { createRouter };
