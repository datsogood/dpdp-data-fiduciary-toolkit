const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-32chars";
const { buildModels } = require("../src/models");
const { findOrCreatePrincipal } = require("../src/utils/principalId");
const { erasePrincipalPII } = require("../src/services/erasure");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const { getConsentState } = require("../src/services/consentState");

function minorDob() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 14);
  return d.toISOString().slice(0, 10);
}

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
    assert.deepEqual(after.toObject().pii ?? {}, {}, "every pii field must be cleared");
    assert.equal(after.emailHash, undefined, "lookup hashes must go too, or the person stays re-identifiable");
    assert.equal(after.phoneHash, undefined, "the phone hash re-identifies just as well as the email hash");
    assert.ok(after.erasedAt);

    const ledger = await models.ConsentRecord.findOne({ principalId: id });
    assert.equal(ledger.events.length, 1, "the lawful-basis evidence must survive erasure");
    assert.equal(ledger.events[0].status, "granted");
  });
});

test("erasure clears the GUARDIAN's personal data too, not just the child's", async () => {
  // The asymmetry this guards: the child's own email is stored as a keyed
  // HMAC and destroyed, while the parent's was stored in PLAINTEXT under
  // Principal.parentalConsent and survived - on a document stamped erasedAt,
  // which getConsentState reports as `pii: null`, so the toolkit's own
  // Section 11 read concealed surviving personal data.
  //
  // Asserted against the RAW document, not the service's return value: the
  // question is what is left on disk, and a read-side filter would hide
  // exactly the defect this exists to catch.
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const verifiedAt = new Date("2026-01-15T00:00:00.000Z");
    const { principalId } = await persistPIIwithconsent({
      models,
      pii: { name: "Child", email: "child@example.com", phone: "9876543210", dob: minorDob() },
      consentTypes: ["identity_verification"],
      parentalConsent: { name: "Asha Rao", email: "asha.rao@example.com", relationship: "mother", verifiedAt },
    });

    const before = await models.Principal.findOne({ principalId }).lean();
    assert.equal(before.parentalConsent.email, "asha.rao@example.com",
      "setup check - the guardian's plaintext email must actually be on file before erasure");

    await erasePrincipalPII({ models, principalId });

    const raw = await models.Principal.findOne({ principalId }).lean();
    const guardian = raw.parentalConsent || {};
    assert.equal(guardian.name, undefined, "the guardian's name must not survive an erasure");
    assert.equal(guardian.email, undefined,
      "the guardian's email is stored in plaintext - it must not outlive the child's own hashed one");
    assert.equal(guardian.relationship, undefined, "the stated relationship describes the guardian too");

    // Nothing anywhere in the raw document may still spell either address or
    // the guardian's name - a field added to this subdocument later would be
    // caught here even if the three assertions above were never extended.
    const onDisk = JSON.stringify(raw);
    assert.doesNotMatch(onDisk, /asha\.rao@example\.com/i, "no plaintext guardian email anywhere on the record");
    assert.doesNotMatch(onDisk, /Asha Rao/i, "no plaintext guardian name anywhere on the record");
    assert.doesNotMatch(onDisk, /child@example\.com/i);

    // Retained deliberately - neither names anybody, and together they are
    // what keeps the surviving ledger legible as Section 9 evidence.
    assert.equal(raw.isMinor, true, "isMinor is a bare boolean on a pseudonymous record - retained by decision");
    assert.equal(new Date(raw.parentalConsent.verifiedAt).toISOString(), verifiedAt.toISOString(),
      "verifiedAt is a fact about the fiduciary's process, not personal data - retained by decision");

    // And the Section 11 read is now telling the truth when it says pii: null.
    const view = await getConsentState({ models, principalId });
    assert.equal(view.pii, null);
    assert.ok(view.erasedAt);
    assert.ok(view.ledger.length >= 1, "the lawful-basis evidence must still survive");
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
