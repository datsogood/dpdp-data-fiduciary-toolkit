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

// ---------------------------------------------------------------------------
// The rendered page and the stored evidence must be the same document.
// ---------------------------------------------------------------------------

const { buildNotice } = require("../src/config/notice");
const { escapeHtml } = require("../src/http/forms");

/**
 * One probe list per TOP-LEVEL key of the notice, each drawn from the notice
 * object itself rather than from hardcoded prose - so a change to the catalog,
 * the fiduciary config or the SLA moves the expectation with it.
 *
 * The key-set assertion below is what makes this drift-proof: adding a field
 * to buildNotice fails this test until both the renderer and this table are
 * updated. Without it, a new notice field could be stored as evidence and
 * never displayed, which is the exact defect being closed.
 */
/**
 * Most probes are text values, which reach the page HTML-escaped. `language`
 * is rendered as an attribute on <html>, so it appears literally. Accept
 * either form rather than forcing the page into awkward prose just to make
 * one probe match the other probes' shape.
 *
 * A RegExp probe is for the one field whose value cannot be pinned:
 * generatedAt is stamped per render, so the notice this test builds carries a
 * different instant from the one the server rendered a moment earlier. The
 * assertion there is that the page states a generation time at all, in the
 * right shape - not which one.
 */
const shownOnPage = (html, probe) =>
  probe instanceof RegExp ? probe.test(html) : html.includes(String(probe)) || html.includes(escapeHtml(probe));

const NOTICE_PROBES = {
  language: (n) => [`lang="${n.language}"`],
  fiduciary: (n) => [n.fiduciary.name],
  purposes: (n) => n.purposes.flatMap((p) => [p.title, p.purpose, String(p.retentionMonths)]),
  personalData: (n) => n.personalData.flatMap((d) => [d.field, d.description]),
  rights: (n) => n.rights.flatMap((r) => [r.title, r.section, r.description]),
  withdrawal: (n) => [n.withdrawal.description, `/dpdp${n.withdrawal.path}`],
  grievance: (n) => [n.grievance.route, String(n.grievance.slaDays)],
  boardComplaint: (n) => [n.boardComplaint.description, `/dpdp${n.boardComplaint.grievancePath}`],
  dpo: (n) => [n.dpo.name, n.dpo.email],
  statute: (n) => [n.statute],
  version: (n) => [n.version],
  generatedAt: () => [/generated \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/],
};

test("the consent page displays every top-level key of the notice it stores", async () => {
  // POST /consent stores a NoticeVersion containing the whole notice and
  // stamps its hash on every event, so anything this page omits is something
  // the fiduciary's own evidence asserts the principal was told and was not.
  // The page interpolated the fiduciary name, the purposes and one withdrawal
  // sentence, and dropped the itemised personal data, every named right, the
  // grievance and Board complaint route, the DPO contact, and every link.
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => null }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const html = await (await fetch(`http://localhost:${port}/dpdp/consent/new`, { headers: HTML })).text();

      const notice = buildNotice({ language: "en" });
      assert.deepEqual(
        Object.keys(NOTICE_PROBES).sort(),
        Object.keys(notice).sort(),
        "buildNotice gained or lost a top-level key - render it on the page and add it here, or the stored " +
          "evidence will assert something the page never displayed"
      );

      for (const [key, probeFor] of Object.entries(NOTICE_PROBES)) {
        const probes = probeFor(notice);
        assert.ok(probes.length > 0, `${key}: probe list must not be empty, or this key is unchecked`);
        for (const probe of probes) {
          assert.ok(
            shownOnPage(html, probe),
            `notice.${key}: the page never displays ${JSON.stringify(String(probe).slice(0, 60))}, ` +
              `but POST /consent stores it as evidence of what the principal was shown`
          );
        }
      }

      // And the stored evidence really is this same notice, so the assertions
      // above are about the document that gets hashed onto every event.
      await fetch(`http://localhost:${port}/dpdp/consent`, {
        method: "POST",
        headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          name: "Asha", email: "notice@example.com", phone: "9333333333",
          dob: "1990-04-01", consentSubmitted: "1", consentTypes: "marketing",
        }),
      });
      const stored = await models.NoticeVersion.findOne({ version: notice.version });
      assert.ok(stored, "the page and the stored NoticeVersion must be the same notice, not two that merely agree");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test("every affordance on the rights page either submits successfully or links to a live route", async () => {
  // renderRightsPage filtered out only `grievance`, so `withdrawal` rendered
  // as a request card with a submit button - and exerciseRight rejects that
  // key, so a browser got a bare page reading "Use withdrawConsent (PUT or
  // POST /consent/withdraw)". A non-technical beneficiary cannot act on an
  // instruction naming an HTTP verb. The page also contained no link at all.
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const html = await (await fetch(`http://localhost:${port}/dpdp/rights`, { headers: HTML })).text();

      const forms = [...html.matchAll(/<form[^>]*action="([^"]+)"[\s\S]*?<\/form>/g)].map((m) => ({
        action: m[1].replace(/&amp;/g, "&"),
        right: (m[0].match(/name="right" value="([^"]+)"/) || [])[1],
      }));
      const links = [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

      assert.ok(forms.length > 0, "no forms found - the parse is wrong and this test proves nothing");
      assert.ok(links.length > 0, "the page must contain at least one link, it previously contained none");

      for (const { action, right } of forms) {
        assert.ok(right, `a request form must carry a right key, got action=${action}`);
        const res = await fetch(`http://localhost:${port}${action}`, {
          method: "POST",
          headers: { ...HTML, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ right, details: "" }),
        });
        assert.ok(res.status >= 200 && res.status < 300,
          `the "${right}" button must actually work, got ${res.status}: ${(await res.text()).slice(0, 160)}`);
      }

      for (const href of links) {
        const res = await fetch(`http://localhost:${port}${href}`, { headers: HTML });
        assert.equal(res.status, 200, `the rights page links to ${href}, which must be reachable`);
      }

      // Non-vacuity: every right in the catalog has to be ONE of the two, so
      // a future right cannot be quietly dropped from the page altogether.
      const { RIGHTS_CATALOG } = require("../src/config/catalog");
      for (const r of RIGHTS_CATALOG) {
        const offered = forms.some((f) => f.right === r.key);
        const linked = r.key === "withdrawal"
          ? links.some((h) => h.endsWith("/consent/withdraw"))
          : r.key === "grievance"
            ? links.some((h) => h.endsWith("/grievance/new"))
            : false;
        assert.ok(offered || linked, `the right "${r.key}" is stated in the catalog but unreachable from /rights`);
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
