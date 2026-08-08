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
const { getConsentState } = require("../src/services/consentState");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };

test("a principal's full consent history can be read back", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await withdrawConsent({ models, principalId, consentTypes: ["marketing"] });

    const view = await getConsentState({ models, principalId });
    assert.equal(view.state.marketing.status, "withdrawn");
    assert.equal(view.ledger.length, view.ledger.filter(Boolean).length);
    assert.ok(view.ledger.length >= 2, "the ledger must expose grant and withdrawal, not just current state");
    assert.ok(view.ledger.every((e) => e.timestamp && e.receiptId));
  });
});

test("getConsentState returns pii for a principal who has not been erased, and erasedAt is null", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    const view = await getConsentState({ models, principalId });
    assert.equal(view.pii.name, "Asha");
    assert.equal(view.pii.email, "asha@example.com");
    assert.equal(view.erasedAt, null);
  });
});

test("GET /consent returns the ledger to the authenticated owner only", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    let acting = principalId;
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => acting }));
    const server = app.listen(0);
    const port = server.address().port;
    const get = (p) => fetch(`http://localhost:${port}/dpdp${p}`, { headers: { Accept: "application/json" } });

    try {
      const mine = await get("/consent");
      assert.equal(mine.status, 200);
      const body = await mine.json();
      assert.equal(body.state.marketing.status, "granted");

      // Another principal must not see it.
      acting = "f".repeat(64);
      const theirs = await get("/consent");
      assert.equal(theirs.status, 404, "a different principal must not read this ledger");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

/**
 * Boots an app authenticated as one fixed principal and returns a small
 * fetch helper - the property below is the whole point of this task, so it
 * is exercised against every read route the router now has, not just
 * GET /consent.
 */
async function bootApp(conn, principalId) {
  const a = express();
  a.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
  const server = a.listen(0);
  const port = server.address().port;
  return {
    call: (method, path, body) =>
      fetch(`http://localhost:${port}/dpdp${path}`, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test("GET /rights/requests and GET /rights/requests/:refId are scoped to the owner - a stranger gets 404, not 403", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId: a } = await persistPIIwithconsent({ models, pii: PII, consentTypes: [] });
    const { principalId: b } = await persistPIIwithconsent({
      models,
      pii: { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" },
      consentTypes: [],
    });

    let refId;
    const asA = await bootApp(conn, a);
    try {
      const filed = await asA.call("POST", "/rights/exercise", { right: "access" });
      assert.equal(filed.status, 201);
      ({ refId } = await filed.json());

      const mine = await asA.call("GET", `/rights/requests/${refId}`);
      assert.equal(mine.status, 200);
      assert.equal((await mine.json()).refId, refId);

      const list = await asA.call("GET", "/rights/requests");
      const rows = await list.json();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].refId, refId);
    } finally {
      await asA.close();
    }

    const asB = await bootApp(conn, b);
    try {
      const stolen = await asB.call("GET", `/rights/requests/${refId}`);
      assert.equal(stolen.status, 404, "a different principal's request must 404, not 403 or 200");

      const bList = await asB.call("GET", "/rights/requests");
      assert.deepEqual(
        await bList.json(), [],
        "a principal with no requests of their own must see an empty list, never someone else's"
      );
    } finally {
      await asB.close();
    }
  });
});

test("GET /grievances and GET /grievances/:refId are scoped to the owner - a stranger gets 404, not 403", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId: a } = await persistPIIwithconsent({ models, pii: PII, consentTypes: [] });
    const { principalId: b } = await persistPIIwithconsent({
      models,
      pii: { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" },
      consentTypes: [],
    });

    let refId;
    const asA = await bootApp(conn, a);
    try {
      const filed = await asA.call("POST", "/grievance", { subject: "s", description: "d" });
      assert.equal(filed.status, 201);
      ({ refId } = await filed.json());

      const mine = await asA.call("GET", `/grievances/${refId}`);
      assert.equal(mine.status, 200);
      assert.equal((await mine.json()).refId, refId);

      const list = await asA.call("GET", "/grievances");
      assert.equal((await list.json()).length, 1);
    } finally {
      await asA.close();
    }

    const asB = await bootApp(conn, b);
    try {
      const stolen = await asB.call("GET", `/grievances/${refId}`);
      assert.equal(stolen.status, 404, "a different principal's grievance must 404, not 403 or 200");

      const bList = await asB.call("GET", "/grievances");
      assert.deepEqual(await bList.json(), [], "a stranger must never see another principal's grievances");
    } finally {
      await asB.close();
    }
  });
});

test("GET /consent-manager/requests is scoped to the owner", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId: a } = await persistPIIwithconsent({ models, pii: PII, consentTypes: [] });
    const { principalId: b } = await persistPIIwithconsent({
      models,
      pii: { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" },
      consentTypes: [],
    });

    const asA = await bootApp(conn, a);
    try {
      const filed = await asA.call("POST", "/consent-manager", { message: "connect me to a consent manager" });
      assert.equal(filed.status, 201);
      const list = await asA.call("GET", "/consent-manager/requests");
      assert.equal((await list.json()).length, 1);
    } finally {
      await asA.close();
    }

    const asB = await bootApp(conn, b);
    try {
      const bList = await asB.call("GET", "/consent-manager/requests");
      assert.deepEqual(
        await bList.json(), [],
        "a stranger must never see another principal's consent-manager requests"
      );
    } finally {
      await asB.close();
    }
  });
});

test("GET /consent for an erased principal surfaces erasedAt and never resurrects pii", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    await erasePrincipalPII({ models, principalId });

    const asPrincipal = await bootApp(conn, principalId);
    try {
      const res = await asPrincipal.call("GET", "/consent");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.pii, null, "an erased principal's PII must not be returned");
      assert.ok(body.erasedAt, "erasedAt must be surfaced so the caller knows why pii is null");
      assert.equal(body.state.marketing.status, "granted", "erasure must not touch the append-only ledger");
    } finally {
      await asPrincipal.close();
    }
  });
});

test("a principalId in the query string is ignored on a read route - identity comes only from the session", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId: a } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const { principalId: b } = await persistPIIwithconsent({
      models,
      pii: { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" },
      consentTypes: ["analytics"],
    });

    const asA = await bootApp(conn, a);
    try {
      const res = await asA.call("GET", `/consent?principalId=${b}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.principalId, a, "the query string must never override the authenticated session");
      assert.equal(body.state.marketing.status, "granted", "this must be A's own ledger, not B's");
    } finally {
      await asA.close();
    }
  });
});
