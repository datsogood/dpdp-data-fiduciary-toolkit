const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";

const { withDb } = require("./helpers/db");
const { clearHttpModuleCache } = require("./helpers/clearHttpCache");
const { bootExpress, PII } = require("./helpers/httpHarness");
const { registerHttpBehaviorTests } = require("./helpers/httpBehaviorSuite");
const { buildModels } = require("../src/models");
const createRouter = require("../src/http/router");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");

registerHttpBehaviorTests(bootExpress);

test("an internal fault is 500 with a generic body, not 400 with the raw message", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const app = express();
    app.use(
      "/dpdp",
      createRouter({
        db: conn,
        resolvePrincipal: () => principalId,
        onWithdrawal: () => {
          throw new Error("SECRET internal detail");
        },
      })
    );
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent/withdraw`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ consentTypes: ["marketing"] }),
      });
      assert.equal(res.status, 500, "an internal fault must not be reported as a client error");
      const body = await res.json();
      assert.doesNotMatch(JSON.stringify(body), /SECRET internal detail/, "internal messages must not leak");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("createRouter refuses to start with a placeholder DPO contact", async () => {
  await withDb(async (conn) => {
    const saved = process.env.FIDUCIARY_DPO_EMAIL;
    try {
      clearHttpModuleCache();
      process.env.FIDUCIARY_DPO_EMAIL = "dpo@example.com";
      const freshRouter = require("../src/http/router");
      assert.throws(() => freshRouter({ db: conn, resolvePrincipal: () => null }), /FIDUCIARY_DPO_EMAIL/);
    } finally {
      process.env.FIDUCIARY_DPO_EMAIL = saved;
      clearHttpModuleCache();
    }
  });
});

test("createRouter refuses to start on a DPO contact that is not an address at all", async () => {
  await withDb(async (conn) => {
    const saved = process.env.FIDUCIARY_DPO_EMAIL;
    for (const bad of [" ", "tbd", "not-an-email", "dpo@localhost", " dpo@real.example "]) {
      try {
        clearHttpModuleCache();
        process.env.FIDUCIARY_DPO_EMAIL = bad;
        const freshRouter = require("../src/http/router");
        assert.throws(
          () => freshRouter({ db: conn, resolvePrincipal: () => null }),
          /FIDUCIARY_DPO_EMAIL/,
          `${JSON.stringify(bad)} must not reach a data principal as a contact address`
        );
      } finally {
        process.env.FIDUCIARY_DPO_EMAIL = saved;
        clearHttpModuleCache();
      }
    }
  });
});

test("createRouter refuses to start on a non-integer SLA", async () => {
  await withDb(async (conn) => {
    const saved = process.env.GRIEVANCE_SLA_DAYS;
    try {
      clearHttpModuleCache();
      process.env.GRIEVANCE_SLA_DAYS = "seven";
      const freshRouter = require("../src/http/router");
      assert.throws(() => freshRouter({ db: conn, resolvePrincipal: () => null }), /GRIEVANCE_SLA_DAYS/);
    } finally {
      if (saved === undefined) delete process.env.GRIEVANCE_SLA_DAYS;
      else process.env.GRIEVANCE_SLA_DAYS = saved;
      clearHttpModuleCache();
    }
  });
});
