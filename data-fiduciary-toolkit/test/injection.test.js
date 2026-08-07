const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");
const { buildModels } = require("../src/models");
const withdrawConsent = require("../src/services/withdrawConsent");

test("withdrawConsent rejects a NoSQL operator instead of matching an arbitrary principal", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const victimId = "b".repeat(64);
    await models.ConsentRecord.create({
      principalId: victimId,
      docRef: "CN-TEST-0001",
      events: [
        {
          type: "marketing",
          status: "granted",
          basis: "Your consent",
          lawfulBasisKind: "consent",
          receiptId: "RC-TEST",
          timestamp: new Date(),
        },
      ],
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
