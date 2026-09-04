const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
const { buildModels } = require("../src/models");

const PID = "a".repeat(64);

// ---------------------------------------------------------------------------
// The TrailEntry schema (spec section 5)
// ---------------------------------------------------------------------------

test("a trail entry needs only kind, outcome and actor, and stamps `at` itself", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const entry = await models.TrailEntry.create({
      principalId: PID,
      kind: "age_gate_refused",
      outcome: "refused",
      reasonCode: "parental_consent_required",
      actor: { role: "unattributed", channel: "library" },
    });

    assert.ok(entry.at instanceof Date, "`at` defaults to now, so no writer can forget to timestamp a row");
    assert.equal(entry.actor.role, "unattributed");
    assert.equal(entry.actor.channel, "library");
    assert.equal(entry.actor.ref, undefined, "ref is set only for an operator");
  });
});

test("a fully-populated trail entry round-trips every field the spec defines", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const at = new Date("2026-09-04T10:00:00.000Z");
    await models.TrailEntry.create({
      principalId: PID,
      at,
      kind: "request_status_changed",
      outcome: "recorded",
      actor: { role: "operator", ref: "emp-10432", channel: "api" },
      refId: "RQ-ABC123",
      receiptId: "RC-DEF456",
      consentTypes: ["marketing"],
      fromStatus: "received",
      toStatus: "in_progress",
      count: 1,
      caseRef: "INC-0042199",
    });

    const raw = await models.TrailEntry.findOne({ principalId: PID }).lean();
    assert.deepEqual(raw.at, at, "an explicit `at` must be stored verbatim - the default must not overwrite it");
    assert.equal(raw.kind, "request_status_changed");
    assert.equal(raw.outcome, "recorded");
    assert.deepEqual(raw.actor, { role: "operator", ref: "emp-10432", channel: "api" });
    assert.equal(raw.refId, "RQ-ABC123");
    assert.equal(raw.receiptId, "RC-DEF456");
    assert.deepEqual(raw.consentTypes, ["marketing"]);
    assert.equal(raw.fromStatus, "received", "the prior status is the fact requestLifecycle destroys in place");
    assert.equal(raw.toStatus, "in_progress");
    assert.equal(raw.count, 1);
    assert.equal(raw.caseRef, "INC-0042199", "the ticket reference says WHY an access happened, not only by whom");
  });
});

test("the schema refuses a kind, an outcome, an actor role or a missing actor", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const base = { principalId: PID, outcome: "refused", actor: { role: "system", channel: "library" } };

    await assert.rejects(
      () => models.TrailEntry.create({ ...base, kind: "consent_maybe" }),
      (err) => err.name === "ValidationError" && /kind/.test(err.message),
      "the vocabulary is closed - eleven kinds, each because something is otherwise destroyed"
    );
    await assert.rejects(
      () => models.TrailEntry.create({ ...base, kind: "consent_refused", outcome: "sort_of" }),
      (err) => err.name === "ValidationError" && /outcome/.test(err.message),
      "outcome is what stops a refusal from ever reading as a state change"
    );
    await assert.rejects(
      () => models.TrailEntry.create({ principalId: PID, kind: "consent_refused", outcome: "refused" }),
      (err) => err.name === "ValidationError" && /actor/.test(err.message),
      "every row names who acted, even when the honest answer is `unattributed`"
    );
    await assert.rejects(
      () => models.TrailEntry.create({ ...base, kind: "consent_refused", actor: { role: "root", channel: "api" } }),
      (err) => err.name === "ValidationError" && /actor\.role/.test(err.message),
      "role is a closed set - a host cannot invent one"
    );
  });
});

test("consentTypes is a list, so one row can name every purpose a single call refused", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    // Pinned deliberately: a scalar String path rejects an array with
    // "Cast to string failed ... (type Array)", and section 6 collapses a
    // multi-purpose refusal into ONE row rather than one row per purpose.
    await models.TrailEntry.create({
      principalId: PID,
      kind: "consent_refused",
      outcome: "refused",
      reasonCode: "prohibited_for_child",
      actor: { role: "principal", channel: "html" },
      consentTypes: ["marketing", "analytics"],
      count: 2,
    });

    const raw = await models.TrailEntry.findOne({ principalId: PID }).lean();
    assert.deepEqual(raw.consentTypes, ["marketing", "analytics"]);
    assert.equal(raw.count, 2, "count is what makes a collapsed row honest about how many purposes it covers");
  });
});

test("a row with no subject stores principalId ABSENT, never null", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await models.TrailEntry.create({
      kind: "operator_lookup",
      outcome: "recorded",
      reasonCode: "no_match",
      actor: { role: "operator", ref: "emp-10432", channel: "api" },
      caseRef: "INC-0042199",
    });

    const raw = await models.TrailEntry.findOne({ kind: "operator_lookup" }).lean();
    assert.equal(
      Object.hasOwn(raw, "principalId"),
      false,
      "a lookup that matched nobody has no subject at all - a stored null would be a subject-shaped hole later code could read as one"
    );
    assert.equal(raw.caseRef, "INC-0042199");
  });
});

test("buildModels exposes TrailEntry on the given connection and leaves the global registry clean", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    assert.ok(models.TrailEntry, "a service reaches this model only through the registry - it never requires the file");
    assert.equal(models.TrailEntry.db, conn, "the model must be bound to the caller's connection, not a global one");
    assert.ok(!mongoose.models.TrailEntry, "global mongoose registry must stay clean");
  });
});
