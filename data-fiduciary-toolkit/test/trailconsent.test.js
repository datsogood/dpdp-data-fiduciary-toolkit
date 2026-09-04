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

// ---------------------------------------------------------------------------
// consent_refused / record_erased - PUT /consent, thrown before any write
// ---------------------------------------------------------------------------

test("a consent update refused because the record is erased leaves a refusal row - erasure is terminal, so this is the last thing that will ever happen on the record and nothing else writes it down", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await erasePrincipalPII({ models, principalId });

    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ consentTypes: ["analytics"] }),
      });
      assert.equal(res.status, 409, "setup check - the erased guard must actually have refused");
    } finally {
      await new Promise((r) => server.close(r));
    }

    const rows = await models.TrailEntry.find({ kind: "consent_refused", reasonCode: "record_erased" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "refused");
    assert.equal(rows[0].principalId, principalId);
    assert.equal(rows[0].actor.role, "principal");
    assert.equal(rows[0].actor.channel, "api",
      "identity comes from the session, and the channel is what an API client asked for");
  });
});

test("the channel a refusal arrived on is recorded, so a browser form and an API client are told apart", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const app = express();
    // Signup is deliberately unauthenticated, so no resolvePrincipal is needed
    // to reach POST /consent.
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
        body: new URLSearchParams({
          name: "Child",
          email: "form-child@example.com",
          dob: minorDob(),
          consentSubmitted: "1",
        }),
      });
      assert.equal(res.status, 422, "setup check - the age gate must actually have refused");
    } finally {
      await new Promise((r) => server.close(r));
    }

    const rows = await models.TrailEntry.find({ kind: "age_gate_refused" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor.role, "principal");
    assert.equal(rows[0].actor.channel, "html");
    assert.equal(rows[0].principalId, undefined,
      "signup still has no subject, however the refusal arrived");
  });
});

// ---------------------------------------------------------------------------
// The failure policy (section 8.2): instrumentation writes fail OPEN
// ---------------------------------------------------------------------------

test("a trail write that fails does not fail the act it is instrumenting - the minor still gets the 422 that explains why", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    // Any property lookup on TrailEntry throws, so recordTrail fails however
    // it chose to write - create, save, insertMany. That is deliberate: this
    // asserts the CONTRACT ("never throws") rather than one implementation of
    // it, which also means recordTrail's whole body has to sit inside its
    // try/catch, not just the await.
    const broken = {
      ...models,
      TrailEntry: new Proxy({}, { get() { throw new Error("trail collection is down"); } }),
    };

    await assert.rejects(
      () =>
        persistPIIwithconsent({
          models: broken,
          pii: { name: "Child", email: "failopen@example.com", phone: "9", dob: minorDob() },
          consentTypes: ["marketing"],
        }),
      (e) => e.status === 422 && /parental consent/i.test(e.message)
    );

    assert.equal(await models.TrailEntry.countDocuments(), 0,
      "the write really did fail - otherwise this test passes vacuously");
  });
});

test("a trail write that fails does not fail a SUCCESSFUL consent submission either - the receipt is still returned in full", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const a = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "underwriting"] });

    const broken = {
      ...models,
      TrailEntry: new Proxy({}, { get() { throw new Error("trail collection is down"); } }),
    };
    // Omitting marketing withdraws it, which is the path that writes a
    // withdrawal_hook_not_fired row after the save.
    const b = await persistPIIwithconsent({
      models: broken,
      principalId: a.principalId,
      pii: PII,
      consentTypes: ["underwriting"],
    });

    assert.deepEqual(b.events.map((e) => `${e.type}:${e.status}`), ["marketing:withdrawn"],
      "the ledger append must have happened and been reported, trail or no trail");
    assert.ok(b.receiptId);
    const record = await models.ConsentRecord.findOne({ principalId: a.principalId });
    assert.equal(record.events.filter((e) => e.status === "withdrawn").length, 1);
    assert.equal(await models.TrailEntry.countDocuments(), 0);
  });
});

// ---------------------------------------------------------------------------
// The exclusions (section 7). These are not gaps - each one is a write an
// attacker would otherwise control, and a test is the only thing that keeps
// them cut.
// ---------------------------------------------------------------------------

test("GET /consent/new grows the trail by exactly zero - it is the one deliberately unauthenticated, checkOrigin-exempt page, so a row here would make a cross-site <img> a database write", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const app = express();
    // No session: this page is reachable with no principal at all, which is
    // the whole reason instrumenting it is unsafe.
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      for (let i = 0; i < 20; i += 1) {
        const res = await fetch(`http://localhost:${port}/dpdp/consent/new`, {
          headers: { Accept: "text/html" },
        });
        assert.equal(res.status, 200,
          "setup check - the page must actually render, or this test passes by never reaching the route");
        const html = await res.text();
        assert.match(html, /<form/, "setup check - the notice and consent form is what was served");
      }
    } finally {
      await new Promise((r) => server.close(r));
    }

    assert.equal(await models.TrailEntry.countDocuments({}), 0,
      "twenty renders, zero rows - checkOrigin exempts GET, so any row written here is one an attacker appends from an <img> tag on a site they control, at whatever rate they like");
  });
});

test("twenty duplicate-signup 409s grow the victim's trail by exactly zero - recording the signup 409 would hand an unauthenticated stranger who knows an email an unthrottled append primitive against that person's own evidence", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);

    // The victim, with one genuine row already on their trail, so "unchanged"
    // below is a real comparison and not 0 === 0. Omitting marketing from the
    // second submission withdraws it, which writes withdrawal_hook_not_fired.
    const victim = await persistPIIwithconsent({
      models,
      pii: PII,
      consentTypes: ["marketing", "underwriting"],
    });
    await persistPIIwithconsent({
      models,
      principalId: victim.principalId,
      pii: PII,
      consentTypes: ["underwriting"],
    });
    const before = await models.TrailEntry.countDocuments({ principalId: victim.principalId });
    assert.equal(before, 1, "setup check - the victim must have something buriable on their trail");

    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      for (let i = 0; i < 20; i += 1) {
        // Only the email is needed to reach the existence check - the attacker
        // is a stranger who knows an address, and nothing more.
        const res = await fetch(`http://localhost:${port}/dpdp/consent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ name: "Not Asha", email: PII.email, phone: "1", dob: "1990-04-01", consentTypes: ["marketing"] }),
        });
        assert.equal(res.status, 409,
          "setup check - the existence check must refuse before any write, or this test is measuring the wrong route");
      }
    } finally {
      await new Promise((r) => server.close(r));
    }

    assert.equal(await models.TrailEntry.countDocuments({ principalId: victim.principalId }), before,
      "reads are newest-first and bounded, so twenty appends a stranger controls are an evidence-burial primitive, not an audit trail");
    assert.equal(await models.TrailEntry.countDocuments({}), before,
      "and not filed against some other subject either - the refusal is recorded nowhere at all");

    const stored = await models.Principal.findOne({ principalId: victim.principalId });
    assert.equal(stored.pii.name, PII.name,
      "the existence check also still runs before any write, so twenty attempts overwrote nothing - this is the C1 attack the route's own comment describes");
  });
});

// ---------------------------------------------------------------------------
// The E11000 recovery branch (review finding): decideFor runs a second time
// against the winning document, and the instrumentation block sits after the
// whole try/catch closes so it fires once regardless of which branch ran. A
// row per decideFor call, rather than per submission, would double every
// refusal on this path - and nothing above this file forces the collision, so
// nothing above would have caught it.
// ---------------------------------------------------------------------------

test("a trail row on the E11000 recovery path is written once, not once per decideFor call - the recomputed refusal is not a second refusal", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const childPii = { name: "Child", email: "child-collision@example.com", phone: "4", dob: minorDob() };

    // Seed a real ledger for this principal so the forced-miss collision
    // below has a genuine winning document to collide with. This seed call
    // is itself a minor submission, so - like every minor submission - it
    // also writes its own consent_refused row for marketing/analytics; that
    // row is expected and is not what this test measures. What is measured
    // below is filtered by the SECOND call's own receiptId, so the seed's
    // row cannot hide a duplicate or be mistaken for one.
    const seed = await persistPIIwithconsent({
      models, pii: childPii, consentTypes: ["underwriting"], parentalConsent: PARENT,
    });
    const principalId = seed.principalId;

    // Force the losing interleaving deterministically, the same way
    // test/consent.test.js's "create-race recovery" test does: the next
    // submission's read misses the record that is really there, so its
    // insert collides on the unique principalId index and the recovery path
    // - not the happy path - is the only way through. That means decideFor
    // runs TWICE for this one call: once against the empty state the missed
    // read implies, once again in the catch against the re-read winner.
    // prohibited_for_child does not depend on ledger state at all, so both
    // calls compute the identical refusal - which is exactly why a write
    // site duplicated across the two decideFor call sites would be
    // invisible in its DATA and visible only in its COUNT.
    const realFindOne = models.ConsentRecord.findOne.bind(models.ConsentRecord);
    let forcedMisses = 0;
    models.ConsentRecord.findOne = (...args) => {
      if (forcedMisses === 0) {
        forcedMisses += 1;
        return Promise.resolve(null);
      }
      return realFindOne(...args);
    };
    let result;
    try {
      result = await persistPIIwithconsent({
        models,
        principalId,
        pii: childPii,
        consentTypes: ["marketing", "analytics"],
      });
    } finally {
      models.ConsentRecord.findOne = realFindOne;
    }

    assert.equal(forcedMisses, 1, "the forced miss must have been consumed, or no collision was provoked");
    assert.deepEqual([...result.refusedForChild].sort(), ["analytics", "marketing"],
      "setup check - the recovery must actually have recomputed a refusal, or this test proves nothing");
    assert.equal(await models.ConsentRecord.countDocuments({ principalId }), 1,
      "the unique index is the backstop - one ledger survives, whichever attempt won");

    // Filtered by THIS call's receiptId, not just principalId, so the seed's
    // own (expected, separate) refusal row cannot be mistaken for one of
    // these or hide a real duplicate among them.
    const rows = await models.TrailEntry.find({ kind: "consent_refused", receiptId: result.receiptId });
    assert.equal(rows.length, 1,
      "decideFor ran twice on this call, and the refusal it reports is identical both times - a write site attached to either call individually would double this row, and a state-independent kind like this one would not show up as wrong data, only as a wrong count");
  });
});
