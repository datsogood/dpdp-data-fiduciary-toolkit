const test = require("node:test");
const assert = require("node:assert/strict");
const { getCatalog, getValidConsentTypes, getWithdrawableTypes, RIGHTS_CATALOG } = require("../src/config/catalog");

// The real Section 7 sub-clauses, verified against the statute text. A
// legitimate use must cite one of these exactly. A prefix check like
// /^Section 7/ would bless "Section 7(b)" for a private lender's KYC, which is
// the State subsidy clause - so pin the enumeration instead.
const ALLOWED_S7_CLAUSES = [
  "Section 7(a)", "Section 7(b)", "Section 7(c)", "Section 7(d)", "Section 7(e)",
  "Section 7(f)", "Section 7(g)", "Section 7(h)", "Section 7(i)",
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
