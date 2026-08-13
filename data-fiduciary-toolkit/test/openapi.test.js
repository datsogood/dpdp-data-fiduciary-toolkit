const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";

const { withDb } = require("./helpers/db");
const { buildOpenApiDocument } = require("../src/openapi/buildSpec");
const { routeRegistry } = require("../src/http/core/routeRegistry");
const createRouter = require("../src/http/router");
const { getValidConsentTypes } = require("../src/config/catalog");

const COMMITTED = path.join(__dirname, "..", "openapi", "openapi.json");

test("buildOpenApiDocument is OpenAPI 3.1 with every registry operation", () => {
  const doc = buildOpenApiDocument({ serverUrl: "http://localhost:4000" });
  assert.equal(doc.openapi, "3.1.0");
  assert.ok(doc.info.title);
  assert.ok(doc.components.schemas.ConsentType.enum.length > 0);
  assert.deepEqual(doc.components.schemas.ConsentType.enum, getValidConsentTypes());

  for (const entry of routeRegistry) {
    assert.ok(doc.paths[entry.path], `missing path ${entry.path}`);
    assert.ok(doc.paths[entry.path][entry.method], `missing ${entry.method} ${entry.path}`);
    assert.equal(doc.paths[entry.path][entry.method].operationId, entry.operationId);
  }
});

test("GET /openapi.json on the Express router returns the live spec", async () => {
  await withDb(async (conn) => {
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/openapi.json`);
      assert.equal(res.status, 200);
      const live = await res.json();
      assert.equal(live.openapi, "3.1.0");
      assert.ok(live.paths["/consent"]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("committed openapi/openapi.json matches buildOpenApiDocument (run npm run openapi:generate to refresh)", () => {
  const expected = buildOpenApiDocument({ serverUrl: "http://localhost:4000" });
  const committed = JSON.parse(fs.readFileSync(COMMITTED, "utf8"));
  assert.deepEqual(committed, expected);
});
