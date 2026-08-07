const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
const { buildModels } = require("../src/models");
const { findOrCreatePrincipal } = require("../src/utils/principalId");
const { erasePrincipalPII } = require("../src/services/erasure");

test("erasure clears PII but preserves the consent ledger", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal } = await findOrCreatePrincipal({
      models,
      pii: { name: "Asha", email: "asha@example.com", phone: "9876543210" },
    });
    const id = principal.principalId;

    await models.ConsentRecord.create({
      principalId: id,
      docRef: "CN-TEST-0002",
      events: [{ type: "marketing", status: "granted", basis: "Your consent", lawfulBasisKind: "consent", receiptId: "RC-1", timestamp: new Date() }],
    });

    await erasePrincipalPII({ models, principalId: id });

    const after = await models.Principal.findOne({ principalId: id });
    assert.equal(after.pii.name, undefined);
    assert.equal(after.pii.email, undefined);
    assert.equal(after.emailHash, undefined, "lookup hashes must go too, or the person stays re-identifiable");
    assert.ok(after.erasedAt);

    const ledger = await models.ConsentRecord.findOne({ principalId: id });
    assert.equal(ledger.events.length, 1, "the lawful-basis evidence must survive erasure");
    assert.equal(ledger.events[0].status, "granted");
  });
});

test("erasure is idempotent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal } = await findOrCreatePrincipal({ models, pii: { name: "A", phone: "1" } });
    await erasePrincipalPII({ models, principalId: principal.principalId });
    const second = await erasePrincipalPII({ models, principalId: principal.principalId });
    assert.equal(second.alreadyErased, true);
  });
});
