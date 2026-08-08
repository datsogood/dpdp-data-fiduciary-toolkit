const test = require("node:test");
const assert = require("node:assert/strict");
process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
const toolkit = require("../src/index");

test("the documented public API is all exported", () => {
  const expected = [
    "connect", "buildModels", "createRouter",
    "persistPIIwithconsent", "withdrawConsent",
    "listRights", "exerciseRight", "getConsentState",
    "complaintToTheBoard", "escalateToBoard", "consentManagerRequest",
    "erasePrincipalPII",
    "advanceRightsRequest", "advanceGrievance", "advanceConsentManagerRequest",
    "listRightsRequests", "listGrievances", "listConsentManagerRequests",
    "buildNotice", "newPrincipalId",
    "CONSENT_CATALOG", "RIGHTS_CATALOG", "FIDUCIARY",
  ];
  for (const name of expected) {
    assert.ok(toolkit[name] !== undefined, `missing export: ${name}`);
  }
});

test("derivePrincipalId is gone - it was the guessable-identity bug", () => {
  assert.equal(toolkit.derivePrincipalId, undefined,
    "exporting it again would reintroduce sha256(email) as an identifier");
});
