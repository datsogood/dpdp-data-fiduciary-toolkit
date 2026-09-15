const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
const { buildModels } = require("../src/models");
const { advanceRightsRequest, advanceGrievance, advanceConsentManagerRequest } = require("../src/services/requestLifecycle");
const { complaintToTheBoard, escalateToBoard, getGrievance } = require("../src/services/complaintToTheBoard");
const { exerciseRight, getRightsRequest } = require("../src/services/dataPrincipalRights");

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

// End to end, not a projection check in isolation: this fails if either the
// getGrievance projection drops resolution again, or advanceGrievance stops
// persisting it - the two things a projection-only test cannot tell apart.
test("a resolved grievance's resolution is visible on the principal-facing read path", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const filed = await complaintToTheBoard({
      models,
      principalId: PID,
      subject: "Repeated calls",
      description: "Collections calling after 9pm",
    });
    await advanceGrievance({ models, refId: filed.refId, status: "resolved", resolution: "Calls stopped and agent retrained" });

    const seen = await getGrievance({ models, principalId: PID, refId: filed.refId });
    assert.equal(seen.status, "resolved");
    assert.equal(seen.resolution, "Calls stopped and agent retrained");
  });
});

// Same gap, same fix, same reasoning - RightsRequest gained resolution in
// this task too, and getRightsRequest predates that field.
test("a closed rights request's resolution is visible on the principal-facing read path", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const filed = await exerciseRight({ models, principalId: PID, right: "erasure" });
    await advanceRightsRequest({ models, refId: filed.refId, status: "in_progress" });
    await advanceRightsRequest({ models, refId: filed.refId, status: "closed", resolution: "PII erased" });

    const seen = await getRightsRequest({ models, principalId: PID, refId: filed.refId });
    assert.equal(seen.status, "closed");
    assert.equal(seen.resolution, "PII erased");
  });
});

// ---------------------------------------------------------------------------
// The transition audit trail.
//
// row.status = status overwrites the prior value in place and updatedAt holds
// only the last change, so without these rows a request that moved
// received -> in_progress -> closed is indistinguishable afterwards from one
// that went straight to closed.
// ---------------------------------------------------------------------------

test("a two-step advance records BOTH hops with the from-status each one destroyed", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await models.RightsRequest.create({
      principalId: PID, refId: "RQ-TRAIL", right: "erasure", status: "received", slaDueAt: new Date(),
    });

    await advanceRightsRequest({ models, refId: "RQ-TRAIL", status: "in_progress" });
    await advanceRightsRequest({ models, refId: "RQ-TRAIL", status: "closed", resolution: "PII erased" });

    const row = await models.RightsRequest.findOne({ refId: "RQ-TRAIL" });
    assert.equal(row.status, "closed");
    assert.equal(row.toObject().fromStatus, undefined,
      "premise of this test - nothing on the request itself remembers where it came from");

    const rows = await models.TrailEntry.find({ principalId: PID, kind: "request_status_changed" }).lean();
    assert.equal(rows.length, 2, "one row per hop - the middle transition is what updatedAt cannot reconstruct");

    // Matched by destination rather than by order, so the assertion does not
    // depend on two writes landing in different milliseconds.
    const toInProgress = rows.find((r) => r.toStatus === "in_progress");
    const toClosed = rows.find((r) => r.toStatus === "closed");
    assert.ok(toInProgress && toClosed, "both hops must be present");
    assert.equal(toInProgress.fromStatus, "received");
    assert.equal(toClosed.fromStatus, "in_progress",
      "captured before row.status = status overwrote it - that overwrite is the entire reason this kind exists");

    for (const r of [toInProgress, toClosed]) {
      assert.equal(r.outcome, "recorded");
      assert.equal(r.principalId, PID, "the row files under the subject, taken from the request itself");
      assert.equal(r.refId, "RQ-TRAIL", "the row cites the reference the person holds");
      assert.equal(r.reasonCode, undefined, "a transition that happened has no reason code");
      assert.equal(r.actor.role, "unattributed");
      assert.equal(r.actor.channel, "library");
    }
  });
});

test("every advance* wrapper threads models through - grievance and consent-manager hops are recorded too", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({
      principalId: PID, refId: "GR-TRAIL", subject: "s", description: "d", addressedTo: "DPO", status: "open", slaDueAt: past,
    });
    await models.ConsentManagerRequest.create({
      principalId: PID, refId: "CM-TRAIL", message: "connect me", status: "received",
    });

    await advanceGrievance({ models, refId: "GR-TRAIL", status: "in_progress" });
    await advanceConsentManagerRequest({ models, refId: "CM-TRAIL", status: "connected" });

    const rows = await models.TrailEntry.find({ principalId: PID, kind: "request_status_changed" }).lean();
    assert.equal(rows.length, 2, "a wrapper that forgot to pass models would silently record nothing");
    const byRef = Object.fromEntries(rows.map((r) => [r.refId, r]));
    assert.equal(byRef["GR-TRAIL"].fromStatus, "open");
    assert.equal(byRef["GR-TRAIL"].toStatus, "in_progress");
    assert.equal(byRef["CM-TRAIL"].fromStatus, "received");
    assert.equal(byRef["CM-TRAIL"].toStatus, "connected");
  });
});

test("an illegal transition records nothing - a stored transition is only ever one that happened", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await models.RightsRequest.create({
      principalId: PID, refId: "RQ-NOPE", right: "access", status: "closed", slaDueAt: new Date(),
    });

    await assert.rejects(
      () => advanceRightsRequest({ models, refId: "RQ-NOPE", status: "in_progress" }),
      (e) => e.status === 409
    );

    assert.equal(await models.TrailEntry.countDocuments({ principalId: PID }), 0,
      "the transition did not happen, so nothing may record that it did");
  });
});

// ---------------------------------------------------------------------------
// Refused escalations. Nothing is written when one is refused - the grievance
// is not saved and the 409 is the only output - so a fiduciary asked why a
// person never reached the Board would otherwise have nothing to answer with.
// ---------------------------------------------------------------------------

test("an escalation refused because the grievance is resolved is recorded", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({
      principalId: PID, refId: "GR-RES", subject: "s", description: "d", addressedTo: "DPO",
      status: "resolved", slaDueAt: past,
    });

    await assert.rejects(
      () => escalateToBoard({ models, refId: "GR-RES", principalId: PID }),
      (e) => e.status === 409
    );

    const rows = await models.TrailEntry.find({ principalId: PID, kind: "escalation_refused" }).lean();
    assert.equal(rows.length, 1, "a refused escalation writes nothing anywhere else, so this row is the only record");
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].reasonCode, "already_resolved");
    assert.equal(rows[0].refId, "GR-RES");
    assert.equal(rows[0].actor.role, "unattributed");
  });
});

test("a second escalation is refused as already_escalated, and the first one stores nothing", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({
      principalId: PID, refId: "GR-TWICE", subject: "s", description: "d", addressedTo: "DPO",
      status: "open", slaDueAt: past,
    });

    await escalateToBoard({ models, refId: "GR-TWICE", principalId: PID });
    assert.equal(await models.TrailEntry.countDocuments({ principalId: PID }), 0,
      "an escalation that took effect stamps escalatedAt, so it is derived at read time and stored nowhere");

    await assert.rejects(
      () => escalateToBoard({ models, refId: "GR-TWICE", principalId: PID }),
      (e) => e.status === 409
    );

    const rows = await models.TrailEntry.find({ principalId: PID, kind: "escalation_refused" }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reasonCode, "already_escalated");
    assert.equal(rows[0].outcome, "refused");
  });
});

test("an escalation refused because the SLA has not lapsed is recorded, with a supplied actor carried through", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const future = new Date(Date.now() + 86400000);
    await models.Grievance.create({
      principalId: PID, refId: "GR-EARLY", subject: "s", description: "d", addressedTo: "DPO",
      status: "open", slaDueAt: future,
    });

    await assert.rejects(
      () => escalateToBoard({
        models, refId: "GR-EARLY", principalId: PID,
        actor: { role: "principal", channel: "html" },
      }),
      (e) => e.status === 409
    );

    const rows = await models.TrailEntry.find({ principalId: PID, kind: "escalation_refused" }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reasonCode, "sla_not_lapsed");
    assert.equal(rows[0].actor.role, "principal");
    assert.equal(rows[0].actor.channel, "html");
    assert.doesNotMatch(JSON.stringify(rows[0]), /lapsed yet|not yet lapsed|Grievance Officer/i,
      "the row carries a reason code and a reference, never the sentence the person was shown");
  });
});
