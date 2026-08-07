const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-32chars";
const { buildModels } = require("../src/models");
const { getCatalog } = require("../src/config/catalog");
const { findOrCreatePrincipal } = require("../src/utils/principalId");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const withdrawConsent = require("../src/services/withdrawConsent");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };

function statusOf(state, type) {
  return state[type] ? state[type].status : undefined;
}

function eventsFor(record, type) {
  return record.events.filter((e) => e.type === type);
}

// Guarantees two submissions land in different milliseconds, so an updatedAt
// assertion is deterministic rather than a race against the clock.
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// ---------------------------------------------------------------------------
// The state table. Each row of (current state, submitted) -> outcome gets a
// test, because the rows that produce NO event are the whole point: an
// unchanged submission must not grow an append-only ledger.
// ---------------------------------------------------------------------------

test("a declined optional purpose is recorded as denied, never as withdrawn", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const r = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    assert.equal(statusOf(r.state, "marketing"), "granted");
    assert.equal(statusOf(r.state, "analytics"), "denied",
      "a purpose that was offered and declined was never granted, so it cannot have been withdrawn");
    const record = await models.ConsentRecord.findOne({ principalId: r.principalId });
    assert.equal(record.events.filter((e) => e.status === "withdrawn").length, 0);
  });
});

test("re-posting the same choices appends no new events", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const first = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const countAfterFirst = (await models.ConsentRecord.findOne({ principalId: first.principalId })).events.length;

    const second = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const countAfterSecond = (await models.ConsentRecord.findOne({ principalId: second.principalId })).events.length;
    assert.equal(countAfterSecond, countAfterFirst, "an unchanged submission must not grow the ledger");
    assert.equal(second.events.length, 0);
    // Row 3 for marketing (granted, ticked again) and row 6 for analytics
    // (denied, left out) - both must be silent.
    assert.equal(statusOf(second.state, "marketing"), "granted");
    assert.equal(statusOf(second.state, "analytics"), "denied");
  });
});

test("dropping a purpose from a later submission withdraws it, exactly once", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const first = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    const second = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    assert.equal(statusOf(second.state, "analytics"), "withdrawn");
    assert.equal(statusOf(second.state, "marketing"), "granted");
    assert.equal(second.events.length, 1, "only the purpose that actually changed produces an event");
    assert.equal(second.events[0].type, "analytics");
    assert.equal(second.events[0].status, "withdrawn");

    const record = await models.ConsentRecord.findOne({ principalId: first.principalId });
    assert.equal(eventsFor(record, "marketing").length, 1, "the unchanged grant is not re-appended");
  });
});

test("a purpose that was declined can be granted later, with no regrant flag needed", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const first = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    assert.equal(statusOf(first.state, "analytics"), "denied");

    const second = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    assert.equal(statusOf(second.state, "analytics"), "granted",
      "a decline is not a withdrawal, so changing your mind about it is an ordinary grant");
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].type, "analytics");
    assert.equal(second.events[0].status, "granted");
  });
});

test("re-posting does NOT silently resurrect a withdrawn consent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });

    // A profile-update screen re-posts with the box still ticked.
    const after = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    assert.equal(statusOf(after.state, "marketing"), "withdrawn",
      "a withdrawal must survive a re-post - reversing it requires an explicit act");
    assert.equal(after.events.length, 0);
  });
});

test("regrant: true reverses a withdrawal explicitly", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });
    const after = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"], regrant: true });
    assert.equal(statusOf(after.state, "marketing"), "granted");
    assert.equal(after.events.length, 1, "the regrant is one fresh consent act, not a rewrite of history");
    assert.equal(after.events[0].status, "granted");

    const record = await models.ConsentRecord.findOne({ principalId });
    assert.deepEqual(
      eventsFor(record, "marketing").map((e) => e.status),
      ["granted", "withdrawn", "granted"],
      "the withdrawal stays in the ledger - the regrant is appended after it"
    );
  });
});

test("a withdrawal stands whether the next submission ticks the box or leaves it out", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({
      models, pii: PII, consentTypes: ["marketing", "analytics"],
    });
    await withdrawConsent({ models, principalId, consentTypes: ["marketing", "analytics"] });
    const before = (await models.ConsentRecord.findOne({ principalId })).events.length;

    // marketing is ticked again, analytics is left out. Neither may move.
    const after = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    assert.equal(statusOf(after.state, "marketing"), "withdrawn");
    assert.equal(statusOf(after.state, "analytics"), "withdrawn");
    assert.equal(after.events.length, 0, "neither a re-tick nor an omission may touch a withdrawal");
    assert.equal((await models.ConsentRecord.findOne({ principalId })).events.length, before);
  });
});

test("a profile update that omits consentTypes does not silently withdraw a live consent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const first = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    // consentTypes omitted entirely - this is a PII update, not a consent decision.
    const after = await persistPIIwithconsent({ models, pii: { ...PII, phone: "9999999999" } });
    assert.equal(statusOf(after.state, "marketing"), "granted", "omitting consentTypes must not revoke anything");
    assert.equal(statusOf(after.state, "analytics"), "granted");
    assert.equal(after.events.length, 0, "a PII-only update touches no consent at all");
    assert.equal(after.principalId, first.principalId);
  });
});

test("consentTypes: null counts as omission, not as a decline of everything", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const first = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    const principalId = first.principalId;
    const before = (await models.ConsentRecord.findOne({ principalId })).events.length;

    // A JSON body may legally carry "consentTypes": null, and a client that
    // serialises an absent value as null rather than dropping the key must not
    // thereby revoke every live optional consent. assertStringArray maps both
    // undefined and null to [], so this is one token away from being a decline.
    const after = await persistPIIwithconsent({ models, pii: PII, consentTypes: null });
    assert.equal(after.events.length, 0, "null carries no consent decision, so it appends nothing");
    assert.equal(statusOf(after.state, "marketing"), "granted");
    assert.equal(statusOf(after.state, "analytics"), "granted");
    assert.equal((await models.ConsentRecord.findOne({ principalId })).events.length, before,
      "the ledger is append-only, so a null-shaped payload must not grow it");
  });
});

test("an empty consentTypes array declines everything, which is not the same as omitting it", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const declined = await persistPIIwithconsent({ models, pii: PII, consentTypes: [] });
    assert.equal(statusOf(declined.state, "marketing"), "denied");
    assert.equal(statusOf(declined.state, "analytics"), "denied");
    assert.equal(statusOf(declined.state, "underwriting"), "denied");

    // Omitting the field records no consent decision at all, so nothing that
    // depends on consent appears in this principal's ledger.
    const omitted = await persistPIIwithconsent({
      models, pii: { name: "Bhavna", email: "bhavna@example.com", phone: "9000000000" },
    });
    assert.equal(statusOf(omitted.state, "marketing"), undefined,
      "omitting consentTypes must not record a decision the principal never made");
    assert.equal(omitted.events.length, 1, "only the legitimate use is recorded, and only for notice");
    assert.equal(omitted.events[0].type, "kyc_reporting");
  });
});

test("a legitimate use is recorded once for notice and is never withdrawn by omission", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const first = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    assert.equal(statusOf(first.state, "kyc_reporting"), "granted");
    assert.equal(first.state.kyc_reporting.lawfulBasisKind, "legitimate_use",
      "the ledger must name the non-consent basis rather than implying the principal consented");

    await persistPIIwithconsent({ models, pii: PII, consentTypes: [] });
    const third = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["analytics"] });
    assert.equal(statusOf(third.state, "kyc_reporting"), "granted");

    const record = await models.ConsentRecord.findOne({ principalId: first.principalId });
    assert.equal(eventsFor(record, "kyc_reporting").length, 1,
      "a purpose that does not depend on choice is recorded once, then left alone");
  });
});

test("a consent-based purpose an adopter marked non-withdrawable is not withdrawn by omission", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    // Not a purpose this toolkit ships - it stands in for one an adopter
    // hand-authors. persistPIIwithconsent and withdrawConsent must agree about
    // it by construction, not by luck of the shipped catalog.
    getCatalog().push({
      type: "legacy_locked",
      title: "A hand-authored purpose",
      purpose: "Stands in for an adopter's own catalog entry.",
      lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
      withdrawable: false,
      prohibitedForChildren: false,
      retentionMonths: 12,
    });
    try {
      const first = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["legacy_locked"] });
      assert.equal(statusOf(first.state, "legacy_locked"), "granted");

      const second = await persistPIIwithconsent({ models, pii: PII, consentTypes: [] });
      assert.equal(statusOf(second.state, "legacy_locked"), "granted",
        "POST /consent must not withdraw what withdrawConsent would refuse to withdraw");
      assert.equal(second.events.filter((e) => e.type === "legacy_locked").length, 0);

      const w = await withdrawConsent({
        models, principalId: first.principalId, consentTypes: ["legacy_locked"],
      });
      assert.deepEqual(w.withdrawn, [], "and withdrawConsent does refuse it");
      assert.equal(w.rejected[0].type, "legacy_locked");
    } finally {
      getCatalog().pop();
    }
  });
});

test("an unknown consent type is rejected before anything is written", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () => persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "sell_to_brokers"] }),
      (err) => err.status === 400 && /sell_to_brokers/.test(err.message)
    );
    assert.equal(await models.Principal.countDocuments({}), 0, "a rejected payload writes no principal");
    assert.equal(await models.ConsentRecord.countDocuments({}), 0);
  });
});

// ---------------------------------------------------------------------------
// withdrawConsent
// ---------------------------------------------------------------------------

test("underwriting can now be withdrawn, and the 7(d) reporting duty still cannot", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["underwriting"] });
    const r = await withdrawConsent({ models, principalId, consentTypes: ["underwriting", "kyc_reporting"] });
    assert.deepEqual(r.withdrawn, ["underwriting"]);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].type, "kyc_reporting");
    assert.match(r.rejected[0].reason, /Section 7\(d\)/,
      "the refusal must name the clause it rests on, so the principal can check it");
  });
});

test("an unknown purpose is reported as unknown, not looked up for a clause it has no entry for", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const r = await withdrawConsent({ models, principalId, consentTypes: ["not_a_purpose", "marketing"] });
    assert.deepEqual(r.withdrawn, ["marketing"]);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].type, "not_a_purpose");
    assert.match(r.rejected[0].reason, /Unknown consent type/);
  });
});

test("withdrawing an already-withdrawn purpose is a no-op, not a duplicate event", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const first = await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });
    const before = (await models.ConsentRecord.findOne({ principalId })).events.length;
    const second = await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });
    const after = (await models.ConsentRecord.findOne({ principalId })).events.length;
    assert.equal(after, before, "a replayed withdrawal must not append a second event");
    assert.deepEqual(second.withdrawn, []);
    assert.deepEqual(second.noChange, ["marketing"]);
    assert.equal(first.effectiveFrom.getTime() <= Date.now(), true);
    assert.equal(second.effectiveFrom, null,
      "a no-op must not report a moment a revocation took effect - nothing took effect");
  });
});

test("a purpose listed twice in one withdrawal request yields one event", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const r = await withdrawConsent({ models, principalId, consentTypes: ["marketing", "marketing"] });
    assert.deepEqual(r.withdrawn, ["marketing"]);

    const record = await models.ConsentRecord.findOne({ principalId });
    assert.equal(
      eventsFor(record, "marketing").filter((e) => e.status === "withdrawn").length,
      1,
      "the ledger is append-only, so a duplicate in the request must not become a duplicate event"
    );
  });
});

test("an onWithdrawal hook fires with the purposes that actually changed", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({
      models, pii: PII, consentTypes: ["marketing", "analytics"],
    });
    const calls = [];
    await withdrawConsent({
      models, principalId, consentTypes: ["marketing", "kyc_reporting"],
      onWithdrawal: (payload) => calls.push(payload),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].types, ["marketing"], "only real changes are reported, not rejections");
    assert.equal(calls[0].principalId, principalId);
  });
});

test("the onWithdrawal hook does not fire when nothing changed", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });
    const calls = [];
    await withdrawConsent({
      models, principalId, consentTypes: ["marketing", "kyc_reporting"],
      onWithdrawal: (payload) => calls.push(payload),
    });
    assert.deepEqual(calls, [], "a cessation-and-erasure pipeline must not be re-run for a no-op");
  });
});

// ---------------------------------------------------------------------------
// Receipts and the create race
// ---------------------------------------------------------------------------

test("each submission gets its own receipt id, distinct from the record ref", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const a = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const b = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    assert.equal(a.docRef, b.docRef, "docRef identifies the record");
    assert.notEqual(a.receiptId, b.receiptId, "a receipt must identify the transaction, not the person");
    assert.equal(b.events[0].receiptId, b.receiptId, "every event carries the receipt of the act that created it");
  });
});

test("a notice-only submission moves updatedAt; a submission that changes nothing does not", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const first = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const principalId = first.principalId;
    const baseline = (await models.ConsentRecord.findOne({ principalId })).updatedAt;

    await tick();
    await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    assert.deepEqual((await models.ConsentRecord.findOne({ principalId })).updatedAt, baseline,
      "a submission that changes nothing must not touch the record at all");

    await tick();
    await persistPIIwithconsent({
      models, pii: PII, consentTypes: ["marketing"],
      notice: { version: "2026-08-01", language: "en" },
    });
    const afterNotice = (await models.ConsentRecord.findOne({ principalId })).updatedAt;
    assert.ok(afterNotice > baseline,
      "refreshing the notice snapshot is a modification of the record, so updatedAt must move");
  });
});

test("the create-race recovery recomputes against the winner instead of replaying", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const winner = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const principalId = winner.principalId;
    const stored = await models.ConsentRecord.findOne({ principalId });
    assert.deepEqual([...new Set(stored.events.map((e) => e.receiptId))], [winner.receiptId]);

    // Force the losing interleaving rather than hoping the event loop provides
    // it: the next submission's read misses the record, exactly as it would if
    // the winner had not committed yet, so its insert collides on the unique
    // principalId index and the recovery path is the only way through.
    const realFindOne = models.ConsentRecord.findOne.bind(models.ConsentRecord);
    let forcedMisses = 0;
    models.ConsentRecord.findOne = (...args) => {
      if (forcedMisses === 0) {
        forcedMisses += 1;
        return Promise.resolve(null);
      }
      // The recovery's own re-read must see the truth. The patch lives on a
      // model bound to this test's throwaway connection, so it cannot leak.
      return realFindOne(...args);
    };
    let loser;
    try {
      loser = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    } finally {
      models.ConsentRecord.findOne = realFindOne;
    }

    assert.equal(forcedMisses, 1, "the forced miss must have been consumed, or no collision was provoked");
    assert.equal(loser.events.length, 0, "the delta recomputed against the winner is empty");
    assert.equal(loser.docRef, winner.docRef, "the loser reports the surviving ref, not the one it discarded");
    assert.notEqual(loser.receiptId, winner.receiptId);

    assert.equal(await models.ConsentRecord.countDocuments({ principalId }), 1);
    const after = await models.ConsentRecord.findOne({ principalId });
    assert.equal(after.events.length, stored.events.length, "a replay would have doubled the ledger");
    assert.deepEqual([...new Set(after.events.map((e) => e.receiptId))], [winner.receiptId],
      "the loser's receipt must appear nowhere in the ledger - it appended nothing");
  });
});

test("two concurrent first submissions cannot create two ledgers for one principal", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    // End-to-end companion to the forced-collision test above, and deliberately
    // weaker: it proves that two genuinely concurrent submissions cannot leave
    // two ledgers or a doubled event, which also confirms the unique index is
    // built by the time the write happens. It does NOT pin the recovery - if the
    // two calls ever serialise, every assertion below still holds because the
    // second call simply finds the first's record. The recovery itself is pinned
    // deterministically above, by forcing the missed read.
    //
    // Create the principal up front so both calls agree on the principalId.
    const { principal } = await findOrCreatePrincipal({ models, pii: PII });
    const principalId = principal.principalId;

    const submit = () => persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const [a, b] = await Promise.all([submit(), submit()]);

    assert.equal(await models.ConsentRecord.countDocuments({ principalId }), 1,
      "exactly one ledger per principal - the unique index is the backstop");
    assert.equal(a.docRef, b.docRef,
      "the loser must report the surviving record's ref, not the one it discarded");

    const record = await models.ConsentRecord.findOne({ principalId });
    for (const entry of getCatalog()) {
      assert.equal(eventsFor(record, entry.type).length, 1,
        `${entry.type}: one event per purpose, however the two writers interleaved`);
    }
    assert.equal(a.events.length + b.events.length, getCatalog().length,
      "between them the two calls report exactly the events that were appended");
  });
});
