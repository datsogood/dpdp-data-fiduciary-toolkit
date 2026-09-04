const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
const { buildModels } = require("../src/models");
const createRouter = require("../src/http/router");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const withdrawConsent = require("../src/services/withdrawConsent");
const { erasePrincipalPII } = require("../src/services/erasure");
const { buildNotice } = require("../src/config/notice");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };

// A dob 14 years back, computed rather than hardcoded, so this file does not
// quietly stop testing a minor as the calendar moves.
function minorDob() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 14);
  return d.toISOString().slice(0, 10);
}

// Server-side only, and never wired to a route - see the isVerifiedParentalConsent
// docstring. It exists here so the age gate lets a child through and the NEXT
// refusal, the prohibited-purpose one, is the thing under test.
const PARENT = {
  name: "Guardian",
  email: "guardian@example.com",
  relationship: "mother",
  verifiedAt: new Date("2026-01-01"),
};

// ---------------------------------------------------------------------------
// age_gate_refused - thrown before any write, so nothing else records it
// ---------------------------------------------------------------------------

test("a minor refused at the age gate on SIGNUP is recorded with no principalId - the gate throws before findOrCreatePrincipal, so inventing a subject would be manufacturing evidence", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () =>
        persistPIIwithconsent({
          models,
          pii: { name: "Child", email: "child@example.com", phone: "1", dob: minorDob() },
          consentTypes: ["marketing"],
        }),
      (e) => e.status === 422
    );

    const rows = await models.TrailEntry.find({ kind: "age_gate_refused" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].reasonCode, "parental_consent_required");
    assert.equal(rows[0].principalId, undefined,
      "absent, not null - there is no principal, and a subject-shaped hole is worse than no field");
    assert.equal(rows[0].actor.role, "unattributed",
      "a direct service call is genuinely unattributed - `system` would be a claim the library cannot back");
    assert.equal(rows[0].actor.channel, "library");
    assert.ok(rows[0].at instanceof Date);

    assert.equal(await models.Principal.countDocuments(), 0,
      "the trail write must not have created the Principal the gate exists to prevent");
    assert.equal(await models.ConsentRecord.countDocuments(), 0);
  });
});

test("a minor refused at the age gate on the AUTHENTICATED branch IS filed under their principalId - the principal was loaded before the gate ran", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const adult = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    // A dob correction that reveals the account holder is in fact a child.
    // On this branch the principal is resolved BEFORE the gate, because the
    // stored record is where a registered minor's parental consent lives.
    await assert.rejects(
      () =>
        persistPIIwithconsent({
          models,
          principalId: adult.principalId,
          pii: { ...PII, dob: minorDob() },
          consentTypes: ["marketing"],
        }),
      (e) => e.status === 422
    );

    const rows = await models.TrailEntry.find({ kind: "age_gate_refused" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].principalId, adult.principalId);
    assert.equal(rows[0].reasonCode, "parental_consent_required");
  });
});

// ---------------------------------------------------------------------------
// consent_refused / prohibited_for_child - returned to the caller, persisted
// nowhere
// ---------------------------------------------------------------------------

test("every purpose prohibited for a child collapses into ONE refusal row carrying the count and the list - a submission naming 200 types must not write 200 rows", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const r = await persistPIIwithconsent({
      models,
      pii: { name: "Child", email: "child2@example.com", phone: "2", dob: minorDob() },
      consentTypes: ["marketing", "analytics", "underwriting"],
      parentalConsent: PARENT,
    });
    assert.deepEqual([...r.refusedForChild].sort(), ["analytics", "marketing"],
      "setup check - both prohibited purposes must actually have been refused");

    const rows = await models.TrailEntry.find({ kind: "consent_refused" });
    assert.equal(rows.length, 1, "one call refusing two purposes writes one row, not two");
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].reasonCode, "prohibited_for_child");
    assert.equal(rows[0].count, 2);
    assert.deepEqual([...rows[0].consentTypes].sort(), ["analytics", "marketing"]);
    assert.equal(rows[0].principalId, r.principalId);
    assert.equal(rows[0].receiptId, r.receiptId,
      "the refusal is part of a submission, and the receiptId is what ties it to one");
  });
});

// ---------------------------------------------------------------------------
// consent_not_applied / regrant_not_requested - the 200 with a receipt that
// names no event
// ---------------------------------------------------------------------------

test("a re-grant submitted without regrant:true is recorded as a no_change - the caller gets a 200 and a receipt naming no event, and nothing else says they asked", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const a = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await withdrawConsent({ models, principalId: a.principalId, consentTypes: ["marketing"] });

    const again = await persistPIIwithconsent({
      models,
      principalId: a.principalId,
      pii: PII,
      consentTypes: ["marketing"],
    });
    assert.equal(again.events.length, 0,
      "setup check - the silent no-op is the thing under test, so there must be no event");

    const rows = await models.TrailEntry.find({ kind: "consent_not_applied" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "no_change");
    assert.equal(rows[0].reasonCode, "regrant_not_requested");
    assert.equal(rows[0].count, 1);
    assert.deepEqual([...rows[0].consentTypes], ["marketing"]);
    assert.equal(rows[0].principalId, a.principalId);
    assert.equal(rows[0].receiptId, again.receiptId);

    // The inverse, so the row cannot be produced by any re-grant at all.
    const granted = await persistPIIwithconsent({
      models,
      principalId: a.principalId,
      pii: PII,
      consentTypes: ["marketing"],
      regrant: true,
    });
    assert.equal(granted.events.length, 1);
    assert.equal(granted.events[0].status, "granted");
    assert.equal((await models.TrailEntry.find({ kind: "consent_not_applied" })).length, 1,
      "an honoured re-grant is a real ledger event, so it is derived at read time and writes no row");
  });
});

// ---------------------------------------------------------------------------
// withdrawal_hook_not_fired - the withdrawal is in the ledger and is derived;
// that the host was never told is not
// ---------------------------------------------------------------------------

test("a purpose withdrawn by omission records that no cease-processing hook fired - the withdrawal itself is derived from the ledger, but a possibly undischarged Section 6(6) duty is not", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const a = await persistPIIwithconsent({
      models,
      pii: PII,
      consentTypes: ["marketing", "underwriting"],
    });
    const b = await persistPIIwithconsent({
      models,
      principalId: a.principalId,
      pii: PII,
      consentTypes: ["underwriting"],
    });
    assert.deepEqual(b.events.map((e) => `${e.type}:${e.status}`), ["marketing:withdrawn"],
      "setup check - omitting marketing must actually have withdrawn it");

    const rows = await models.TrailEntry.find({ kind: "withdrawal_hook_not_fired" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "recorded",
      "nothing was refused here - the withdrawal took effect, the notification did not happen");
    assert.equal(rows[0].reasonCode, undefined, "this kind has no reason code");
    assert.deepEqual([...rows[0].consentTypes], ["marketing"]);
    assert.equal(rows[0].count, 1);
    assert.equal(rows[0].principalId, a.principalId);
    assert.equal(rows[0].receiptId, b.receiptId);
  });
});

// ---------------------------------------------------------------------------
// The regression guard. This is the test that protects the 23 tests in
// consent.test.js, the JSON.stringify byte-compares in auth.test.js, and the
// per-event noticeVersion assertions in notice.test.js.
// ---------------------------------------------------------------------------

test("instrumenting the write path changes neither the ledger nor the returned object - a plain adult grant is identical to what it was before", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const notice = buildNotice({ language: "en" });
    const r = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"], notice });

    // The returned key set, exactly. `suppressed` is computed inside decideFor
    // and must never leak out of it: this is an exported function and a new
    // key on it is a silent API change.
    assert.deepEqual(Object.keys(r).sort(),
      ["created", "docRef", "events", "principalId", "receiptId", "refusedForChild", "state"]);
    assert.equal(r.created, true);
    assert.deepEqual(r.refusedForChild, []);
    assert.equal(r.events.length, 5);

    const record = await models.ConsentRecord.findOne({ principalId: r.principalId });

    // Per-event key set - an added ledger field fails here.
    for (const e of record.events) {
      assert.deepEqual(Object.keys(e.toObject()).sort(),
        ["basis", "lawfulBasisKind", "noticeVersion", "receiptId", "status", "timestamp", "type"]);
      assert.equal(e.receiptId, r.receiptId);
      assert.ok(e.timestamp instanceof Date);
    }

    // Per-event values, byte-compared. Rebuilt by explicit destructuring so
    // the key order is this test's, not mongoose's, and the two random fields
    // above are already asserted separately.
    const shape = ({ type, status, basis, lawfulBasisKind, noticeVersion }) =>
      ({ type, status, basis, lawfulBasisKind, noticeVersion });
    const B = "Your consent";
    const PMLA =
      "Obligation under law to disclose information to the State - reporting under the Prevention of Money-Laundering Act, 2002";
    assert.equal(
      JSON.stringify(record.events.map((e) => shape(e.toObject()))),
      JSON.stringify([
        { type: "kyc_reporting", status: "granted", basis: PMLA, lawfulBasisKind: "legitimate_use", noticeVersion: notice.version },
        { type: "identity_verification", status: "denied", basis: B, lawfulBasisKind: "consent", noticeVersion: notice.version },
        { type: "underwriting", status: "denied", basis: B, lawfulBasisKind: "consent", noticeVersion: notice.version },
        { type: "marketing", status: "granted", basis: B, lawfulBasisKind: "consent", noticeVersion: notice.version },
        { type: "analytics", status: "denied", basis: B, lawfulBasisKind: "consent", noticeVersion: notice.version },
      ])
    );

    assert.equal(await models.TrailEntry.countDocuments(), 0,
      "an adult granting consent destroys nothing, so under the partition rule it writes no trail row at all");
  });
});
