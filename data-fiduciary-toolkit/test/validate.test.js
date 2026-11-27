const test = require("node:test");
const assert = require("node:assert/strict");
const { assertPrincipalId, assertNonEmptyString, assertStringArray, assertOpaqueRef } = require("../src/utils/validate");

test("assertPrincipalId accepts a 64-char lowercase hex string", () => {
  const id = "a".repeat(64);
  assert.equal(assertPrincipalId(id, "principalId"), id);
});

test("assertPrincipalId rejects every NoSQL operator shape", () => {
  for (const bad of [{ $ne: null }, { $gt: "" }, { $regex: ".*" }, { $in: ["a"] }, [], 42, null, undefined, "short"]) {
    assert.throws(
      () => assertPrincipalId(bad, "principalId"),
      (err) => err.status === 400,
      `expected rejection for ${JSON.stringify(bad)}`
    );
  }
});

test("assertNonEmptyString enforces the max length", () => {
  assert.equal(assertNonEmptyString("hi", "subject", 10), "hi");
  assert.throws(() => assertNonEmptyString("x".repeat(11), "subject", 10), (e) => e.status === 400);
  assert.throws(() => assertNonEmptyString("   ", "subject", 10), (e) => e.status === 400);
  assert.throws(() => assertNonEmptyString({ $ne: "" }, "subject", 10), (e) => e.status === 400);
});

test("assertStringArray rejects non-arrays and non-string members", () => {
  assert.deepEqual(assertStringArray(["a", "b"], "consentTypes"), ["a", "b"]);
  assert.deepEqual(assertStringArray(undefined, "consentTypes"), []);
  assert.throws(() => assertStringArray("a", "consentTypes"), (e) => e.status === 400);
  assert.throws(() => assertStringArray([{ $ne: "" }], "consentTypes"), (e) => e.status === 400);
});

test("assertOpaqueRef accepts the staff and ticket references a host actually holds", () => {
  const good = [
    "emp-10432", // a staff id
    "3f2504e0-4f89-11d3-9a0c-0305e82c3301", // a UUID
    "asha.nair", // an LDAP uid
    "INC-0042199", // a ticket reference
    "SUPPORT:2026-0912", // a namespaced ticket reference
    "a".repeat(64), // the longest value the shape allows
  ];
  for (const value of good) {
    assert.equal(assertOpaqueRef(value, "actorRef"), value, `expected ${value} to be accepted`);
  }
});

test("assertOpaqueRef refuses contact details and free text - it is a positive shape, not a blocklist", () => {
  const bad = [
    "asha@example.com", // an email
    "+919876543210", // a phone number
    "+91 98765-43210", // a phone number with punctuation
    "asha nair", // a space, and therefore any sentence
    "", // empty
    "   ", // whitespace only
    "a".repeat(65), // one character over the 64-character ceiling
    "-leading", // the first character must be alphanumeric
    42,
    null,
    undefined,
    { $ne: null }, // an operator object, per this file's existing discipline
  ];
  for (const value of bad) {
    assert.throws(
      () => assertOpaqueRef(value, "actorRef"),
      (err) => err.status === 400,
      `expected rejection for ${JSON.stringify(value)}`
    );
  }
});
