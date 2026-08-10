const test = require("node:test");
const assert = require("node:assert/strict");
const { assertPrincipalId, assertNonEmptyString, assertStringArray } = require("../src/utils/validate");

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
