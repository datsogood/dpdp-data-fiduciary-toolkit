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

/**
 * Boots an app mounted at basePath, authenticated as one fixed principal.
 * Every option other than basePath/consentTypes is forwarded to createRouter,
 * so a test can supply allowedOrigins or a host hook.
 */
async function boot(conn, { basePath = "/dpdp", consentTypes = ["marketing"], ...opts } = {}) {
  const models = buildModels(conn);
  const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes });
  const app = express();
  app.use(basePath, createRouter({ db: conn, resolvePrincipal: () => principalId, ...opts }));
  const server = app.listen(0);
  const port = server.address().port;
  return {
    models,
    principalId,
    port,
    origin: `http://localhost:${port}`,
    call: (method, p, body, headers = {}) =>
      fetch(`http://localhost:${port}${basePath}${p}`, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}

/** The raw append-only ledger, so a refusal can be checked against the data, not just the status. */
async function ledgerEvents(models, principalId) {
  const record = await models.ConsentRecord.findOne({ principalId }).lean();
  return record ? record.events : [];
}

// ---------------------------------------------------------------------------
// Content negotiation (H5)
// ---------------------------------------------------------------------------

test("a default API client (Accept: */*) gets 201 JSON, not 200 HTML", async () => {
  await withDb(async (conn) => {
    const { call, close } = await boot(conn);
    try {
      // fetch sends Accept: */* by default - exactly what curl does.
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

// ---------------------------------------------------------------------------
// Mount-relative form actions (M1)
// ---------------------------------------------------------------------------

test("forms work when the router is mounted somewhere other than /", async () => {
  await withDb(async (conn) => {
    const { call, close } = await boot(conn, { basePath: "/compliance/dpdp" });
    try {
      const res = await call("GET", "/rights", undefined, { Accept: "text/html" });
      const html = await res.text();
      assert.match(
        html,
        /action="\/compliance\/dpdp\/rights\/exercise"/,
        "hardcoded absolute actions 404 whenever the router is not mounted at /"
      );

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

// ---------------------------------------------------------------------------
// Error mapping (M6 - verifying T5's single mapper)
// ---------------------------------------------------------------------------

test("an internal fault is 500 with a generic body, not 400 with the raw message", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    // marketing must actually be GRANTED, or withdrawConsent finds nothing to
    // revoke, never calls onWithdrawal, and the fault is never injected.
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const app = express();
    app.use(
      "/dpdp",
      createRouter({
        db: conn,
        resolvePrincipal: () => principalId,
        // Force an internal fault from inside a handler.
        //
        // Must be onWithdrawal, NOT onGrievanceFiled. Task 5 made the grievance
        // hook non-fatal on purpose: a throwing host callback used to produce a
        // generic 500 and the data principal never learned their refId, so they
        // re-filed and created a duplicate grievance. onWithdrawal is
        // deliberately still fatal - it is how the host learns it must cease
        // processing, and a withdrawal is idempotent, so it should fail loudly.
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

// ---------------------------------------------------------------------------
// Same-origin check on state-changing routes
//
// The original audit refuted a CSRF finding, and correctly: with no ambient
// credential a cross-site POST conferred nothing curl could not already do.
// resolvePrincipal changed that - hosts back it with a cookie session, and
// POST /consent/withdraw exists precisely so an HTML form can reach it. A
// forged withdrawal writes to an append-only ledger and cannot be undone.
// ---------------------------------------------------------------------------

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
      assert.equal(after.length, before.length, "a refused withdrawal must append nothing to the ledger");
      assert.equal(
        after.filter((e) => e.status === "withdrawn").length,
        0,
        "the append-only ledger cannot be repaired - the write must never happen"
      );
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
      assert.equal(res.status, 200, "curl and server-to-server clients send neither Origin nor Referer");
    } finally {
      await close();
    }
  });
});

test("an Origin of null is refused - it is a value, not an absent header", async () => {
  await withDb(async (conn) => {
    const { call, close, models, principalId } = await boot(conn);
    try {
      // A sandboxed iframe, and a cross-origin POST that passed through a
      // redirect, both send the literal string "null". Treating that as
      // "no Origin" would reopen the whole hole.
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

      // The assertion that tells union apart from replace, and the only one in
      // this file that can. Under replace, naming one partner origin silently
      // stops the fiduciary's OWN forms working - and the route it breaks is
      // the withdrawal route, which is the one a data principal most needs to
      // reach. It fails closed, in production, long after the config change.
      const ownHost = await call(
        "POST",
        "/consent/withdraw",
        { consentTypes: ["analytics"] },
        { Origin: origin, Accept: "application/json" }
      );
      assert.equal(
        ownHost.status,
        200,
        "configuring a partner origin must not stop the router's own host from posting to it"
      );
    } finally {
      await close();
    }
  });
});

test("a scheme-less allowedOrigins entry matches, and an empty parsed host never does", async () => {
  await withDb(async (conn) => {
    // new URL("localhost:9999").host is "" and does NOT throw - "localhost:"
    // reads as a scheme. So a bare host:port entry used to yield "" and match
    // nothing, while admitting any Origin that also parsed to "" (file://,
    // about:blank). Both halves are asserted here.
    const { call, close } = await boot(conn, { allowedOrigins: ["localhost:9999", "portal.example"] });
    try {
      const bareHostPort = await call(
        "POST",
        "/consent/withdraw",
        { consentTypes: ["analytics"] },
        { Origin: "http://localhost:9999", Accept: "application/json" }
      );
      assert.equal(bareHostPort.status, 200, "a host:port entry must match the way an operator writes it");

      const bareHost = await call(
        "POST",
        "/consent/withdraw",
        { consentTypes: ["analytics"] },
        { Origin: "https://portal.example", Accept: "application/json" }
      );
      assert.equal(bareHost.status, 200, "a bare host entry must match too");

      // The fail-open half: about:blank parses cleanly to an empty host.
      const emptyHost = await call(
        "POST",
        "/consent/withdraw",
        { consentTypes: ["analytics"] },
        { Origin: "about:blank", Accept: "application/json" }
      );
      assert.equal(emptyHost.status, 403, "an origin with no host must never be admitted by an empty config host");
    } finally {
      await close();
    }
  });
});

test("a present-but-empty Origin is refused, not read as no origin at all", async () => {
  await withDb(async (conn) => {
    const { call, close, models, principalId } = await boot(conn);
    try {
      // No browser emits this - it is defence in depth against reading the
      // header's absence as falsiness rather than as undefined.
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

// ---------------------------------------------------------------------------
// Configuration guards (M11, L2)
// ---------------------------------------------------------------------------

test("createRouter refuses to start with a placeholder DPO contact", async () => {
  await withDb(async (conn) => {
    const saved = process.env.FIDUCIARY_DPO_EMAIL;
    try {
      // catalog.js reads env at import, so re-require it fresh.
      delete require.cache[require.resolve("../src/config/catalog")];
      delete require.cache[require.resolve("../src/http/router")];
      process.env.FIDUCIARY_DPO_EMAIL = "dpo@example.com";
      const freshRouter = require("../src/http/router");
      assert.throws(() => freshRouter({ db: conn, resolvePrincipal: () => null }), /FIDUCIARY_DPO_EMAIL/);
    } finally {
      process.env.FIDUCIARY_DPO_EMAIL = saved;
      delete require.cache[require.resolve("../src/config/catalog")];
      delete require.cache[require.resolve("../src/http/router")];
    }
  });
});

test("createRouter refuses to start on a DPO contact that is not an address at all", async () => {
  await withDb(async (conn) => {
    const saved = process.env.FIDUCIARY_DPO_EMAIL;
    // Not the placeholder, so the placeholder list never sees them - and just
    // as useless published on a grievance page as dpo@example.com is.
    for (const bad of [" ", "tbd", "not-an-email", "dpo@localhost", " dpo@real.example "]) {
      try {
        delete require.cache[require.resolve("../src/config/catalog")];
        delete require.cache[require.resolve("../src/http/router")];
        process.env.FIDUCIARY_DPO_EMAIL = bad;
        const freshRouter = require("../src/http/router");
        assert.throws(
          () => freshRouter({ db: conn, resolvePrincipal: () => null }),
          /FIDUCIARY_DPO_EMAIL/,
          `${JSON.stringify(bad)} must not reach a data principal as a contact address`
        );
      } finally {
        process.env.FIDUCIARY_DPO_EMAIL = saved;
        delete require.cache[require.resolve("../src/config/catalog")];
        delete require.cache[require.resolve("../src/http/router")];
      }
    }
  });
});

test("createRouter refuses to start on a non-integer SLA", async () => {
  await withDb(async (conn) => {
    const saved = process.env.GRIEVANCE_SLA_DAYS;
    try {
      delete require.cache[require.resolve("../src/config/catalog")];
      delete require.cache[require.resolve("../src/http/router")];
      // Number("seven") is NaN, so every slaDueAt became an Invalid Date and
      // every grievance failed at the moment a person tried to file one.
      process.env.GRIEVANCE_SLA_DAYS = "seven";
      const freshRouter = require("../src/http/router");
      assert.throws(() => freshRouter({ db: conn, resolvePrincipal: () => null }), /GRIEVANCE_SLA_DAYS/);
    } finally {
      if (saved === undefined) delete process.env.GRIEVANCE_SLA_DAYS;
      else process.env.GRIEVANCE_SLA_DAYS = saved;
      delete require.cache[require.resolve("../src/config/catalog")];
      delete require.cache[require.resolve("../src/http/router")];
    }
  });
});

// ---------------------------------------------------------------------------
// Response copy (H7) and the host hooks
// ---------------------------------------------------------------------------

test("the grievance response does not claim delivery the toolkit cannot perform", async () => {
  await withDb(async (conn) => {
    const { call, close } = await boot(conn);
    try {
      const res = await call("POST", "/grievance", { subject: "Unwanted calls", description: "..." }, { Accept: "application/json" });
      const body = await res.json();
      assert.doesNotMatch(
        body.note,
        /has been sent/i,
        "nothing is sent - the toolkit has no outbound channel, so it must not say it was"
      );
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
      assert.equal(res.status, 201, "the grievance is already filed - notification is not the filing");
      const { refId } = await res.json();
      assert.match(refId, /^GR-/);
      const stored = await models.Grievance.findOne({ principalId, refId }).lean();
      assert.ok(stored, "the refId handed back must actually resolve, or the principal re-files a duplicate");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Read projections
// ---------------------------------------------------------------------------

test("slaDueAt is on the rights-request read path - a principal must be able to see when it is due", async () => {
  await withDb(async (conn) => {
    const { call, close } = await boot(conn);
    try {
      const { refId } = await (await call("POST", "/rights/exercise", { right: "access" }, { Accept: "application/json" })).json();

      const one = await (await call("GET", `/rights/requests/${refId}`, undefined, { Accept: "application/json" })).json();
      assert.ok(one.slaDueAt, "getRightsRequest must surface slaDueAt, as getGrievance already does");

      const rows = await (await call("GET", "/rights/requests", undefined, { Accept: "application/json" })).json();
      assert.ok(rows[0].slaDueAt, "listRightsRequests must surface slaDueAt too");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// src/http/shared.js - the three pieces both routers need
//
// The origin check is a security control, and a security control duplicated
// across two routers drifts. These assertions pin the extracted contract; the
// seven origin tests above pin the behaviour end to end through a real server.
// ---------------------------------------------------------------------------

test("shared.js exports wrap, errorMapper and makeCheckOrigin, and errorMapper keeps Express's four-argument arity", () => {
  const { wrap, errorMapper, makeCheckOrigin } = require("../src/http/shared");

  assert.equal(typeof wrap, "function");
  assert.equal(typeof errorMapper, "function");
  assert.equal(typeof makeCheckOrigin, "function");
  assert.equal(
    errorMapper.length, 4,
    "Express decides a function is an error handler by its arity alone - a three-parameter mapper is registered as ordinary middleware, never runs, and every fault falls through to Express's default HTML 500 with no warning of any kind"
  );
  assert.equal(makeCheckOrigin([]).length, 3, "the built middleware takes (req, res, next)");
});

test("makeCheckOrigin closes over the origins it was built with, and lets GET through", () => {
  const { makeCheckOrigin } = require("../src/http/shared");

  // Minimal Express stand-ins. checkOrigin reads only req.method, req.get and
  // res.status().json(), so a real server is not needed to pin the branches.
  const req = (method, origin, host = "app.example") => {
    const headers = { host };
    if (origin !== undefined) headers.origin = origin;
    return { method, get: (name) => headers[name.toLowerCase()] };
  };
  const run = (mw, r) => {
    const out = {};
    const res = {
      status(code) { out.status = code; return this; },
      json(body) { out.body = body; return this; },
    };
    mw(r, res, () => { out.nexted = true; });
    return out;
  };

  const mw = makeCheckOrigin(["https://portal.example"]);

  assert.equal(run(mw, req("GET", "https://evil.example")).nexted, true, "GET is exempt - it changes no state");
  assert.equal(run(mw, req("POST", undefined)).nexted, true, "curl sends no Origin and no Referer, and is not the threat");
  assert.equal(run(mw, req("POST", "https://app.example")).nexted, true, "the request's own host is always allowed");
  assert.equal(run(mw, req("POST", "https://portal.example")).nexted, true, "a configured origin is a union with the own host, never a replacement");

  const refused = run(mw, req("POST", "https://evil.example"));
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: "cross-origin request refused" });

  const unparseable = run(mw, req("POST", "null"));
  assert.equal(unparseable.status, 403, "the literal string null is evidence of a cross-origin or sandboxed context");
  assert.deepEqual(unparseable.body, { error: "bad origin" });

  const other = makeCheckOrigin([]);
  assert.equal(
    run(other, req("POST", "https://portal.example")).status, 403,
    "each built middleware carries its own allowlist - a second router must not inherit the first's"
  );
});
