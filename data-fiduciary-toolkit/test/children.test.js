const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-32chars";
const { buildModels } = require("../src/models");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const { ageInYears } = require("../src/utils/age");

const ADULT_DOB = "1990-04-01";
function minorDob() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 14);
  return d.toISOString().slice(0, 10);
}

// asOf is constructed from local year/month/day components (new Date(y, m, d)),
// never from an ISO date-only string (new Date("2026-08-06")). An ISO string is
// parsed as UTC midnight, and ageInYears reads asOf with LOCAL getters (see
// src/utils/age.js for why) - so an ISO-string asOf would silently shift a day
// in any timezone behind UTC, and this test would report the wrong thing about
// itself in exactly the way it exists to catch.
test("ageInYears handles the birthday boundary", () => {
  assert.equal(ageInYears("2008-08-07", new Date(2026, 7, 6)), 17);
  assert.equal(ageInYears("2008-08-07", new Date(2026, 7, 7)), 18);
});

// 2008 was a leap year; 2026 is not, so the day 29 February never occurs in
// the comparison year. The arithmetic must still land on the right side of
// the boundary the day before and the day of the recognised birthday, and an
// exact leap-year-to-leap-year match must not be off by one either.
test("ageInYears handles a leap-year (29 February) birthday", () => {
  assert.equal(ageInYears("2008-02-29", new Date(2026, 1, 28)), 17,
    "the day before the recognised birthday must still read 17");
  assert.equal(ageInYears("2008-02-29", new Date(2026, 2, 1)), 18,
    "2026 has no 29 February, so the birthday is recognised on 1 March");
  assert.equal(ageInYears("2008-02-29", new Date(2028, 1, 29)), 20,
    "an exact leap-year-to-leap-year match must land precisely, not off by one");
});

// Hand-verification across timezones caught a real bug that this machine's own
// timezone could not (see task-9-report.md, fix round 1). Spawn one subprocess
// per timezone with TZ set at process start, since Node resolves the timezone
// once at startup - a runtime assignment to process.env.TZ does not reliably
// take effect.
test("the age boundary holds in every timezone, not just the developer's", () => {
  const probe = `
    const { ageInYears } = require("./src/utils/age");
    const cases = [
      ["2008-08-08", new Date(2026, 7, 7, 23, 30), 17],
      ["2008-08-08", new Date(2026, 7, 8, 0, 30), 18],
      ["2008-08-07", new Date(2026, 7, 6), 17],
      ["2008-08-07", new Date(2026, 7, 7), 18],
      ["2008-02-29", new Date(2028, 1, 29), 20],
    ];
    const bad = cases.filter(([d, a, want]) => ageInYears(d, a) !== want);
    if (bad.length) { console.error(JSON.stringify(bad)); process.exit(1); }
  `;
  for (const tz of ["UTC", "America/New_York", "Asia/Calcutta", "Pacific/Kiritimati"]) {
    execFileSync(process.execPath, ["-e", probe], { env: { ...process.env, TZ: tz }, cwd: process.cwd() });
  }
});

test("date of birth is required - an age gate cannot work without it", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () => persistPIIwithconsent({ models, pii: { name: "A", email: "a@b.com", phone: "1" }, consentTypes: [] }),
      (e) => e.status === 400 && /dob/i.test(e.message)
    );
  });
});

test("a missing dob leaves nothing persisted - the gate runs before any write", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () => persistPIIwithconsent({ models, pii: { name: "A", email: "nodob@example.com", phone: "3" }, consentTypes: [] }),
      (e) => e.status === 400
    );
    assert.equal(await models.Principal.countDocuments(), 0, "a rejected submission must leave no Principal behind");
    assert.equal(await models.ConsentRecord.countDocuments(), 0, "a rejected submission must leave no ConsentRecord behind");
  });
});

test("a minor cannot be registered without verifiable parental consent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () => persistPIIwithconsent({
        models,
        pii: { name: "Child", email: "c@example.com", phone: "1", dob: minorDob() },
        consentTypes: [],
      }),
      (e) => e.status === 422 && /parental consent/i.test(e.message)
    );
  });
});

test("a rejected minor leaves nothing persisted - the gate runs before any write", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await assert.rejects(
      () => persistPIIwithconsent({
        models,
        pii: { name: "Child", email: "c2@example.com", phone: "2", dob: minorDob() },
        consentTypes: [],
      }),
      (e) => e.status === 422
    );
    assert.equal(await models.Principal.countDocuments(), 0, "a rejected minor must leave no Principal behind");
    assert.equal(await models.ConsentRecord.countDocuments(), 0, "a rejected minor must leave no ConsentRecord behind");
  });
});

test("tracking and advertising are refused for a minor even with parental consent", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const r = await persistPIIwithconsent({
      models,
      pii: { name: "Child", email: "c@example.com", phone: "1", dob: minorDob() },
      consentTypes: ["marketing", "analytics"],
      parentalConsent: { name: "Parent", email: "p@example.com", relationship: "mother", verifiedAt: new Date() },
    });
    assert.equal(r.state.marketing, undefined, "behavioural advertising to a child must never be recorded as granted");
    assert.equal(r.state.analytics, undefined);
    assert.ok(r.refusedForChild.includes("marketing"));
    assert.ok(r.refusedForChild.includes("analytics"));
    const principal = await models.Principal.findOne({ principalId: r.principalId });
    assert.equal(principal.isMinor, true);
    assert.equal(principal.parentalConsent.name, "Parent");
  });
});

test("an adult is unaffected", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const r = await persistPIIwithconsent({
      models, pii: { name: "Asha", email: "a@example.com", phone: "1", dob: ADULT_DOB }, consentTypes: ["marketing"],
    });
    assert.equal(r.state.marketing.status, "granted");
    assert.deepEqual(r.refusedForChild, []);
  });
});
