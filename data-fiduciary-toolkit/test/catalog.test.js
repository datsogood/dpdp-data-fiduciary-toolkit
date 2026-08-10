const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

// Set before requiring the catalog: FIDUCIARY is captured at module load, and
// assertConfigured checks the DPO address before it reaches the two settings
// the tests at the bottom of this file are about.
process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
const { getCatalog, getValidConsentTypes, getWithdrawableTypes, RIGHTS_CATALOG, assertConfigured } =
  require("../src/config/catalog");

// The real Section 7 sub-clauses, verified against the statute text. A
// legitimate use must cite one of these exactly. A prefix check like
// /^Section 7/ would bless "Section 7(b)" for a private lender's KYC, which is
// the State subsidy clause - so pin the enumeration instead.
const ALLOWED_S7_CLAUSES = [
  "Section 7(a)", "Section 7(b)", "Section 7(c)", "Section 7(d)", "Section 7(e)",
  "Section 7(f)", "Section 7(g)", "Section 7(h)", "Section 7(i)",
];

// Clauses a PRIVATE data fiduciary can actually rely on. Checked verbatim
// against the statute text (two independent sources, same wording): 7(b) and
// 7(c) are the only two sub-clauses that explicitly restrict the use to "the
// State and/or its instrumentalities" - every other sub-clause is phrased
// generically ("for taking measures to...", "for responding to...", "for
// compliance with...") with no State-only language, so a private fiduciary
// can invoke it. That includes 7(g) (public health measures during an
// epidemic) and 7(h) (safety/assistance during a disaster or breakdown of
// public order) - neither one is gated to government actors in the text, so
// a private hospital or a private disaster-relief operator can rely on them
// just as a private lender can rely on 7(d). Excluding them without a
// textual basis would repeat the same class of error this task exists to
// correct, just in the other direction - treating a private-capable clause
// as State-only instead of a State-only clause as private-capable.
const PRIVATE_FIDUCIARY_S7_CLAUSES = [
  "Section 7(a)", "Section 7(d)", "Section 7(e)", "Section 7(f)",
  "Section 7(g)", "Section 7(h)", "Section 7(i)",
];

test("no purpose claims contractual necessity as a lawful basis", () => {
  for (const entry of getCatalog()) {
    assert.doesNotMatch(
      entry.lawfulBasis.description,
      /contract/i,
      `${entry.type}: the Act has no contractual-necessity ground - use consent or a cited legitimate use`
    );
    assert.ok(["consent", "legitimate_use"].includes(entry.lawfulBasis.kind));
    if (entry.lawfulBasis.kind === "legitimate_use") {
      assert.ok(
        ALLOWED_S7_CLAUSES.includes(entry.lawfulBasis.clause),
        `${entry.type}: "${entry.lawfulBasis.clause}" is not a real Section 7 sub-clause`
      );
    }
  }
});

test("no legitimate use claims a general compliance-with-legal-obligation ground", () => {
  // Section 7 contains no such ground for a private fiduciary. 7(d) is confined
  // to disclosure obligations owed to the State, so a description asserting a
  // broad legal-obligation basis is a misstatement of the Act.
  for (const entry of getCatalog()) {
    if (entry.lawfulBasis.kind !== "legitimate_use") continue;
    assert.doesNotMatch(
      entry.lawfulBasis.description,
      /compliance with a legal obligation/i,
      `${entry.type}: no such ground exists - cite what the clause actually authorises`
    );
  }
});

test("underwriting is consent-based and therefore withdrawable", () => {
  const u = getCatalog().find((e) => e.type === "underwriting");
  assert.equal(u.lawfulBasis.kind, "consent");
  assert.equal(u.withdrawable, true);
  assert.ok(getWithdrawableTypes().includes("underwriting"));
});

test("the PMLA reporting duty rests on 7(d) and is not withdrawable", () => {
  const k = getCatalog().find((e) => e.type === "kyc_reporting");
  assert.equal(k.lawfulBasis.kind, "legitimate_use");
  assert.equal(k.lawfulBasis.clause, "Section 7(d)");
  assert.equal(k.withdrawable, false);
});

test("identity verification beyond the disclosure duty is consent-based and withdrawable", () => {
  // The 7(d) cover extends only to disclosing information to the State. Our own
  // verification and record-keeping is wider, so it needs consent.
  const v = getCatalog().find((e) => e.type === "identity_verification");
  assert.equal(v.lawfulBasis.kind, "consent");
  assert.equal(v.withdrawable, true);
});

test("the derived lists reflect catalog changes made after import", () => {
  const before = getValidConsentTypes().length;
  getCatalog().push({
    type: "research", title: "Impact research", purpose: "Programme evaluation",
    lawfulBasis: { kind: "consent", clause: "Section 6", description: "Your consent" },
    withdrawable: true, retentionMonths: 12,
  });
  assert.equal(getValidConsentTypes().length, before + 1, "derived lists must not be import-time snapshots");
  assert.ok(getValidConsentTypes().includes("research"));
  getCatalog().pop();
});

test("the erasure right is not described with a precondition the Act does not impose", () => {
  const erasure = RIGHTS_CATALOG.find((r) => r.key === "erasure");
  assert.doesNotMatch(
    erasure.description,
    /no longer needed/i,
    "the principal's request is the trigger; retention necessity is the fiduciary's exception to argue"
  );
});

test("a legitimate use cites a clause a private fiduciary can actually rely on", () => {
  // ALLOWED_S7_CLAUSES only catches an invented letter - it accepts 7(b) and
  // 7(c) too, which are real clauses but State-side ones, so it would not
  // have caught kyc_reporting being reverted to 7(b). This is the stronger
  // check: it fails for a real-but-inapplicable clause, not just a fake one.
  for (const entry of getCatalog()) {
    if (entry.lawfulBasis.kind !== "legitimate_use") continue;
    assert.ok(
      PRIVATE_FIDUCIARY_S7_CLAUSES.includes(entry.lawfulBasis.clause),
      `${entry.type}: "${entry.lawfulBasis.clause}" is a real clause but not one a private ` +
        `fiduciary can rely on - 7(b) and 7(c) are State-side grounds`
    );
  }
});

test("withdrawable is consistent with the basis kind for EVERY entry", () => {
  for (const entry of getCatalog()) {
    assert.equal(
      entry.withdrawable,
      entry.lawfulBasis.kind === "consent",
      `${entry.type}: withdrawable must be true exactly when the basis is consent, got ` +
        `withdrawable=${entry.withdrawable} for kind=${entry.lawfulBasis.kind}`
    );
  }
});

test("every entry declares prohibitedForChildren explicitly", () => {
  for (const entry of getCatalog()) {
    assert.equal(
      typeof entry.prohibitedForChildren,
      "boolean",
      `${entry.type}: prohibitedForChildren must be an explicit boolean`
    );
  }
});

// ---------------------------------------------------------------------------
// assertConfigured - the boot gate. createRouter calls it before building any
// route, so anything it misses becomes a failure in front of a data principal
// instead of a failure at startup.
// ---------------------------------------------------------------------------

test("a correctly configured deployment boots", () => {
  // Non-vacuity guard for the two tests below: if this ever throws, they are
  // passing on the wrong error and prove nothing about what they name.
  assertConfigured();
});

test("assertConfigured refuses to boot without a strong PRINCIPAL_ID_SECRET", () => {
  // .env.example ships this EMPTY and the README says to copy that file, and
  // assertConfigured checked the DPO address and both SLA integers but not
  // this. With it unset the router built, health checks passed and GET
  // /consent/new rendered - and the FIRST POST /consent returned a 500.
  const saved = process.env.PRINCIPAL_ID_SECRET;
  try {
    delete process.env.PRINCIPAL_ID_SECRET;
    assert.throws(() => assertConfigured(), /PRINCIPAL_ID_SECRET/,
      "an unset secret must fail at boot, like the DPO address does");

    process.env.PRINCIPAL_ID_SECRET = "";
    assert.throws(() => assertConfigured(), /PRINCIPAL_ID_SECRET/, "empty is what .env.example actually ships");

    process.env.PRINCIPAL_ID_SECRET = "   ";
    assert.throws(() => assertConfigured(), /PRINCIPAL_ID_SECRET/);

    // The floor has to match utils/principalId.js's own secret(), or a
    // deployment boots and then throws 500 on the first request anyway.
    process.env.PRINCIPAL_ID_SECRET = "a".repeat(31);
    assert.throws(() => assertConfigured(), /32/, "31 characters is below the floor lookupHash itself enforces");

    process.env.PRINCIPAL_ID_SECRET = "a".repeat(32);
    assertConfigured();
  } finally {
    process.env.PRINCIPAL_ID_SECRET = saved;
  }
});

// NOTICE_LANGUAGES is read once at module load, so this has to be a
// subprocess - the same technique test/children.test.js uses for TZ.
function bootWith(env) {
  const probe = `
    process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
    process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
    const { assertConfigured } = require("./src/config/catalog");
    try {
      assertConfigured();
      console.log("BOOTED");
    } catch (e) {
      console.log("REFUSED: " + e.message);
    }
  `;
  return execFileSync(process.execPath, ["-e", probe], {
    env: { ...process.env, ...env },
    cwd: process.cwd(),
    encoding: "utf-8",
  });
}

test("assertConfigured refuses to boot with a notice language that has no catalog", () => {
  // buildNotice validates the language and stamps it onto the body while every
  // string still comes from the single English catalog, so NOTICE_LANGUAGES=en,hi
  // with lang=hi produced an ENGLISH notice labelled hi, under its own content
  // hash, cited by every consent event written under it - affirmative false
  // evidence of Section 5(3) compliance on an append-only ledger.
  const refused = bootWith({ NOTICE_LANGUAGES: "en,hi" });
  assert.match(refused, /REFUSED/, "a language with no translated catalog must not boot");
  assert.match(refused, /hi/, "the error must name the offending language");
  assert.match(refused, /Section 5\(3\)/, "and say what the harm is, not just that it was refused");

  // Not merely "anything but exactly en" - a deployment naming only an
  // Eighth Schedule language must be refused just as firmly as a mixed list.
  assert.match(bootWith({ NOTICE_LANGUAGES: "hi" }), /REFUSED/);

  // A stray comma or blank value resolves SUPPORTED_NOTICE_LANGUAGES to [],
  // which `filter((lang) => lang !== "en")` never catches - an empty list has
  // nothing not-"en" to filter out, so it booted clean. DEFAULT_NOTICE_LANGUAGE
  // is then undefined, and buildNotice throws "Unsupported notice language:
  // undefined" on the first GET /consent/new or POST /consent - boot-clean,
  // 400-in-front-of-a-principal, the exact failure class this function exists
  // to close at boot instead.
  assert.match(bootWith({ NOTICE_LANGUAGES: "," }), /REFUSED/, "an empty list must not boot");
  assert.match(bootWith({ NOTICE_LANGUAGES: " " }), /REFUSED/, "a blank list must not boot");

  // And the supported configuration must still boot, or this test is only
  // asserting that assertConfigured throws.
  assert.match(bootWith({ NOTICE_LANGUAGES: "en" }), /BOOTED/);
});
