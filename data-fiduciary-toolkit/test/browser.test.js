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

test("the withdrawal receipt states what was withdrawn, what was refused and why, and what needed no change", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing", "analytics"] });
    // analytics is already withdrawn BEFORE the form submission below, so the
    // page has to render it as "no change needed", not as freshly withdrawn.
    await withdrawConsent({ models, principalId, consentTypes: ["analytics"] });

    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      // marketing is currently granted (withdraws), kyc_reporting rests on
      // Section 7(d) (refused), analytics is already withdrawn (no change).
      // URLSearchParams(object) stringifies an array value with commas rather
      // than repeating the key, so the three checkboxes are appended
      // individually - exactly how a browser serialises three ticked boxes
      // sharing one name.
      const body = new URLSearchParams();
      body.append("consentSubmitted", "1");
      body.append("consentTypes", "marketing");
      body.append("consentTypes", "kyc_reporting");
      body.append("consentTypes", "analytics");
      const res = await fetch(`http://localhost:${port}/dpdp/consent/withdraw`, {
        method: "POST",
        headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      assert.equal(res.status, 200, "a form POST must reach a real route, not 404");
      assert.match(res.headers.get("content-type"), /text\/html/, "a browser must get a page, not JSON");

      const html = await res.text();
      assert.match(html, /Withdrawn/);
      assert.match(html, /Marketing and personalised offers/, "the withdrawn purpose is named");
      assert.match(html, /Could not be withdrawn/);
      assert.match(html, /Anti-money-laundering reporting/, "the refused purpose is named");
      assert.match(html, /Section 7\(d\)/, "the refusal states the clause it rests on, not just that it was refused");
      assert.match(html, /No change needed/);
      assert.match(html, /Product analytics and improvement/, "the already-withdrawn purpose is named");
      assert.match(html, /not an error/i, "an already-withdrawn purpose must be stated as a non-error, not left to read like one");

      const record = await models.ConsentRecord.findOne({ principalId });
      const state = record.currentState();
      assert.equal(state.marketing.status, "withdrawn");
      assert.equal(state.analytics.status, "withdrawn");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("both receipt pages carry Cache-Control: no-store - they show or reveal principal-identifying state", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const app = express();
    let principalId;
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const consentRes = await fetch(`http://localhost:${port}/dpdp/consent`, {
        method: "POST",
        headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "Cache", email: "cache@example.com", phone: "9222222222", dob: "1990-04-01", consentSubmitted: "1", consentTypes: "marketing" }),
      });
      assert.equal(consentRes.headers.get("cache-control"), "no-store");
      const html = await consentRes.text();
      principalId = html.match(/[a-f0-9]{64}/)[0];

      const withdrawRes = await fetch(`http://localhost:${port}/dpdp/consent/withdraw`, {
        method: "POST",
        headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ consentSubmitted: "1", consentTypes: "marketing" }),
      });
      assert.equal(withdrawRes.headers.get("cache-control"), "no-store");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
