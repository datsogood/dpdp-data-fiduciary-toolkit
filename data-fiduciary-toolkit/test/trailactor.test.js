const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
const { buildModels } = require("../src/models");
const { AppError } = require("../src/utils/errors");
const { resolveActor } = require("../src/services/consentTrail");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const withdrawConsent = require("../src/services/withdrawConsent");
const { complaintToTheBoard, escalateToBoard } = require("../src/services/complaintToTheBoard");
const { advanceGrievance } = require("../src/services/requestLifecycle");
const { updatePrincipalContact } = require("../src/utils/principalId");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };
const is400 = (err) => err instanceof AppError && err.status === 400;

// ---------------------------------------------------------------------------
// resolveActor - the check every service runs before doing any work
// ---------------------------------------------------------------------------

test("resolveActor treats null and undefined as unattributed", () => {
  for (const actor of [undefined, null]) {
    assert.deepEqual(resolveActor(actor), { role: "unattributed", channel: "library" });
  }
});

test("resolveActor refuses anything that is not a valid actor", () => {
  const bad = [
    "operator",
    ["operator"],
    42,
    { role: "admin", channel: "api" },
    { role: "operator", channel: "sms" },
    { role: "operator", channel: "api", ref: "asha@corp.in" },
  ];
  for (const actor of bad) {
    assert.throws(() => resolveActor(actor), is400, JSON.stringify(actor));
  }
});

test("resolveActor keeps only role, channel and ref", () => {
  // An extra field is the host's own data about its staff member; nothing
  // outside these three may reach a collection that survives erasure.
  assert.deepEqual(resolveActor({ role: "operator", channel: "api", ref: "staff-42", name: "Asha" }), {
    role: "operator",
    channel: "api",
    ref: "staff-42",
  });
});

// ---------------------------------------------------------------------------
// Each service refuses a bad actor before it changes anything. Before this,
// the act went through and only its trail entry was lost, inside the
// fail-open writer, with nothing but a log line to show for it.
// ---------------------------------------------------------------------------

test("advanceGrievance with an email as actor.ref is refused, and the grievance is untouched", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const filed = await complaintToTheBoard({ models, principalId, subject: "Calls", description: "Calls after 9pm" });
    const entries = await models.TrailEntry.countDocuments();

    await assert.rejects(
      advanceGrievance({
        models,
        refId: filed.refId,
        status: "in_progress",
        actor: { role: "operator", channel: "api", ref: "asha@corp.in" },
      }),
      is400
    );
    assert.equal((await models.Grievance.findOne({ refId: filed.refId }).lean()).status, "open");
    assert.equal(await models.TrailEntry.countDocuments(), entries);
  });
});

test("withdrawConsent with an unknown actor role is refused before the ledger is touched", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const events = (await models.ConsentRecord.findOne({ principalId }).lean()).events.length;
    const entries = await models.TrailEntry.countDocuments();

    await assert.rejects(
      withdrawConsent({ models, principalId, consentTypes: ["marketing"], actor: { role: "admin", channel: "api" } }),
      is400
    );
    assert.equal((await models.ConsentRecord.findOne({ principalId }).lean()).events.length, events);
    assert.equal(await models.TrailEntry.countDocuments(), entries);
  });
});

test("escalateToBoard with an unknown actor channel is refused before the grievance is checked", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const filed = await complaintToTheBoard({ models, principalId, subject: "Calls", description: "Calls after 9pm" });
    const entries = await models.TrailEntry.countDocuments();

    await assert.rejects(
      escalateToBoard({ models, refId: filed.refId, principalId, actor: { role: "principal", channel: "sms" } }),
      is400
    );
    assert.equal((await models.Grievance.findOne({ refId: filed.refId }).lean()).status, "open");
    assert.equal(await models.TrailEntry.countDocuments(), entries);
  });
});

test("persistPIIwithconsent with an actor that is not an object is refused before anything is stored", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);

    await assert.rejects(
      persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"], actor: "operator" }),
      is400
    );
    assert.equal(await models.Principal.countDocuments(), 0);
    assert.equal(await models.ConsentRecord.countDocuments(), 0);
    assert.equal(await models.TrailEntry.countDocuments(), 0);
  });
});

test("updatePrincipalContact with an email as actor.ref is refused, and the contact is unchanged", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const before = await models.Principal.findOne({ principalId }).lean();
    const entries = await models.TrailEntry.countDocuments();

    await assert.rejects(
      updatePrincipalContact({
        models,
        principalId,
        pii: { email: "asha.new@example.com" },
        actor: { role: "operator", channel: "api", ref: "asha@corp.in" },
      }),
      is400
    );
    assert.equal((await models.Principal.findOne({ principalId }).lean()).emailHash, before.emailHash);
    assert.equal(await models.TrailEntry.countDocuments(), entries);
  });
});
