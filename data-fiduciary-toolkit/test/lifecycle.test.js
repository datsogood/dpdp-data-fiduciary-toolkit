const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
const { buildModels } = require("../src/models");
const { advanceRightsRequest, advanceGrievance, advanceConsentManagerRequest } = require("../src/services/requestLifecycle");
const { escalateToBoard } = require("../src/services/complaintToTheBoard");

const PID = "a".repeat(64);

test("a rights request can be advanced through its lifecycle", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await models.RightsRequest.create({ principalId: PID, refId: "RQ-1", right: "erasure", status: "received", slaDueAt: new Date() });

    const inProgress = await advanceRightsRequest({ models, refId: "RQ-1", status: "in_progress" });
    assert.equal(inProgress.status, "in_progress");
    const closed = await advanceRightsRequest({ models, refId: "RQ-1", status: "closed", resolution: "PII erased" });
    assert.equal(closed.status, "closed");
    assert.equal(closed.resolution, "PII erased");
    assert.ok(closed.updatedAt > closed.createdAt, "updatedAt must move when the status changes");
  });
});

test("an illegal transition is refused", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await models.RightsRequest.create({ principalId: PID, refId: "RQ-2", right: "access", status: "closed", slaDueAt: new Date() });
    await assert.rejects(
      () => advanceRightsRequest({ models, refId: "RQ-2", status: "in_progress" }),
      (e) => e.status === 409
    );
    // The rejection must not have partially applied - the record stays exactly
    // as it was, not left half-transitioned.
    const row = await models.RightsRequest.findOne({ refId: "RQ-2" });
    assert.equal(row.status, "closed");
  });
});

test("a grievance can reach resolved, which makes the resolved guard reachable", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({ principalId: PID, refId: "GR-1", subject: "s", description: "d", addressedTo: "DPO", status: "open", slaDueAt: past });
    await advanceGrievance({ models, refId: "GR-1", status: "resolved", resolution: "Calls stopped" });
    await assert.rejects(
      () => escalateToBoard({ models, refId: "GR-1", principalId: PID }),
      (e) => /resolved/i.test(e.message)
    );
    // Assert the stored value, not the return value - Grievance had no
    // 'resolution' schema path before this task, so under Mongoose strict
    // mode the assignment would be silently dropped with no error.
    const row = await models.Grievance.findOne({ refId: "GR-1" });
    assert.equal(row.resolution, "Calls stopped");
  });
});

test("re-escalation does not overwrite the original escalation date", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({ principalId: PID, refId: "GR-2", subject: "s", description: "d", addressedTo: "DPO", status: "open", slaDueAt: past });
    const first = await escalateToBoard({ models, refId: "GR-2", principalId: PID });
    await assert.rejects(
      () => escalateToBoard({ models, refId: "GR-2", principalId: PID }),
      (e) => e.status === 409,
      "a second escalation must not silently overwrite escalatedAt"
    );
    const row = await models.Grievance.findOne({ refId: "GR-2" });
    assert.equal(row.escalatedAt.getTime(), first.escalatedAt.getTime());
  });
});

test("a grievance cannot reach escalated through advanceGrievance - escalateToBoard is the only path in", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({ principalId: PID, refId: "GR-3", subject: "s", description: "d", addressedTo: "DPO", status: "open", slaDueAt: past });
    await assert.rejects(
      () => advanceGrievance({ models, refId: "GR-3", status: "escalated" }),
      (e) => e.status === 409
    );
    const row = await models.Grievance.findOne({ refId: "GR-3" });
    assert.equal(row.status, "open", "the illegal transition must not have applied");
    assert.equal(row.escalatedAt, undefined, "escalatedAt must stay unset - only escalateToBoard may set it");
  });
});

test("a consent manager request can be advanced, and its transitions have no resolution concept", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await models.ConsentManagerRequest.create({ principalId: PID, refId: "CM-1", message: "connect me", status: "received" });

    const connected = await advanceConsentManagerRequest({ models, refId: "CM-1", status: "connected" });
    assert.equal(connected.status, "connected");

    await assert.rejects(
      () => advanceConsentManagerRequest({ models, refId: "CM-1", status: "received" }),
      (e) => e.status === 409,
      "connected -> received is not an allowed transition"
    );
  });
});
