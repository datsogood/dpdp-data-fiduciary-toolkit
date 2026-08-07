const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production";
const { buildModels } = require("../src/models");
const {
  newPrincipalId, lookupHash, findOrCreatePrincipal, findPrincipalByContact, updatePrincipalContact,
} = require("../src/utils/principalId");

test("newPrincipalId is random, 64 hex chars, and never derived from input", () => {
  const a = newPrincipalId();
  const b = newPrincipalId();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, b);
});

test("lookupHash is keyed - it is not a bare sha256 of the email", () => {
  const crypto = require("node:crypto");
  const email = "asha@example.com";
  const bare = crypto.createHash("sha256").update(email).digest("hex");
  assert.notEqual(lookupHash(email), bare, "an unkeyed hash would be guessable from the email alone");
  assert.equal(lookupHash(" Asha@Example.COM "), lookupHash(email), "must normalise case and whitespace");
});

test("lookupHash refuses to run without a configured secret", () => {
  const saved = process.env.PRINCIPAL_ID_SECRET;
  delete process.env.PRINCIPAL_ID_SECRET;
  try {
    assert.throws(() => lookupHash("a@b.com"), /PRINCIPAL_ID_SECRET/);
  } finally {
    process.env.PRINCIPAL_ID_SECRET = saved;
  }
});

test("a principal can be registered by phone alone - no email required", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal, created } = await findOrCreatePrincipal({
      models,
      pii: { name: "Beneficiary", phone: "9876543210" },
    });
    assert.equal(created, true);
    assert.match(principal.principalId, /^[a-f0-9]{64}$/);
    assert.equal(principal.pii.email, undefined);
  });
});

test("two people sharing a phone can both register", async () => {
  // The stated audience is beneficiaries who share a household handset, so
  // "same phone" must not mean "same data principal".
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const mother = await findOrCreatePrincipal({ models, pii: { name: "Asha", email: "asha@example.com", phone: "9876543210" } });
    const daughter = await findOrCreatePrincipal({ models, pii: { name: "Priya", email: "priya@example.com", phone: "9876543210" } });

    assert.equal(daughter.created, true, "a second person on a shared phone must be able to register");
    assert.notEqual(daughter.principal.principalId, mother.principal.principalId);
    assert.equal(await models.Principal.countDocuments(), 2);
  });
});

test("correcting an email keeps the same principalId, via the authenticated path", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal } = await findOrCreatePrincipal({ models, pii: { name: "Asha", email: "old@example.com", phone: "9876543210" } });
    const id = principal.principalId;

    // Identity comes from the session, not from matching the payload against
    // stored contact hashes.
    const updated = await updatePrincipalContact({
      models, principalId: id, pii: { email: "new@example.com" },
    });
    assert.equal(updated.principalId, id, "identity must survive an email correction");
    assert.equal(updated.pii.email, "new@example.com");
    assert.equal(updated.pii.name, "Asha", "unrelated fields must be preserved");
    assert.equal(await models.Principal.countDocuments(), 1, "must not create an orphan second record");

    // The old email must no longer resolve to anyone.
    assert.equal(await findPrincipalByContact({ models, email: "old@example.com" }), null);
  });
});

test("a contact correction cannot steal another principal's email", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const a = await findOrCreatePrincipal({ models, pii: { name: "A", email: "a@example.com", phone: "1" } });
    await findOrCreatePrincipal({ models, pii: { name: "B", email: "b@example.com", phone: "2" } });

    await assert.rejects(
      () => updatePrincipalContact({ models, principalId: a.principal.principalId, pii: { email: "b@example.com" } }),
      (e) => e.status === 409,
      "must refuse rather than silently merge two people's records"
    );
  });
});
