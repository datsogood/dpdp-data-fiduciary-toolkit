const test = require("node:test");
const assert = require("node:assert/strict");

const { withDb } = require("./db");
const { ledgerEvents } = require("./httpHarness");

/**
 * Shared HTTP behavioural tests for Express and Fastify adapters.
 * @param {(conn: object, opts?: object) => Promise<object>} boot
 */
function registerHttpBehaviorTests(boot) {
  test("a default API client (Accept: */*) gets 201 JSON, not 200 HTML", async () => {
    await withDb(async (conn) => {
      const { call, close } = await boot(conn);
      try {
        const res = await call("POST", "/rights/exercise", { right: "erasure", details: "close my account" });
        assert.equal(res.status, 201, "*/* must not be treated as a browser asking for HTML");
        assert.match(res.headers.get("content-type"), /application\/json/);
        const body = await res.json();
        assert.match(body.refId, /^RQ-/);
        assert.equal(body.status, "received");
        assert.ok(body.contact.dpoEmail, "the DPO contact must be in the response");
      } finally {
        await close();
      }
    });
  });

  test("every negotiating route answers a default curl request with JSON", async () => {
    await withDb(async (conn) => {
      const { call, close } = await boot(conn);
      try {
        const rights = await call("GET", "/rights");
        assert.match(rights.headers.get("content-type"), /application\/json/);
        assert.ok(Array.isArray(await rights.json()));

        const grievance = await call("POST", "/grievance", { subject: "Unwanted calls", description: "..." });
        assert.equal(grievance.status, 201);
        assert.match(grievance.headers.get("content-type"), /application\/json/);
        assert.match((await grievance.json()).refId, /^GR-/);

        const cm = await call("POST", "/consent-manager", { message: "connect me to a consent manager" });
        assert.equal(cm.status, 201);
        assert.match(cm.headers.get("content-type"), /application\/json/);
        assert.match((await cm.json()).refId, /^CM-/);
      } finally {
        await close();
      }
    });
  });

  test("a browser (Accept: text/html) still gets HTML", async () => {
    await withDb(async (conn) => {
      const { call, close } = await boot(conn);
      try {
        const res = await call("POST", "/rights/exercise", { right: "access" }, { Accept: "text/html" });
        assert.match(res.headers.get("content-type"), /text\/html/);
      } finally {
        await close();
      }
    });
  });

  test("forms work when the router is mounted somewhere other than /", async () => {
    await withDb(async (conn) => {
      const { call, close } = await boot(conn, { basePath: "/compliance/dpdp" });
      try {
        const res = await call("GET", "/rights", undefined, { Accept: "text/html" });
        const html = await res.text();
        assert.match(html, /action="\/compliance\/dpdp\/rights\/exercise"/);

        const grievance = await (await call("GET", "/grievance/new", undefined, { Accept: "text/html" })).text();
        assert.match(grievance, /action="\/compliance\/dpdp\/grievance"/);

        const cm = await (await call("GET", "/consent-manager/new", undefined, { Accept: "text/html" })).text();
        assert.match(cm, /action="\/compliance\/dpdp\/consent-manager"/);
      } finally {
        await close();
      }
    });
  });

  test("mounted at the root, form actions stay absolute from /", async () => {
    await withDb(async (conn) => {
      const { call, close } = await boot(conn, { basePath: "/" });
      try {
        const html = await (await call("GET", "rights", undefined, { Accept: "text/html" })).text();
        assert.match(html, /action="\/rights\/exercise"/);
      } finally {
        await close();
      }
    });
  });

  test("a validation error is still 400 with a useful message", async () => {
    await withDb(async (conn) => {
      const { call, close } = await boot(conn);
      try {
        const res = await call("POST", "/rights/exercise", { right: "not-a-right" }, { Accept: "application/json" });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /unknown right/i);
      } finally {
        await close();
      }
    });
  });

  test("a cross-origin withdrawal is refused and the ledger is untouched", async () => {
    await withDb(async (conn) => {
      const { call, close, models, principalId } = await boot(conn);
      try {
        const before = await ledgerEvents(models, principalId);
        const res = await call(
          "POST",
          "/consent/withdraw",
          { consentTypes: ["marketing"] },
          { Origin: "https://evil.example", Accept: "application/json" }
        );
        assert.equal(res.status, 403);

        const after = await ledgerEvents(models, principalId);
        assert.equal(after.length, before.length);
        assert.equal(after.filter((e) => e.status === "withdrawn").length, 0);
      } finally {
        await close();
      }
    });
  });

  test("a same-origin withdrawal succeeds", async () => {
    await withDb(async (conn) => {
      const { call, close, models, principalId, origin } = await boot(conn);
      try {
        const res = await call(
          "POST",
          "/consent/withdraw",
          { consentTypes: ["marketing"] },
          { Origin: origin, Accept: "application/json" }
        );
        assert.equal(res.status, 200);
        assert.deepEqual((await res.json()).withdrawn, ["marketing"]);

        const after = await ledgerEvents(models, principalId);
        assert.equal(after.filter((e) => e.status === "withdrawn").length, 1);
      } finally {
        await close();
      }
    });
  });

  test("a request with no Origin at all still succeeds - non-browser clients are not the threat", async () => {
    await withDb(async (conn) => {
      const { call, close } = await boot(conn);
      try {
        const res = await call("POST", "/consent/withdraw", { consentTypes: ["marketing"] }, { Accept: "application/json" });
        assert.equal(res.status, 200);
      } finally {
        await close();
      }
    });
  });

  test("an Origin of null is refused - it is a value, not an absent header", async () => {
    await withDb(async (conn) => {
      const { call, close, models, principalId } = await boot(conn);
      try {
        const res = await call(
          "POST",
          "/consent/withdraw",
          { consentTypes: ["marketing"] },
          { Origin: "null", Accept: "application/json" }
        );
        assert.equal(res.status, 403);
        assert.equal((await ledgerEvents(models, principalId)).filter((e) => e.status === "withdrawn").length, 0);
      } finally {
        await close();
      }
    });
  });

  test("a configured allowedOrigins entry is honoured, and does not displace the request's own host", async () => {
    await withDb(async (conn) => {
      const { call, close, origin } = await boot(conn, { allowedOrigins: ["https://portal.example"] });
      try {
        const allowed = await call(
          "POST",
          "/consent/withdraw",
          { consentTypes: ["marketing"] },
          { Origin: "https://portal.example", Accept: "application/json" }
        );
        assert.equal(allowed.status, 200);

        const refused = await call(
          "POST",
          "/consent/withdraw",
          { consentTypes: ["analytics"] },
          { Origin: "https://evil.example", Accept: "application/json" }
        );
        assert.equal(refused.status, 403);

        const ownHost = await call(
          "POST",
          "/consent/withdraw",
          { consentTypes: ["analytics"] },
          { Origin: origin, Accept: "application/json" }
        );
        assert.equal(ownHost.status, 200);
      } finally {
        await close();
      }
    });
  });

  test("a scheme-less allowedOrigins entry matches, and an empty parsed host never does", async () => {
    await withDb(async (conn) => {
      const { call, close } = await boot(conn, { allowedOrigins: ["localhost:9999", "portal.example"] });
      try {
        const bareHostPort = await call(
          "POST",
          "/consent/withdraw",
          { consentTypes: ["analytics"] },
          { Origin: "http://localhost:9999", Accept: "application/json" }
        );
        assert.equal(bareHostPort.status, 200);

        const bareHost = await call(
          "POST",
          "/consent/withdraw",
          { consentTypes: ["analytics"] },
          { Origin: "https://portal.example", Accept: "application/json" }
        );
        assert.equal(bareHost.status, 200);

        const emptyHost = await call(
          "POST",
          "/consent/withdraw",
          { consentTypes: ["analytics"] },
          { Origin: "about:blank", Accept: "application/json" }
        );
        assert.equal(emptyHost.status, 403);
      } finally {
        await close();
      }
    });
  });

  test("a present-but-empty Origin is refused, not read as no origin at all", async () => {
    await withDb(async (conn) => {
      const { call, close, models, principalId } = await boot(conn);
      try {
        const res = await call(
          "POST",
          "/consent/withdraw",
          { consentTypes: ["marketing"] },
          { Origin: "", Accept: "application/json" }
        );
        assert.equal(res.status, 403);
        assert.equal((await ledgerEvents(models, principalId)).filter((e) => e.status === "withdrawn").length, 0);
      } finally {
        await close();
      }
    });
  });

  test("a GET is never blocked by the origin check - only state-changing methods are", async () => {
    await withDb(async (conn) => {
      const { call, close } = await boot(conn);
      try {
        const res = await call("GET", "/consent", undefined, { Origin: "https://evil.example", Accept: "application/json" });
        assert.equal(res.status, 200);
      } finally {
        await close();
      }
    });
  });

  test("the grievance response does not claim delivery the toolkit cannot perform", async () => {
    await withDb(async (conn) => {
      const { call, close } = await boot(conn);
      try {
        const res = await call("POST", "/grievance", { subject: "Unwanted calls", description: "..." }, { Accept: "application/json" });
        const body = await res.json();
        assert.doesNotMatch(body.note, /has been sent/i);
        assert.match(body.note, /recorded/i);
      } finally {
        await close();
      }
    });
  });

  test("a throwing onGrievanceFiled still returns 201 with a usable refId", async () => {
    await withDb(async (conn) => {
      const { call, close, models, principalId } = await boot(conn, {
        onGrievanceFiled: () => {
          throw new Error("host notification pipeline is down");
        },
      });
      try {
        const res = await call("POST", "/grievance", { subject: "Unwanted calls", description: "..." }, { Accept: "application/json" });
        assert.equal(res.status, 201);
        const { refId } = await res.json();
        assert.match(refId, /^GR-/);
        const stored = await models.Grievance.findOne({ principalId, refId }).lean();
        assert.ok(stored);
      } finally {
        await close();
      }
    });
  });

  test("slaDueAt is on the rights-request read path - a principal must be able to see when it is due", async () => {
    await withDb(async (conn) => {
      const { call, close } = await boot(conn);
      try {
        const { refId } = await (await call("POST", "/rights/exercise", { right: "access" }, { Accept: "application/json" })).json();

        const one = await (await call("GET", `/rights/requests/${refId}`, undefined, { Accept: "application/json" })).json();
        assert.ok(one.slaDueAt);

        const rows = await (await call("GET", "/rights/requests", undefined, { Accept: "application/json" })).json();
        assert.ok(rows[0].slaDueAt);
      } finally {
        await close();
      }
    });
  });
}

module.exports = { registerHttpBehaviorTests };
