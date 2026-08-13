const test = require("node:test");
const assert = require("node:assert/strict");
process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
const toolkit = require("../src/index");

test("the documented public API is all exported", () => {
  const expected = [
    "connect", "buildModels", "createRouter", "createPlugin", "buildOpenApiDocument",
    "persistPIIwithconsent", "withdrawConsent",
    "listRights", "exerciseRight", "getConsentState",
    "complaintToTheBoard", "escalateToBoard", "consentManagerRequest",
    "erasePrincipalPII",
    "advanceRightsRequest", "advanceGrievance", "advanceConsentManagerRequest",
    // getRightsRequest and getGrievance were dropped from this list in the
    // first pass of this task, then restored in fix round 1: the brief's own
    // list predates Task 10's item-level readers, so following it literally
    // removed a real capability (list a principal's requests but never fetch
    // the one refId they were actually given). See the structural test below,
    // which exists so this specific mistake cannot recur silently.
    "listRightsRequests", "getRightsRequest",
    "listGrievances", "getGrievance",
    "listConsentManagerRequests",
    "buildNotice", "newPrincipalId",
    // Restored in the same fix round: the building block for a host's own
    // sign-in (turn a verified contact detail into a principalId), used by
    // examples/server.js's demo login and needed by anyone doing the same
    // thing for real.
    "findPrincipalByContact",
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

/**
 * Structural guard against the exact mistake fix round 1 corrected: a
 * hardcoded name list only catches drift the person editing it thought to
 * check for. This instead walks each service module's OWN exports, and
 * wherever a module exports both a list* reader and the matching get* one
 * (list a principal's requests; get the one refId they were actually given),
 * requires the public surface to export both or neither - never just the
 * list, which is what shipped by mistake the first time.
 *
 * Deliberately does NOT require every list* to have a get* - ConsentManagerRequest
 * has no getConsentManagerRequest at the service level at all (a separate,
 * already-tracked gap, not this test's concern), and listRights (the static
 * rights catalog) has no singular form to pair with. Only a list/get pair
 * that genuinely exists on the service can be asserted on.
 */
test("every list*/get* pair a service module actually exports is exported here together", () => {
  const services = [
    require("../src/services/dataPrincipalRights"),
    require("../src/services/complaintToTheBoard"),
    require("../src/services/consentManagerRequest"),
  ];
  let pairsChecked = 0;
  for (const service of services) {
    for (const name of Object.keys(service)) {
      if (!name.startsWith("list") || typeof service[name] !== "function") continue;
      const getName = `get${name.slice(4).replace(/s$/, "")}`;
      if (typeof service[getName] !== "function") continue; // no paired reader on this service - nothing to check

      pairsChecked += 1;
      assert.ok(toolkit[name] !== undefined, `${name} must be exported`);
      assert.ok(
        toolkit[getName] !== undefined,
        `${getName} exists on the service alongside ${name} but is missing from the public API - ` +
          `an integrator could list requests but never fetch the one refId a data principal was actually given`
      );
    }
  }
  // If this drops to 0, the loop above is silently checking nothing - the
  // test would pass on a codebase with no list/get pairs at all, which is
  // not the codebase this guards.
  assert.ok(pairsChecked >= 2, `expected at least 2 list/get pairs to check, found ${pairsChecked}`);
});
