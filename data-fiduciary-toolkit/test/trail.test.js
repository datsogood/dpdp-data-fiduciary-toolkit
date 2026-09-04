const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
const { buildModels } = require("../src/models");
const { recordTrail, recordTrailStrict, COVERAGE_FROM } = require("../src/services/consentTrail");

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

// ---------------------------------------------------------------------------
// The trail writer (spec sections 5, 6 and 8.2)
// ---------------------------------------------------------------------------

test("recordTrail writes one row and defaults the actor to unattributed", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await recordTrail(models, {
      principalId: PID,
      kind: "consent_not_applied",
      outcome: "no_change",
      reasonCode: "regrant_not_requested",
      receiptId: "RC-ABC123",
      count: 1,
    });

    const rows = await models.TrailEntry.find({ principalId: PID }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "consent_not_applied");
    assert.equal(rows[0].outcome, "no_change");
    assert.equal(rows[0].reasonCode, "regrant_not_requested");
    assert.equal(rows[0].receiptId, "RC-ABC123");
    assert.equal(rows[0].count, 1);
    assert.ok(rows[0].at instanceof Date);
    assert.deepEqual(
      rows[0].actor,
      { role: "unattributed", channel: "library" },
      "a caller that names no actor gets `unattributed` - the library does not know who acted, and `system` would be a claim it cannot back"
    );
  });
});

test("COVERAGE_FROM is a plain date string, so an empty trail can say when recording began", () => {
  assert.match(COVERAGE_FROM, /^\d{4}-\d{2}-\d{2}$/);
});

test("recordTrail keeps a catalog-valid consent type and drops everything else", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await recordTrail(models, {
      principalId: PID,
      kind: "withdrawal_not_applied",
      outcome: "refused",
      reasonCode: "unknown_consent_type",
      // withdrawConsent.js:45-48 pushes caller-supplied text verbatim and
      // assertStringArray applies no content check, so an email typed into
      // consentTypes reaches this writer.
      consentTypes: ["marketing", "asha@example.com"],
      count: 2,
    });

    const rows = await models.TrailEntry.find({}).lean();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].consentTypes, ["marketing"], "a catalog-valid purpose survives");
    assert.doesNotMatch(
      JSON.stringify(rows),
      /asha@example\.com/,
      "the trail survives erasure, so caller-supplied text must never reach any field of it"
    );
    assert.equal(rows[0].count, 2, "count still reports what the call actually covered");
  });
});

test("recordTrail omits consentTypes entirely when nothing survives the catalog filter", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await recordTrail(models, {
      principalId: PID,
      kind: "withdrawal_not_applied",
      outcome: "refused",
      reasonCode: "unknown_consent_type",
      consentTypes: ["asha@example.com"],
      count: 1,
    });

    const raw = await models.TrailEntry.findOne({ principalId: PID }).lean();
    assert.equal(
      Object.hasOwn(raw, "consentTypes"),
      false,
      "an empty array would read as `the call named no purposes`, which is false - it named one this writer refused to store"
    );
    assert.equal(raw.count, 1, "the row is still written: something was refused and that fact survives nowhere else");
  });
});

test("recordTrail refuses a caseRef and an actor.ref that are not opaque references", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const savedError = console.error;
    console.error = () => {};
    try {
      await recordTrail(models, {
        kind: "operator_lookup",
        outcome: "recorded",
        reasonCode: "no_match",
        actor: { role: "operator", ref: "emp-10432", channel: "api" },
        caseRef: "asha@example.com",
      });
      await recordTrail(models, {
        kind: "operator_lookup",
        outcome: "recorded",
        reasonCode: "no_match",
        actor: { role: "operator", ref: "asha nair", channel: "api" },
        caseRef: "INC-0042199",
      });
    } finally {
      console.error = savedError;
    }

    assert.equal(
      await models.TrailEntry.countDocuments({}),
      0,
      "a row is dropped rather than written with contact details or free text in it"
    );
  });
});

test("a failed trail write never reaches the caller, and the log names err.name and err.code but never err.message", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const savedCreate = models.TrailEntry.create;
    const savedError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    // The patch lives on a model bound to this test's throwaway connection,
    // so it cannot leak into another test.
    const boom = Object.assign(new Error('E11000 duplicate key error: { caseRef: "INC-0042199" }'), {
      name: "MongoServerError",
      code: 11000,
    });
    models.TrailEntry.create = () => Promise.reject(boom);
    try {
      await recordTrail(models, {
        principalId: PID,
        kind: "age_gate_refused",
        outcome: "refused",
        reasonCode: "parental_consent_required",
      });
    } finally {
      models.TrailEntry.create = savedCreate;
      console.error = savedError;
    }

    assert.equal(logged.length, 1, "a lost row must still be visible to whoever runs the deployment");
    const line = JSON.stringify(logged[0]);
    assert.match(line, /MongoServerError/, "err.name says what class of failure it was");
    assert.match(line, /11000/, "err.code says which one");
    assert.doesNotMatch(
      line,
      /INC-0042199/,
      "err.message quotes the offending value back, which is how a caller-supplied value reaches a log - the same discipline as the router's error mapper"
    );
  });
});

test("recordTrailStrict turns the same failure into a 503, so a disclosure without a record cannot happen", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const savedCreate = models.TrailEntry.create;
    const savedError = console.error;
    console.error = () => {};
    models.TrailEntry.create = () => Promise.reject(Object.assign(new Error("no primary"), { name: "MongoServerError", code: 189 }));
    try {
      await assert.rejects(
        () =>
          recordTrailStrict(models, {
            principalId: PID,
            kind: "operator_trail_read",
            outcome: "recorded",
            actor: { role: "operator", ref: "emp-10432", channel: "api" },
            caseRef: "INC-0042199",
          }),
        (err) => err.status === 503,
        "no record, no disclosure - an unaudited people-search is worse than no people-search"
      );
    } finally {
      models.TrailEntry.create = savedCreate;
      console.error = savedError;
    }
  });
});

test("recordTrailStrict rejects a bad caseRef as a 400, not a 503 - that is the caller's mistake, not an outage", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () =>
        recordTrailStrict(models, {
          kind: "operator_lookup",
          outcome: "recorded",
          reasonCode: "no_match",
          actor: { role: "operator", ref: "emp-10432", channel: "api" },
          caseRef: "ticket for asha@example.com",
        }),
      (err) => err.status === 400,
      "a 503 would tell an operator the database is down when their own payload is the problem"
    );
    assert.equal(await models.TrailEntry.countDocuments({}), 0);
  });
});

test("recordTrailStrict writes the access record, and a lookup that matched nobody stores no subject", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await recordTrailStrict(models, {
      kind: "operator_lookup",
      outcome: "recorded",
      reasonCode: "no_match",
      actor: { role: "operator", ref: "emp-10432", channel: "api" },
      caseRef: "INC-0042199",
    });

    const raw = await models.TrailEntry.findOne({ kind: "operator_lookup" }).lean();
    assert.deepEqual(raw.actor, { role: "operator", ref: "emp-10432", channel: "api" });
    assert.equal(raw.caseRef, "INC-0042199");
    assert.equal(
      Object.hasOwn(raw, "principalId"),
      false,
      "a miss must not manufacture a subject - there is no principal to file it under"
    );
  });
});
