const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
const { buildNotice, SUPPORTED_NOTICE_LANGUAGES } = require("../src/config/notice");
const { getCatalog } = require("../src/config/catalog");
const { buildModels } = require("../src/models");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const withdrawConsent = require("../src/services/withdrawConsent");
const { exerciseRight } = require("../src/services/dataPrincipalRights");
const createRouter = require("../src/http/router");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };

/** Boots an app and returns a fetch helper, matching test/auth.test.js. */
async function app(conn, opts = {}) {
  const a = express();
  a.use("/dpdp", createRouter({ db: conn, ...opts }));
  const server = a.listen(0);
  const port = server.address().port;
  return {
    call: (method, path, body, headers = {}) =>
      fetch(`http://localhost:${port}/dpdp${path}`, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test("the notice itemises every purpose with its lawful basis and retention", () => {
  const notice = buildNotice({ language: "en" });
  assert.ok(notice.purposes.length >= 4);
  for (const p of notice.purposes) {
    assert.ok(p.title && p.purpose, "each purpose needs a plain-language description");
    assert.ok(p.lawfulBasis.kind);
    assert.ok(Number.isInteger(p.retentionMonths));
  }
  assert.ok(notice.dpo.email, "the notice must carry the DPO contact");
  assert.ok(notice.rights.length >= 4, "the notice must tell the principal how to exercise their rights");
  assert.ok(notice.rights.some((r) => r.key === "withdrawal"),
    "Section 6(4) is a right too, and the notice's rights array must actually enumerate it");
  assert.ok(notice.version, "a notice snapshot needs a version to be evidence");
  // Section 5(1) and the DPDP Rules, 2025 items the first draft omitted.
  assert.ok(notice.personalData.length > 0, "the Rules require an itemised description of the personal data");
  assert.ok(notice.withdrawal && notice.withdrawal.description, "the Rules require the means of withdrawing consent");
  assert.ok(notice.boardComplaint && notice.boardComplaint.description,
    "Section 5(1) requires the manner of complaining to the Board");
});

test("the notice declares its language and rejects an unsupported one", () => {
  assert.equal(buildNotice({ language: "en" }).language, "en");
  assert.ok(SUPPORTED_NOTICE_LANGUAGES.includes("en"));
  assert.throws(() => buildNotice({ language: "kl" }), /language/i);
});

test("the version is content-addressed: stable when the catalog is unchanged, and changes when it is", () => {
  const first = buildNotice({ language: "en" });
  const second = buildNotice({ language: "en" });
  assert.equal(first.version, second.version, "an unchanged catalog must reproduce the same version");

  getCatalog().push({
    type: "temp_purpose_for_test",
    title: "Temporary purpose",
    purpose: "Exists only to prove the version moves when the catalog does.",
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true,
    prohibitedForChildren: false,
    retentionMonths: 12,
  });
  try {
    const third = buildNotice({ language: "en" });
    assert.notEqual(third.version, first.version, "any change to what we tell people must yield a new version");
  } finally {
    getCatalog().pop();
  }
});

test("the notice shown at consent time is stored with the record", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const notice = buildNotice({ language: "en" });
    const r = await persistPIIwithconsent({
      models,
      pii: { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" },
      consentTypes: ["marketing"],
      notice,
    });
    const record = await models.ConsentRecord.findOne({ principalId: r.principalId });
    assert.equal(record.lastNotice.version, notice.version,
      "without the notice the fiduciary cannot show what the principal was told");
    assert.equal(record.lastNotice.language, "en");
  });
});

// ---------------------------------------------------------------------------
// H3 is only closed if the HTTP path snapshots a notice too - the only test
// exercising persistPIIwithconsent's notice parameter above calls the service
// directly, which every real deployment's consent capture does not.
// ---------------------------------------------------------------------------

test("POST /consent stores a notice snapshot without the caller ever passing one", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { call, close } = await app(conn);
    try {
      const res = await call("POST", "/consent", { pii: PII, consentTypes: ["marketing"] });
      assert.equal(res.status, 201);
      const { principalId } = await res.json();
      const record = await models.ConsentRecord.findOne({ principalId });
      assert.ok(record.lastNotice, "the router must build and pass a notice - a service caller never supplied one");
      assert.ok(record.lastNotice.version, "the stored snapshot needs a version to be evidence");
      assert.equal(record.lastNotice.language, "en");
    } finally {
      await close();
    }
  });
});

test("PUT /consent refreshes the notice snapshot on an authenticated update", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { call, close } = await app(conn);
    let principalId;
    try {
      const signup = await call("POST", "/consent", { pii: PII, consentTypes: ["marketing"] });
      ({ principalId } = await signup.json());
    } finally {
      await close();
    }

    const { call: asAsha, close: closeAsha } = await app(conn, { resolvePrincipal: () => principalId });
    try {
      const res = await asAsha("PUT", "/consent", { consentTypes: ["marketing", "analytics"] });
      assert.equal(res.status, 200);
      const record = await models.ConsentRecord.findOne({ principalId });
      assert.ok(record.lastNotice.version, "the update path must snapshot a notice too");
    } finally {
      await closeAsha();
    }
  });
});

test("an unsupported ?lang= on POST /consent is a 400 naming the supported languages, not a 500", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { call, close } = await app(conn);
    try {
      // ?lang= reaches buildNotice unauthenticated - an unsupported code must
      // not surface as a 500, and must not write anything either.
      const res = await call("POST", "/consent?lang=kl", { pii: PII, consentTypes: [] });
      assert.equal(res.status, 400, "an unsupported language is the caller's own bad input, not an internal fault");
      const body = await res.json();
      assert.match(body.error, /language/i);
      assert.equal(await models.Principal.countDocuments({}), 0, "a rejected language must write nothing");
      assert.equal(await models.ConsentRecord.countDocuments({}), 0);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// L6 - the DPO contact on rights and withdrawal responses.
// ---------------------------------------------------------------------------

test("exerciseRight carries the DPO contact", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: [] });
    const result = await exerciseRight({ models, principalId, right: "access" });
    assert.equal(result.contact.dpoEmail, "dpo@test.example");
    assert.ok(result.contact.dpoName);
  });
});

test("withdrawConsent carries the DPO contact", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const result = await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });
    assert.equal(result.contact.dpoEmail, "dpo@test.example");
    assert.ok(result.contact.dpoName);
  });
});
