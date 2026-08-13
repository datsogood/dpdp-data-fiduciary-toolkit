const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fastifyFactory = require("fastify");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";

const { withDb } = require("./helpers/db");
const { clearHttpModuleCache } = require("./helpers/clearHttpCache");
const { bootFastify, PII } = require("./helpers/httpHarness");
const { registerHttpBehaviorTests } = require("./helpers/httpBehaviorSuite");
const { buildModels } = require("../src/models");
const { createPlugin } = require("../src/http/adapters/fastify");
const { buildOpenApiDocument } = require("../src/openapi/buildSpec");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");

registerHttpBehaviorTests(bootFastify);

test("an internal fault is 500 with a generic body, not 400 with the raw message", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const fastify = fastifyFactory({ logger: false });
    await fastify.register(
      createPlugin({
        db: conn,
        resolvePrincipal: () => principalId,
        onWithdrawal: () => {
          throw new Error("SECRET internal detail");
        },
      }),
      { prefix: "/dpdp" }
    );
    await fastify.ready();
    try {
      const res = await fastify.inject({
        method: "PUT",
        url: "/dpdp/consent/withdraw",
        headers: { "content-type": "application/json", accept: "application/json" },
        payload: JSON.stringify({ consentTypes: ["marketing"] }),
      });
      assert.equal(res.statusCode, 500);
      assert.doesNotMatch(res.payload, /SECRET internal detail/);
    } finally {
      await fastify.close();
    }
  });
});

test("GET /openapi.json on the Fastify plugin returns the live spec", async () => {
  await withDb(async (conn) => {
    const fastify = fastifyFactory({ logger: false });
    await fastify.register(createPlugin({ db: conn, resolvePrincipal: () => null }), { prefix: "/dpdp" });
    await fastify.ready();
    try {
      const res = await fastify.inject({ method: "GET", url: "/dpdp/openapi.json" });
      assert.equal(res.statusCode, 200);
      const live = JSON.parse(res.payload);
      assert.equal(live.openapi, "3.1.0");
      assert.deepEqual(Object.keys(live.paths).sort(), Object.keys(buildOpenApiDocument({ basePath: "/dpdp" }).paths).sort());
    } finally {
      await fastify.close();
    }
  });
});

test("GET /docs serves Swagger UI", async () => {
  await withDb(async (conn) => {
    const fastify = fastifyFactory({ logger: false });
    await fastify.register(createPlugin({ db: conn, resolvePrincipal: () => null }), { prefix: "/dpdp" });
    await fastify.ready();
    try {
      const res = await fastify.inject({ method: "GET", url: "/dpdp/docs" });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"] || "", /text\/html/);
      assert.match(res.payload, /swagger/i);
    } finally {
      await fastify.close();
    }
  });
});

test("Swagger UI JSON has the same path keys as buildOpenApiDocument", async () => {
  await withDb(async (conn) => {
    const fastify = fastifyFactory({ logger: false });
    await fastify.register(createPlugin({ db: conn, resolvePrincipal: () => null }), { prefix: "/dpdp" });
    await fastify.ready();
    try {
      const expected = buildOpenApiDocument({ basePath: "/dpdp" });
      const res = await fastify.inject({ method: "GET", url: "/dpdp/docs/json" });
      assert.equal(res.statusCode, 200);
      const fromSwagger = JSON.parse(res.payload);
      assert.deepEqual(Object.keys(fromSwagger.paths).sort(), Object.keys(expected.paths).sort());
    } finally {
      await fastify.close();
    }
  });
});

test("createPlugin refuses to start with a placeholder DPO contact", async () => {
  await withDb(async (conn) => {
    const saved = process.env.FIDUCIARY_DPO_EMAIL;
    try {
      clearHttpModuleCache();
      process.env.FIDUCIARY_DPO_EMAIL = "dpo@example.com";
      const { createPlugin: freshPlugin } = require("../src/http/adapters/fastify");
      assert.throws(() => freshPlugin({ db: conn, resolvePrincipal: () => null }), /FIDUCIARY_DPO_EMAIL/);
    } finally {
      process.env.FIDUCIARY_DPO_EMAIL = saved;
      clearHttpModuleCache();
    }
  });
});
