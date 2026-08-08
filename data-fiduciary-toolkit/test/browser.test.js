const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
const { buildModels } = require("../src/models");
const createRouter = require("../src/http/router");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };
const HTML = { Accept: "text/html" };

test("the consent page states the notice and offers a checkbox per optional purpose", async () => {
  await withDb(async (conn) => {
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent/new`, { headers: HTML });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /name="consentTypes" value="marketing"/);
      assert.match(html, /name="consentTypes" value="analytics"/);
      assert.doesNotMatch(html, /name="consentTypes" value="kyc_reporting"/,
        "a legitimate use is not a choice - it must be stated, not offered as a checkbox");
      assert.match(html, /Prevention of Money-Laundering Act/, "the notice must state each lawful basis");
      assert.match(html, /name="dob"/, "the age gate needs a date of birth field");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("a browser user is shown their principalId after consenting - the forms are unusable without it", async () => {
  await withDb(async (conn) => {
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent`, {
        method: "POST",
        headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01", consentTypes: "marketing" }),
      });
      const html = await res.text();
      assert.match(html, /[a-f0-9]{64}/, "the receipt page must show the identifier every other form asks for");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("a withdrawal page exists, with the same prominence as consenting", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent/withdraw`, { headers: HTML });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /name="consentTypes" value="marketing"/);
      assert.match(html, /<form[^>]*method="POST"/i);
      assert.doesNotMatch(html, /name="consentTypes" value="kyc_reporting"/, "a non-withdrawable purpose must not be offered");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("rendered forms no longer demand a principalId the page cannot supply", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: [] });
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      for (const path of ["/rights", "/grievance/new", "/consent-manager/new"]) {
        const html = await (await fetch(`http://localhost:${port}/dpdp${path}`, { headers: HTML })).text();
        assert.doesNotMatch(html, /name="principalId"/,
          `${path}: identity comes from the session, not from a field the user cannot fill`);
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("the rendered withdrawal form can actually be submitted", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent/withdraw`, {
        method: "POST",
        headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ consentSubmitted: "1", consentTypes: "marketing" }),
      });
      assert.equal(res.status, 200, "a form POST must reach a real route, not 404");

      const record = await models.ConsentRecord.findOne({ principalId });
      const state = record.currentState();
      assert.equal(state.marketing.status, "withdrawn");
      assert.equal(state.analytics.status, "granted", "only the ticked purpose is withdrawn");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("a single ticked checkbox is accepted, not rejected as a non-array", async () => {
  // extended:false parses one value as a string and two as an array, so this is
  // the case that would 400 without the router's normalisation.
  await withDb(async (conn) => {
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent`, {
        method: "POST",
        headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          name: "Asha", email: "single@example.com", phone: "9000000001",
          dob: "1990-04-01", consentSubmitted: "1", consentTypes: "marketing",
        }),
      });
      assert.equal(res.status, 201);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
