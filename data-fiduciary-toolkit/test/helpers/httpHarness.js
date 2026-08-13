const express = require("express");
const fastifyFactory = require("fastify");

const { buildModels } = require("../../src/models");
const createRouter = require("../../src/http/router");
const { createPlugin } = require("../../src/http/adapters/fastify");
const persistPIIwithconsent = require("../../src/services/persistPIIwithconsent");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };

async function ledgerEvents(models, principalId) {
  const record = await models.ConsentRecord.findOne({ principalId }).lean();
  return record ? record.events : [];
}

function wrapInjectResponse(res) {
  return {
    status: res.statusCode,
    headers: {
      get: (k) => res.headers[k.toLowerCase()],
    },
    json: () => Promise.resolve(JSON.parse(res.payload || "{}")),
    text: () => Promise.resolve(res.payload),
  };
}

/**
 * Boots Express with the router mounted at basePath, authenticated as one principal.
 */
async function bootExpress(conn, { basePath = "/dpdp", consentTypes = ["marketing"], ...opts } = {}) {
  const models = buildModels(conn);
  const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes });
  const app = express();
  app.use(basePath, createRouter({ db: conn, resolvePrincipal: () => principalId, ...opts }));
  const server = app.listen(0);
  const port = server.address().port;
  const host = `localhost:${port}`;
  const origin = `http://${host}`;
  return {
    models,
    principalId,
    port,
    host,
    origin,
    call: (method, p, body, headers = {}) =>
      fetch(`http://${host}${basePath}${p}`, {
        method,
        headers: { "Content-Type": "application/json", Host: host, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * Boots Fastify with createPlugin at basePath, authenticated as one principal.
 */
async function bootFastify(conn, { basePath = "/dpdp", consentTypes = ["marketing"], ...opts } = {}) {
  const models = buildModels(conn);
  const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes });
  const fastify = fastifyFactory({ logger: false });
  await fastify.register(createPlugin({ db: conn, resolvePrincipal: (request) => principalId, ...opts }), {
    prefix: basePath,
  });
  await fastify.ready();
  const host = "localhost";
  const origin = `http://${host}`;
  return {
    models,
    principalId,
    host,
    origin,
    fastify,
    call: async (method, p, body, headers = {}) => {
      const res = await fastify.inject({
        method,
        url: `${basePath}${p}`,
        headers: { "content-type": "application/json", host, ...headers },
        payload: body === undefined ? undefined : JSON.stringify(body),
      });
      return wrapInjectResponse(res);
    },
    close: () => fastify.close(),
  };
}

module.exports = { PII, ledgerEvents, bootExpress, bootFastify, wrapInjectResponse };
