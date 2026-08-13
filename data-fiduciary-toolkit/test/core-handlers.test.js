const test = require("node:test");
const assert = require("node:assert/strict");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";

const { withDb } = require("./helpers/db");
const { createHttpCore } = require("../src/http/core/createHttpCore");
const { PII } = require("./helpers/httpHarness");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");

function mockReq(acceptHeader = "application/json") {
  const acc = require("accepts")({ headers: { accept: acceptHeader } });
  return { accepts: (types) => acc.types(types) };
}

function ctx(overrides = {}) {
  const accept = overrides.headers?.accept ?? "application/json";
  return {
    method: "GET",
    basePath: "/dpdp",
    headers: { accept },
    query: {},
    params: {},
    body: {},
    principalId: null,
    host: "localhost",
    req: mockReq(accept),
    ...overrides,
  };
}

test("listRights returns the rights catalog as JSON", async () => {
  await withDb(async (conn) => {
    const core = createHttpCore({ db: conn });
    const result = await core.handlers.listRights(ctx());
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.json));
    assert.ok(result.json.some((r) => r.key === "access"));
  });
});

test("getConsentForm returns HTML notice page", async () => {
  await withDb(async (conn) => {
    const core = createHttpCore({ db: conn });
    const result = await core.handlers.getConsentForm(ctx({ headers: { accept: "text/html" } }));
    assert.equal(result.status, 200);
    assert.match(result.html, /consentTypes/);
  });
});

test("exerciseRight rejects a missing principalId at the service layer", async () => {
  await withDb(async (conn) => {
    const core = createHttpCore({ db: conn });
    await assert.rejects(
      () => core.handlers.exerciseRight(ctx({ method: "POST", body: { right: "access" }, principalId: null })),
      /principalId must be a 64-character hex string/i
    );
  });
});

test("withdrawConsent handler returns withdrawn types for a granted consent", async () => {
  await withDb(async (conn) => {
    const core = createHttpCore({ db: conn });
    const { principalId } = await persistPIIwithconsent({
      models: core.models,
      pii: PII,
      consentTypes: ["marketing"],
    });
    const result = await core.handlers.withdrawConsentPost(
      ctx({ method: "POST", principalId, body: { consentTypes: ["marketing"] } })
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.withdrawn, ["marketing"]);
  });
});
