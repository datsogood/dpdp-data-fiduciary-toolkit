const { buildModels } = require("../../models");
const { assertConfigured } = require("../../config/catalog");
const { routeRegistry } = require("./routeRegistry");
const { createHandlers } = require("./handlers");

/**
 * @param {object} opts
 * @param {object} opts.db
 * @param {Function} [opts.onWithdrawal]
 * @param {Function} [opts.onGrievanceFiled]
 * @param {string[]} [opts.allowedOrigins]
 */
function createHttpCore({ db, onWithdrawal, onGrievanceFiled, allowedOrigins = [] } = {}) {
  if (!db || typeof db.model !== "function") {
    throw new Error("db is required - pass the connection returned by connect()");
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((o) => typeof o !== "string")) {
    throw new Error("allowedOrigins must be an array of origin strings, e.g. [\"https://app.example\"]");
  }
  assertConfigured();
  const models = buildModels(db);
  const handlers = createHandlers({ models, onWithdrawal, onGrievanceFiled });
  for (const entry of routeRegistry) {
    if (typeof handlers[entry.operationId] !== "function") {
      throw new Error(`Missing handler for operationId: ${entry.operationId}`);
    }
  }
  return { registry: routeRegistry, handlers, models, allowedOrigins };
}

module.exports = { createHttpCore };
