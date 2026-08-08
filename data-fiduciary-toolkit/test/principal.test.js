const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-32chars";
const { buildModels } = require("../src/models");
const {
  newPrincipalId, lookupHash, findOrCreatePrincipal, findPrincipalByContact, findPrincipalById, updatePrincipalContact,
} = require("../src/utils/principalId");
const { erasePrincipalPII } = require("../src/services/erasure");

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

test("an email correction runs its clash check under PRODUCTION query semantics", async () => {
  // withDb builds its connection through connect(), so sanitizeFilter is on
  // here exactly as it is in production. It rewrites an operator filter -
  // { principalId: { $ne: principalId } } - into { $eq: { $ne: ... } }, and
  // casting that object onto a String path throws CastError. Under that
  // setting the clash check threw on every real correction, the router
  // reported it as "400 Invalid value for: principalId" naming a field the
  // caller never supplied, and the documented 409 never ran at all.
  //
  // The two assertions below therefore have to hold TOGETHER: the correction
  // succeeds, and a genuine clash is still refused. An implementation that
  // simply dropped the check would pass the first and fail the second.
  await withDb(async (conn) => {
    assert.equal(conn.get("sanitizeFilter"), true,
      "the harness must run under the same query semantics as connect() gives production");

    const models = buildModels(conn);
    const a = await findOrCreatePrincipal({ models, pii: { name: "Asha", email: "asha@example.com" } });
    const b = await findOrCreatePrincipal({ models, pii: { name: "Riya", email: "riya@example.com" } });

    const moved = await updatePrincipalContact({
      models, principalId: a.principal.principalId, pii: { email: "asha.new@example.com" },
    });
    assert.equal(moved.pii.email, "asha.new@example.com", "a correction must not throw a CastError");
    assert.equal(moved.principalId, a.principal.principalId);

    await assert.rejects(
      () => updatePrincipalContact({
        models, principalId: a.principal.principalId, pii: { email: "riya@example.com" },
      }),
      (e) => e.status === 409,
      "the clash check must actually EXECUTE, not be dropped along with the operator"
    );
    assert.equal(
      (await models.Principal.findOne({ principalId: b.principal.principalId })).pii.email,
      "riya@example.com",
      "the refused correction must leave the other principal untouched"
    );
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

test("resubmitting your own unchanged phone number does not 409 - a shared handset must not lock out corrections", async () => {
  // phoneHash is deliberately non-unique, so a phone clash between two
  // legitimate household members is not an error. Confirms the fix for the
  // lockout the reviewer reproduced: correcting an unrelated field (name)
  // while re-submitting the same phone must succeed, not 409.
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const mother = await findOrCreatePrincipal({ models, pii: { name: "Asha", email: "asha@example.com", phone: "5550001" } });
    const daughter = await findOrCreatePrincipal({ models, pii: { name: "Priya", email: "priya@example.com", phone: "5550001" } });

    const updated = await updatePrincipalContact({
      models,
      principalId: daughter.principal.principalId,
      pii: { name: "Priya Updated", phone: "5550001" },
    });
    assert.equal(updated.pii.name, "Priya Updated");
    assert.equal(updated.principalId, daughter.principal.principalId, "identity must not change");
    assert.notEqual(updated.principalId, mother.principal.principalId);
  });
});

test("two concurrent corrections claiming the same new email - exactly one wins", async () => {
  // findOne-then-write is a check-then-act race: both calls can see "no clash"
  // before either has saved. The unique index on emailHash is the backstop -
  // this asserts the loser gets a clean 409, not a raw duplicate-key error,
  // and that the database never ends up with two principals on one emailHash.
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const a = await findOrCreatePrincipal({ models, pii: { name: "A", phone: "111" } });
    const b = await findOrCreatePrincipal({ models, pii: { name: "B", phone: "222" } });

    const results = await Promise.allSettled([
      updatePrincipalContact({ models, principalId: a.principal.principalId, pii: { email: "shared@example.com" } }),
      updatePrincipalContact({ models, principalId: b.principal.principalId, pii: { email: "shared@example.com" } }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one of the two racing corrections must win");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.status, 409, "the loser must read as a clean conflict, not a raw Mongo error");

    assert.equal(
      await models.Principal.countDocuments({ emailHash: lookupHash("shared@example.com") }),
      1,
      "the database must never end up with two principals on one emailHash"
    );
  });
});

test("an erased principal's record cannot be written back to - erasure is terminal", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal } = await findOrCreatePrincipal({
      models,
      pii: { name: "Asha", email: "asha@example.com", phone: "9876543210" },
    });
    const id = principal.principalId;
    await erasePrincipalPII({ models, principalId: id });

    await assert.rejects(
      () => updatePrincipalContact({ models, principalId: id, pii: { name: "Asha Again" } }),
      (e) => e.status === 409,
      "a session issued before the erasure must not be able to write PII back onto the record"
    );

    const after = await models.Principal.findOne({ principalId: id });
    assert.deepEqual(after.toObject().pii ?? {}, {}, "the rejected update must not have been applied");
  });
});

test("findPrincipalById returns the principal for a known id and null for an unknown one", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principal } = await findOrCreatePrincipal({ models, pii: { name: "Asha", phone: "1" } });

    const found = await findPrincipalById({ models, principalId: principal.principalId });
    assert.equal(found.principalId, principal.principalId);

    const unknown = await findPrincipalById({ models, principalId: newPrincipalId() });
    assert.equal(unknown, null);
  });
});
