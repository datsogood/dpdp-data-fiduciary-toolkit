const test = require("node:test");
const assert = require("node:assert/strict");
const { Schema } = require("mongoose");
const { withDb } = require("./helpers/db");
const withdrawConsent = require("../src/services/withdrawConsent");

// Built inline: buildModels() arrives in Task 3. T3 replaces this block.
function modelsFor(conn) {
  const eventSchema = new Schema(
    { type: String, status: String, basis: String, timestamp: Date },
    { _id: false }
  );
  const schema = new Schema({
    principalId: { type: String, required: true, unique: true },
    docRef: { type: String, required: true, unique: true },
    events: { type: [eventSchema], default: [] },
    updatedAt: Date,
  });
  schema.methods.currentState = function () {
    const latest = {};
    for (const e of this.events) {
      if (!latest[e.type] || e.timestamp >= latest[e.type].timestamp) latest[e.type] = e;
    }
    return latest;
  };
  return { ConsentRecord: conn.model("ConsentRecord", schema) };
}

test("withdrawConsent rejects a NoSQL operator instead of matching an arbitrary principal", async () => {
  await withDb(async (conn) => {
    const models = modelsFor(conn);
    const victimId = "b".repeat(64);
    await models.ConsentRecord.create({
      principalId: victimId,
      docRef: "CN-TEST-0001",
      events: [{ type: "marketing", status: "granted", basis: "Your consent", timestamp: new Date() }],
    });

    for (const payload of [{ $gt: "" }, { $ne: null }, { $regex: ".*" }]) {
      await assert.rejects(
        () => withdrawConsent({ models, principalId: payload, consentTypes: ["marketing"] }),
        (err) => err.status === 400,
        `operator ${JSON.stringify(payload)} must be rejected`
      );
    }

    // The victim's ledger must be untouched: still exactly one event.
    const after = await models.ConsentRecord.findOne({ principalId: victimId });
    assert.equal(after.events.length, 1);
    assert.equal(after.events[0].status, "granted");
  });
});
