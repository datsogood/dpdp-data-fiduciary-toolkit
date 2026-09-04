const test = require("node:test");
const assert = require("node:assert/strict");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
const { buildModels } = require("../src/models");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const withdrawConsent = require("../src/services/withdrawConsent");
const { advanceGrievance } = require("../src/services/requestLifecycle");
const { complaintToTheBoard, escalateToBoard } = require("../src/services/complaintToTheBoard");
const { exerciseRight } = require("../src/services/dataPrincipalRights");
const consentManagerRequest = require("../src/services/consentManagerRequest");
const { erasePrincipalPII } = require("../src/services/erasure");
const { lookupHash } = require("../src/utils/principalId");
const { assertOpaqueRef } = require("../src/utils/validate");
const { getValidConsentTypes } = require("../src/config/catalog");
const {
  COVERAGE_FROM,
  recordTrail,
  getConsentTrail,
  findConsentTrailByContact,
} = require("../src/services/consentTrail");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };
const BHIM = { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" };

// Guarantees two acts land in different milliseconds, so an ordering
// assertion is deterministic rather than a race against the clock. Same
// helper, same reason, as test/consent.test.js:24.
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// The actor a router builds for a signed-in data principal, and the one the
// back office builds. `ref` is the field includeOperatorRefs gates.
const PRINCIPAL_API = { role: "principal", channel: "api" };
const OPERATOR = { role: "operator", ref: "emp-10432", channel: "api" };
// Every derived entry carries this one, because no primary collection stores
// an actor at all.
const DERIVED = { role: "principal", channel: "library" };

// ---------------------------------------------------------------------------
// The twelve-act timeline. This is the feature's executable documentation:
// the element shape, both sources, the derived vocabulary, the descending
// order and the identical-timestamp tiebreak, all pinned in one deepEqual.
// ---------------------------------------------------------------------------

/**
 * The twelve acts, played through the real services.
 *
 * A helper rather than a body inlined in one test, because three tests need
 * this exact history: the timeline that reads it back, the property scan that
 * walks every string it produced, and the erasure scan that proves what those
 * rows do NOT contain.
 *
 * Every act goes through the service a host would call - including the three
 * that produce STORED rows. Writing those three with recordTrail directly
 * would have tested the reader while bypassing the writer: an instrumentation
 * site deleted from withdrawConsent or requestLifecycle would leave this test
 * green, which is the opposite of what "the feature's executable
 * documentation" is for.
 */
async function playTwelveActs(models) {
  // Act 1 - signup. persistPIIwithconsent.js:146 stamps every event of one
  // submission with the same `now`, so this single act produces five ledger
  // events sharing one millisecond.
  const signup = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
  const { principalId } = signup;
  await tick();

  // Act 2 - a consent update granting one further purpose.
  const update = await persistPIIwithconsent({
    models, principalId, pii: PII, consentTypes: ["marketing", "underwriting"],
  });
  await tick();

  // Act 3 - a withdrawal the library refused, provoked rather than
  // simulated. kyc_reporting rests on Section 7(d), not on consent, so
  // withdrawConsent skips save() entirely (withdrawConsent.js:50-56 and :75)
  // and nothing survives the call but the row it writes.
  const refusal = await withdrawConsent({
    models, principalId, consentTypes: ["kyc_reporting"], actor: PRINCIPAL_API,
  });
  assert.equal(
    refusal.withdrawn.length,
    0,
    "setup check - kyc_reporting must actually be refused, or act 3 writes no row and all three tests weaken silently"
  );
  await tick();

  // Act 4 - a grievance.
  const grievance = await complaintToTheBoard({
    models, principalId, subject: "No answer", description: "I asked twice and heard nothing.",
  });
  await tick();

  // Act 5 - the Grievance Officer picks it up. requestLifecycle overwrites
  // status in place, so "open" exists nowhere else once this returns.
  await advanceGrievance({ models, refId: grievance.refId, status: "in_progress", actor: OPERATOR });
  await tick();

  // Act 6 - escalation, once the SLA has lapsed.
  const filed = await models.Grievance.findOne({ refId: grievance.refId });
  filed.slaDueAt = new Date(Date.now() - 1000);
  await filed.save();
  const escalation = await escalateToBoard({ models, refId: grievance.refId, principalId });
  await tick();

  // Act 7 - and finally resolved.
  await advanceGrievance({ models, refId: grievance.refId, status: "resolved", actor: OPERATOR });
  await tick();

  // Act 8 - erasure. The PII goes; the pseudonymous evidence stays.
  const erasure = await erasePrincipalPII({ models, principalId });

  return { principalId, signup, update, refusal, grievance, filed, escalation, erasure };
}

test("the twelve-act timeline reads back exactly, newest first, in one shape", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId, signup, update, refusal, grievance, filed, escalation, erasure } =
      await playTwelveActs(models);
    assert.equal(update.events.length, 1, "setup check - act 2 must append exactly one ledger event");

    // The moments are read back from the primary collections rather than
    // guessed. The trail reports observed timestamps and never invents one,
    // so a test that invented them would not be testing the same thing.
    const record = await models.ConsentRecord.findOne({ principalId }).lean();
    const signupAt = record.events[0].timestamp;
    const updateAt = record.events[5].timestamp;
    const stored = await models.TrailEntry.find({ principalId }).sort({ _id: 1 }).lean();
    assert.equal(stored.length, 3, "setup check - acts 3, 5 and 7 are the only stored rows");
    const [refusalAt, pickedUpAt, resolvedAt] = stored.map((row) => row.at);

    const trail = await getConsentTrail({ models, principalId });

    assert.deepEqual(
      trail.timeline,
      [
        { at: erasure.erasedAt, kind: "principal_erased", source: "derived", outcome: "recorded", actor: DERIVED },
        {
          at: resolvedAt, kind: "request_status_changed", source: "stored", outcome: "recorded",
          actor: { role: "operator", channel: "api" }, refId: grievance.refId,
          fromStatus: "escalated", toStatus: "resolved",
        },
        {
          at: escalation.escalatedAt, kind: "grievance_escalated", source: "derived",
          outcome: "recorded", actor: DERIVED, refId: grievance.refId,
        },
        {
          at: pickedUpAt, kind: "request_status_changed", source: "stored", outcome: "recorded",
          actor: { role: "operator", channel: "api" }, refId: grievance.refId,
          fromStatus: "open", toStatus: "in_progress",
        },
        {
          at: filed.createdAt, kind: "grievance_filed", source: "derived",
          outcome: "recorded", actor: DERIVED, refId: grievance.refId,
        },
        {
          at: refusalAt, kind: "withdrawal_not_applied", source: "stored", outcome: "refused",
          actor: { role: "principal", channel: "api" }, reasonCode: "not_withdrawable",
          // The receipt withdrawConsent handed the person for the call it
          // then refused - the row cites what they were given.
          receiptId: refusal.receiptId,
          consentTypes: ["kyc_reporting"], count: 1,
        },
        {
          at: updateAt, kind: "consent_granted", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: update.receiptId, consentTypes: ["underwriting"],
        },
        // The five decisions of one submission, at one millisecond, in
        // reverse array position - the tiebreak doing the only job it has.
        {
          at: signupAt, kind: "consent_denied", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: signup.receiptId, consentTypes: ["analytics"],
        },
        {
          at: signupAt, kind: "consent_granted", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: signup.receiptId, consentTypes: ["marketing"],
        },
        {
          at: signupAt, kind: "consent_denied", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: signup.receiptId, consentTypes: ["underwriting"],
        },
        {
          at: signupAt, kind: "consent_denied", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: signup.receiptId, consentTypes: ["identity_verification"],
        },
        {
          at: signupAt, kind: "consent_granted", source: "derived", outcome: "recorded",
          actor: DERIVED, receiptId: signup.receiptId, consentTypes: ["kyc_reporting"],
        },
      ],
      "the whole timeline, one shape for both sources, newest first - a consumer must never have to branch on where an entry came from"
    );

    assert.equal(trail.principalId, principalId);
    assert.equal(trail.docRef, record.docRef);
    assert.equal(trail.coverageFrom, COVERAGE_FROM, "a trail must be able to say when we started recording, or an empty one implies nothing happened");
    assert.equal(trail.totalEntries, 12, "twelve MERGED entries - a count of stored rows alone would have said three");
    assert.equal(trail.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// The same twelve acts, scanned (design section 10, cases 2 and 3): what the
// stored rows are allowed to contain, and what they must not contain after an
// erasure. A spot check against one hardcoded literal proves only that ONE
// address did not leak; these two walk everything that is actually there.
// ---------------------------------------------------------------------------

test("every string on every trail row matches a known-safe shape, and the scan is not vacuous", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await playTwelveActs(models);

    // Read off the schema rather than restated here, so the allow-list cannot
    // drift from the vocabulary the collection actually enforces.
    const kinds = models.TrailEntry.schema.path("kind").enumValues;
    const outcomes = models.TrailEntry.schema.path("outcome").enumValues;
    const reasonCodes = models.TrailEntry.schema.path("reasonCode").enumValues;
    const roles = models.TrailEntry.schema.path("actor").schema.path("role").enumValues;
    const channels = models.TrailEntry.schema.path("actor").schema.path("channel").enumValues;
    // fromStatus and toStatus are unenumerated on TrailEntry, because they
    // hold values belonging to three other schemas. Every one of those is a
    // closed enum this library controls, and none of them is caller text.
    const statuses = new Set([
      ...models.RightsRequest.schema.path("status").enumValues,
      ...models.Grievance.schema.path("status").enumValues,
      ...models.ConsentManagerRequest.schema.path("status").enumValues,
      // contact_corrected puts WHICH fields changed in toStatus, as one of
      // exactly these three - never the old or new value, nor a hash of one.
      "email", "phone", "email+phone",
    ]);
    const isOpaqueRef = (value) => {
      try {
        assertOpaqueRef(value, "value");
        return true;
      } catch {
        return false;
      }
    };

    // Named shapes rather than one combined regex, so a failure names the
    // string that is unaccounted for and a reviewer can read what is
    // permitted. The opaque reference is scoped to the only two fields that
    // may carry one: it is much the loosest shape here - assertOpaqueRef
    // bounds shape and not meaning - so admitting it at every path would let
    // this scan pass on almost anything.
    const shapes = [
      ["a 64-hex principalId", (v) => /^[a-f0-9]{64}$/.test(v)],
      ["a 24-hex ObjectId", (v) => /^[a-f0-9]{24}$/.test(v)],
      ["an ISO-8601 instant", (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)],
      ["a generated reference", (v) => /^(RC|RQ|GR|CM)-[0-9A-F]{16}$/.test(v)],
      ["a trail kind", (v) => kinds.includes(v)],
      ["an outcome", (v) => outcomes.includes(v)],
      ["a reason code", (v) => reasonCodes.includes(v)],
      ["an actor role", (v) => roles.includes(v)],
      ["an actor channel", (v) => channels.includes(v)],
      ["a request status", (v) => statuses.has(v)],
      ["a catalog consent type", (v) => getValidConsentTypes().includes(v)],
      ["an opaque operator reference", (v, path) => /(^|\.)(ref|caseRef)$/.test(path) && isOpaqueRef(v)],
    ];

    // The JSON rendering rather than the lean documents themselves: it turns
    // each ObjectId into its hex string and each Date into an ISO string,
    // which is the form anything downstream sees, and leaves a tree of plain
    // values to walk.
    const rows = JSON.parse(JSON.stringify(await models.TrailEntry.find({}).lean()));
    const seen = [];
    const walk = (value, path) => {
      if (typeof value === "string") return void seen.push([path, value]);
      if (Array.isArray(value)) return void value.forEach((item, i) => walk(item, `${path}[${i}]`));
      if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
      }
    };
    walk(rows, "$");

    for (const [path, value] of seen) {
      assert.ok(
        shapes.some(([, matches]) => matches(value, path)),
        `unaccounted-for string at ${path}: ${JSON.stringify(value)} - this collection survives erasure, so every string on it must be a value this library generated or an enum it controls`
      );
    }

    // The non-vacuity inverse. A walker that descended into nothing, or an
    // empty collection, satisfies the loop above by finding no strings at all
    // - which is exactly the way a property scan silently stops testing.
    assert.ok(seen.length > 0, "the scan must actually have walked strings, or it proves nothing");
    const values = seen.map(([, value]) => value);
    assert.ok(values.includes(principalId), "it reached leaf values, not just the top level of each document");
    assert.ok(
      values.includes("withdrawal_not_applied") && values.includes("request_status_changed"),
      "and it covered all three rows the twelve acts produced"
    );
  });
});

test("after erasure the trail keeps every row and holds neither contact hash - pseudonymous evidence, not a second index of the person", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await playTwelveActs(models);

    const principal = await models.Principal.findOne({ principalId }).lean();
    assert.ok(principal.erasedAt, "setup check - the twelve acts end in an erasure");
    assert.equal(principal.emailHash, undefined, "setup check - erasure destroyed the very hashes this test scans for");

    assert.notEqual(
      await models.TrailEntry.countDocuments({}),
      0,
      "the trail survives erasure - a collection emptied by it would satisfy the two assertions below while proving nothing"
    );

    // EVERY collection, not just the trail. The spec's wording is "appears in
    // zero documents anywhere in the database", and scoping the scan to
    // TrailEntry would let a future task reintroduce the hash on some other
    // record and still pass. Iterating the registry also means a model added
    // later is covered the day it is registered, with no edit here.
    for (const [name, Model] of Object.entries(models)) {
      const rendered = JSON.stringify(await Model.find({}).lean());
      assert.equal(
        rendered.includes(lookupHash(PII.email)),
        false,
        `the email lookup hash appears in ZERO ${name} documents - a record carrying both it and a principalId would rebuild the contact-to-person index that erasure exists to destroy`
      );
      assert.equal(
        rendered.includes(lookupHash(PII.phone)),
        false,
        `and neither does the phone hash, in ${name} - the trail schema has no contact-hash field at all, and this is what keeps that true end to end`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The partition rule (design section 4), as an executable property
// ---------------------------------------------------------------------------

test("a principal with no stored entries still gets their derived ledger - an empty trailentries collection is not an empty trail", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId, receiptId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    assert.equal(await models.TrailEntry.countDocuments({}), 0, "setup check - nothing has written a stored row");

    const trail = await getConsentTrail({ models, principalId });
    assert.equal(trail.totalEntries, 5, "five catalog decisions, every one of them derived from the ledger");
    assert.ok(trail.timeline.every((e) => e.source === "derived"));
    assert.ok(trail.timeline.every((e) => e.receiptId === receiptId), "each derived consent entry carries the receipt of the submission that wrote it");
    assert.deepEqual(
      trail.timeline.map((e) => e.consentTypes[0]),
      ["analytics", "marketing", "underwriting", "identity_verification", "kyc_reporting"],
      "one submission, one timestamp - so the order is array position descending"
    );
    assert.equal(trail.coverageFrom, COVERAGE_FROM);
  });
});

test("a successful withdrawal appears once, derived - the partition rule makes double-reporting impossible by construction", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await tick();
    const result = await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });
    assert.deepEqual(result.withdrawn, ["marketing"], "setup check - the withdrawal must actually have taken effect");

    const trail = await getConsentTrail({ models, principalId });
    const withdrawals = trail.timeline.filter((e) => e.kind === "consent_withdrawn");
    assert.equal(withdrawals.length, 1, "the ledger observed it, so it is derived and never also stored - this is what deletes the 120-line dedup pass an earlier design needed");
    assert.equal(withdrawals[0].source, "derived");
    assert.deepEqual(withdrawals[0].consentTypes, ["marketing"]);
    assert.equal(trail.totalEntries, 6, "five signup decisions plus one withdrawal, not seven");
  });
});

test("a rights request and a consent-manager request appear on the filer's own trail, each at the moment its own collection observed", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await tick();
    const right = await exerciseRight({
      models, principalId, right: "correction", details: "My address is out of date",
    });
    await tick();
    const cm = await consentManagerRequest({
      models, principalId, message: "Please connect me to a Consent Manager",
    });

    const trail = await getConsentTrail({ models, principalId });
    const filed = trail.timeline.find((e) => e.kind === "rights_request_filed");
    const asked = trail.timeline.find((e) => e.kind === "consent_manager_requested");
    assert.ok(
      filed && asked,
      "both derived kinds must appear - these are the only two branches of the read that nothing else exercises, so a typo in either kind string ships undetected"
    );

    const rightsRow = await models.RightsRequest.findOne({ refId: right.refId }).lean();
    const cmRow = await models.ConsentManagerRequest.findOne({ refId: cm.refId }).lean();

    assert.equal(filed.source, "derived");
    assert.equal(filed.outcome, "recorded");
    assert.deepEqual(filed.actor, DERIVED);
    assert.equal(filed.refId, right.refId, "the entry cites the reference the person holds, so they can match it to their own request");
    assert.deepEqual(filed.at, rightsRow.createdAt, "createdAt, not updatedAt - the entry reports when it was FILED, and a later status change must not move it");

    assert.equal(asked.source, "derived");
    assert.equal(asked.outcome, "recorded");
    assert.deepEqual(asked.actor, DERIVED);
    assert.equal(asked.refId, cm.refId);
    assert.deepEqual(asked.at, cmRow.createdAt);

    assert.equal(
      await models.TrailEntry.countDocuments({}),
      0,
      "neither act stores a row - both are read straight off the collection that already observed them, which is the partition rule again"
    );
    assert.equal(trail.totalEntries, 7, "five signup decisions plus the two filings");
    assert.equal(trail.timeline[0].kind, "consent_manager_requested", "newest first, and that request is the most recent act");
    assert.doesNotMatch(
      JSON.stringify(trail),
      /My address is out of date/,
      "the derived entry projects the reference and nothing else - the free text a person typed stays in the collection they typed it into"
    );
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("at one identical instant a stored entry sorts ahead of every derived one, and ledger events fall in reverse array position", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const record = await models.ConsentRecord.findOne({ principalId }).lean();
    const at = record.events[0].timestamp;

    // Created directly rather than through recordTrail: this row needs the
    // LEDGER's exact millisecond, and recordTrail deliberately stamps its own.
    await models.TrailEntry.create({
      principalId,
      at,
      kind: "consent_refused",
      outcome: "refused",
      reasonCode: "prohibited_for_child",
      actor: { role: "principal", channel: "html" },
      consentTypes: ["analytics"],
      count: 1,
    });

    const trail = await getConsentTrail({ models, principalId });
    assert.ok(
      trail.timeline.every((e) => e.at.getTime() === at.getTime()),
      "setup check - all six entries really do share one millisecond, or this test proves nothing"
    );
    assert.deepEqual(
      trail.timeline.map((e) => `${e.source}:${e.kind}:${e.consentTypes[0]}`),
      [
        "stored:consent_refused:analytics",
        "derived:consent_denied:analytics",
        "derived:consent_granted:marketing",
        "derived:consent_denied:underwriting",
        "derived:consent_denied:identity_verification",
        "derived:consent_granted:kyc_reporting",
      ],
      "consentEventSchema is {_id:false}, so ledger events have no id to fall back on - without the tiebreak this order is whatever the sort happened to do"
    );
  });
});

// ---------------------------------------------------------------------------
// Bounding: limit, truncated and totalEntries count MERGED entries
// ---------------------------------------------------------------------------

test("limit, truncated and totalEntries count merged entries, not stored rows", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await tick();
    await recordTrail(models, {
      principalId, kind: "consent_refused", outcome: "refused",
      reasonCode: "record_erased", actor: PRINCIPAL_API,
    });

    const full = await getConsentTrail({ models, principalId });
    assert.equal(full.totalEntries, 6);
    assert.equal(full.truncated, false);

    const cut = await getConsentTrail({ models, principalId, limit: 2 });
    assert.equal(cut.timeline.length, 2);
    assert.equal(cut.totalEntries, 6, "totalEntries is the full merged count, so a cut caller knows by how much they were cut");
    assert.equal(cut.truncated, true, "truncated says plainly that the caller has not seen everything");
    assert.equal(cut.timeline[0].kind, "consent_refused", "a cut keeps the NEWEST entries - the oldest are the ones a caller can afford to lose");
    assert.equal(cut.timeline[0].source, "stored", "one stored row against five derived - a limit applied per source would have returned six");

    await assert.rejects(
      () => getConsentTrail({ models, principalId, limit: "2" }),
      (err) => err.status === 400,
      "limit is caller-supplied, so it is bounded by shape like every other input here"
    );
    await assert.rejects(
      () => getConsentTrail({ models, principalId, limit: 0 }),
      (err) => err.status === 400
    );
  });
});

// ---------------------------------------------------------------------------
// Erasure, and the operator-reference gate (design sections 8.5 and 9)
// ---------------------------------------------------------------------------

test("an erased principal still has a trail, and it names the erasure", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await tick();
    await recordTrail(models, {
      principalId, kind: "contact_corrected", outcome: "recorded", actor: PRINCIPAL_API,
    });
    await tick();
    const { erasedAt } = await erasePrincipalPII({ models, principalId });

    const trail = await getConsentTrail({ models, principalId });
    assert.equal(trail.timeline[0].kind, "principal_erased");
    assert.deepEqual(
      trail.timeline[0].at,
      erasedAt,
      "derived from Principal.erasedAt - erasePrincipalPII writes nothing to the trail and edits nothing in it"
    );
    assert.equal(trail.totalEntries, 7, "the trail survives erasure as pseudonymous evidence, exactly as the consent ledger does");
    assert.ok(trail.timeline.some((e) => e.kind === "contact_corrected"), "the stored half survives too");

    const rendered = JSON.stringify(trail);
    assert.doesNotMatch(rendered, /asha@example\.com/i, "no contact detail reaches the trail, before erasure or after");
    assert.doesNotMatch(rendered, /Asha/, "and no name either");
  });
});

test("includeOperatorRefs withholds actor.ref and caseRef from the data principal and gives them to the back office", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await tick();
    await recordTrail(models, {
      principalId, kind: "operator_trail_read", outcome: "recorded",
      actor: OPERATOR, caseRef: "INC-0042199",
    });

    const mine = await getConsentTrail({ models, principalId });
    const seen = mine.timeline[0];
    assert.equal(
      seen.kind,
      "operator_trail_read",
      "a data principal exercising Section 11 sees THAT someone read their record - this is the headline of the feature, not the back office"
    );
    assert.deepEqual(seen.actor, { role: "operator", channel: "api" });
    assert.equal(Object.hasOwn(seen.actor, "ref"), false, "WHICH operator is the adopter's own staff member's personal data, and not this principal's business");
    assert.equal(Object.hasOwn(seen, "caseRef"), false, "the ticket reference is never rendered back to a data principal");

    const backOffice = await getConsentTrail({ models, principalId, includeOperatorRefs: true });
    assert.deepEqual(backOffice.timeline[0].actor, { role: "operator", ref: "emp-10432", channel: "api" });
    assert.equal(
      backOffice.timeline[0].caseRef,
      "INC-0042199",
      "who and why together is what makes the access record accountability rather than a counter"
    );
  });
});

// ---------------------------------------------------------------------------
// Scoping and injection
// ---------------------------------------------------------------------------

test("an unknown principalId is 404 and an operator object is 400 - neither reaches a query filter", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    await assert.rejects(
      () => getConsentTrail({ models, principalId: "f".repeat(64) }),
      (err) => err.status === 404,
      "the same 404 whether the id belongs to nobody or to somebody else - a 403 would confirm the record exists"
    );
    for (const hostile of [{ $ne: null }, { $gt: "" }, { $regex: "." }]) {
      await assert.rejects(
        () => getConsentTrail({ models, principalId: hostile }),
        (err) => err.status === 400,
        "mongoose does not strip query operators during casting, so the shape check is the actual control"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The unmounted lookup by contact detail (design section 8.3)
// ---------------------------------------------------------------------------

test("findConsentTrailByContact resolves an email to a whole trail, and answers null rather than throwing when nobody holds it", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const record = await models.ConsentRecord.findOne({ principalId }).lean();

    const trail = await findConsentTrailByContact({ models, email: "  ASHA@example.com " });
    assert.equal(trail.principalId, principalId, "lookupHash normalises case and surrounding whitespace, so a hand-typed address still matches");
    assert.equal(trail.docRef, record.docRef);
    assert.equal(trail.coverageFrom, COVERAGE_FROM);
    assert.equal(trail.totalEntries, 5, "the same object getConsentTrail returns - this function resolves an identity, it does not shape a different read");

    assert.equal(
      await findConsentTrailByContact({ models, email: "nobody@example.com" }),
      null,
      "null, not a 404 - a library caller asking whether an address is one of ours gets an answer, not an exception"
    );
    assert.equal(await findConsentTrailByContact({ models }), null, "no contact detail at all is a miss, not an error");
  });
});

test("findConsentTrailByContact keeps the 409 on an ambiguous phone - a household handset is not an identity", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const shared = "9876500000";
    await persistPIIwithconsent({ models, pii: { ...PII, phone: shared }, consentTypes: ["marketing"] });
    await persistPIIwithconsent({ models, pii: { ...BHIM, phone: shared }, consentTypes: ["marketing"] });

    await assert.rejects(
      () => findConsentTrailByContact({ models, phone: shared }),
      (err) => err.status === 409,
      "findPrincipalByContact refuses to guess which household member a number belongs to, and answering with an arbitrary one of their trails would disclose the wrong person's whole lineage"
    );
  });
});
