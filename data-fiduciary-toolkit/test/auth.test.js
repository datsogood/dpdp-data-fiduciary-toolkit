const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
const { buildModels } = require("../src/models");
const createRouter = require("../src/http/router");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };

/** Boots an app with the given options and returns a fetch helper. */
async function app(conn, opts = {}) {
  const a = express();
  a.use("/dpdp", createRouter({ db: conn, ...opts }));
  const server = a.listen(0);
  const port = server.address().port;
  return {
    call: (method, path, body, headers = {}) =>
      fetch(`http://localhost:${port}/dpdp${path}`, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    form: (method, path, fields) =>
      fetch(`http://localhost:${port}/dpdp${path}`, {
        method,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(fields),
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test("createRouter requires a db handle", () => {
  assert.throws(() => createRouter({}), /db is required/);
});

test("every mutating route is 401 when no resolvePrincipal is supplied", async () => {
  await withDb(async (conn) => {
    const { call, close } = await app(conn);
    try {
      const cases = [
        ["PUT", "/consent", { consentTypes: ["marketing"] }],
        ["PUT", "/consent/withdraw", { consentTypes: ["marketing"] }],
        ["POST", "/consent/withdraw", { consentTypes: ["marketing"] }],
        ["POST", "/rights/exercise", { right: "erasure" }],
        ["POST", "/grievance", { subject: "s", description: "d" }],
        ["POST", "/consent-manager", { message: "m" }],
        ["POST", "/grievance/GR-ABC/escalate", {}],
      ];
      for (const [method, path, body] of cases) {
        const res = await call(method, path, body);
        assert.equal(res.status, 401, `${method} ${path} must be 401 without auth`);
        assert.equal((await res.json()).error, "authentication required");
      }
    } finally {
      await close();
    }
  });
});

test("principalId in the request body is ignored - it never grants access", async () => {
  await withDb(async (conn) => {
    const victim = "c".repeat(64);
    const { call, close } = await app(conn, { resolvePrincipal: () => null });
    try {
      const res = await call("PUT", "/consent/withdraw", { principalId: victim, consentTypes: ["marketing"] });
      assert.equal(res.status, 401, "a body-supplied principalId must not authenticate anyone");
    } finally {
      await close();
    }
  });
});

test("POST /consent creates a new principal unauthenticated, but refuses to update an existing one", async () => {
  await withDb(async (conn) => {
    const { call, close } = await app(conn);
    try {
      const first = await call("POST", "/consent", { pii: PII, consentTypes: ["marketing"] });
      assert.equal(first.status, 201);
      const body = await first.json();
      assert.match(body.principalId, /^[a-f0-9]{64}$/);

      // The attack from C1: overwrite an existing principal's PII with no credential.
      const second = await call("POST", "/consent", {
        pii: { name: "Attacker", email: "asha@example.com", phone: "0000000000", pan: "AAAAA0000A", dob: "1980-01-01" },
        consentTypes: [],
      });
      assert.equal(second.status, 409, "must not let an unauthenticated caller overwrite existing PII");
      assert.match((await second.json()).error, /already exists/);
    } finally {
      await close();
    }
  });
});

test("a 409 on POST /consent writes nothing - the stored PII and the ledger are unchanged", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { call, close } = await app(conn);
    try {
      const first = await call("POST", "/consent", { pii: PII, consentTypes: ["marketing"] });
      assert.equal(first.status, 201);
      const { principalId } = await first.json();

      const before = {
        principal: await models.Principal.findOne({ principalId }).lean(),
        record: await models.ConsentRecord.findOne({ principalId }).lean(),
      };

      const second = await call("POST", "/consent", {
        pii: { name: "Attacker", email: "asha@example.com", phone: "0000000000", pan: "AAAAA0000A", dob: "1980-01-01" },
        consentTypes: [],
      });
      assert.equal(second.status, 409);

      const after = {
        principal: await models.Principal.findOne({ principalId }).lean(),
        record: await models.ConsentRecord.findOne({ principalId }).lean(),
      };

      // Checking the status alone is not enough. Deciding the 409 by reading
      // persistPIIwithconsent's `created` flag would return the same 409 with
      // the PII already overwritten and the ledger already appended to - the
      // C1 attack succeeding behind a passing assertion.
      assert.equal(JSON.stringify(after.principal), JSON.stringify(before.principal),
        "the existing principal's stored PII must be untouched after a 409");
      assert.equal(JSON.stringify(after.record), JSON.stringify(before.record),
        "the append-only ledger must be untouched after a 409");
      assert.equal(after.principal.pii.name, "Asha");
      assert.equal(await models.Principal.countDocuments({}), 1, "no second principal may be created either");
    } finally {
      await close();
    }
  });
});

test("the 409 does not lock out a household sharing one handset", async () => {
  await withDb(async (conn) => {
    const { call, close } = await app(conn);
    try {
      // The existence check must use the SAME matching rule as
      // findOrCreatePrincipal - email first, phone only when there is no email.
      // Matching on "either hash" would 409 the daughter for owning the same
      // phone as her mother, locking the stated audience out of registering.
      const mother = await call("POST", "/consent", {
        pii: { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1970-04-01" },
        consentTypes: ["marketing"],
      });
      assert.equal(mother.status, 201);

      const daughter = await call("POST", "/consent", {
        pii: { name: "Riya", email: "riya@example.com", phone: "9876543210", dob: "1995-06-15" },
        consentTypes: ["analytics"],
      });
      assert.equal(daughter.status, 201, "a shared phone must not be read as the same data principal");
      assert.notEqual((await daughter.json()).principalId, (await mother.json()).principalId);
    } finally {
      await close();
    }
  });
});

test("PUT /consent updates the session principal, and cannot reach another principal by email", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { call, close } = await app(conn);
    let asha;
    let bhim;
    try {
      asha = (await (await call("POST", "/consent", { pii: PII, consentTypes: ["marketing"] })).json()).principalId;
      bhim = (await (await call("POST", "/consent", {
        pii: { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" },
        consentTypes: ["analytics"],
      })).json()).principalId;
    } finally {
      await close();
    }

    // Bhim is signed in. Everything below acts as Bhim.
    const { call: asBhim, close: closeBhim } = await app(conn, { resolvePrincipal: () => bhim });
    try {
      const ok = await asBhim("PUT", "/consent", { consentTypes: ["analytics", "underwriting"] });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(body.principalId, bhim, "the update must land on the session principal");
      assert.equal(body.state.underwriting.status, "granted");

      // C1 again, merely requiring an account: pass the victim's email.
      const attack = await asBhim("PUT", "/consent", {
        pii: { name: "Bhim", email: "asha@example.com", phone: "9000000000", dob: "1985-02-02" },
        consentTypes: [],
      });
      assert.equal(attack.status, 403, "supplying another principal's contact details must be refused");

      const victim = await models.Principal.findOne({ principalId: asha }).lean();
      assert.equal(victim.pii.name, "Asha", "the victim's PII must be untouched");
      const ledger = await models.ConsentRecord.findOne({ principalId: asha }).lean();
      assert.equal(
        ledger.events.filter((e) => e.type === "marketing" && e.status === "withdrawn").length,
        0,
        "no event may be appended to the victim's ledger"
      );
    } finally {
      await closeBhim();
    }
  });
});

test("an async resolvePrincipal is awaited - a Promise must not be read as an invalid id", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    // Resolving a session to a principal is normally a database lookup.
    const { call, close } = await app(conn, {
      resolvePrincipal: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return principalId;
      },
    });
    try {
      const res = await call("PUT", "/consent/withdraw", { consentTypes: ["marketing"] });
      assert.equal(res.status, 200, "an async hook must be awaited, not 401'd as a non-string");
      assert.deepEqual((await res.json()).withdrawn, ["marketing"]);
    } finally {
      await close();
    }
  });
});

test("a form posting one ticked checkbox is accepted, and an all-unchecked one records declines", async () => {
  await withDb(async (conn) => {
    const { form, close } = await app(conn);
    try {
      // urlencoded with extended:false yields a STRING for a single value.
      const one = await form("POST", "/consent", {
        name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01",
        consentSubmitted: "1", consentTypes: "marketing",
      });
      assert.equal(one.status, 201, "a single ticked checkbox must not fail array validation");
      assert.equal((await one.json()).state.marketing.status, "granted");

      // Every box unticked. The browser sends no consentTypes field at all, so
      // without the hidden consentSubmitted marker this reads as "no consent
      // decision" and silently records nothing.
      const none = await form("POST", "/consent", {
        name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02",
        consentSubmitted: "1",
      });
      assert.equal(none.status, 201);
      const declined = await none.json();
      assert.equal(declined.state.marketing.status, "denied", "an all-unchecked form is a decline, not a no-op");
      assert.equal(declined.state.analytics.status, "denied");

      // And with no marker at all it stays a PII-only update, as the service intends.
      const piiOnly = await form("POST", "/consent", {
        name: "Chandra", email: "chandra@example.com", phone: "9111111111", dob: "1988-03-03",
      });
      assert.equal(piiOnly.status, 201);
      assert.equal((await piiOnly.json()).state.marketing, undefined,
        "omitting the marker must stay 'no consent decision', not become a decline");
    } finally {
      await close();
    }
  });
});

test("escalateToBoard refuses a refId belonging to another principal", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const owner = "d".repeat(64);
    const other = "e".repeat(64);
    const past = new Date(Date.now() - 86400000);
    await models.Grievance.create({
      principalId: owner, refId: "GR-OWNED", subject: "s", description: "d",
      addressedTo: "DPO", status: "open", slaDueAt: past,
    });

    const { call, close } = await app(conn, { resolvePrincipal: () => other });
    try {
      const res = await call("POST", "/grievance/GR-OWNED/escalate", {});
      assert.equal(res.status, 403, "a different principal must not escalate someone else's grievance");
      const still = await models.Grievance.findOne({ refId: "GR-OWNED" });
      assert.equal(still.status, "open", "the grievance must not be mutated");
      assert.equal(still.escalatedToBoard, false);
    } finally {
      await close();
    }

    const { call: asOwner, close: closeOwner } = await app(conn, { resolvePrincipal: () => owner });
    try {
      const res = await asOwner("POST", "/grievance/GR-OWNED/escalate", {});
      assert.equal(res.status, 200, "the owner must still be able to escalate");
      assert.equal((await res.json()).status, "escalated");
    } finally {
      await closeOwner();
    }
  });
});

test("an AppError carrying a 500 does not echo its message", async () => {
  await withDb(async (conn) => {
    const { call, close } = await app(conn);
    const savedSecret = process.env.PRINCIPAL_ID_SECRET;
    const savedError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
      // utils/principalId.js throws AppError(..., 500) naming PRINCIPAL_ID_SECRET
      // and how to generate one. POST /consent is unauthenticated, so that
      // message is one request away from the public internet.
      delete process.env.PRINCIPAL_ID_SECRET;
      const res = await call("POST", "/consent", { pii: PII, consentTypes: [] });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, "internal error");
      assert.doesNotMatch(JSON.stringify(body), /PRINCIPAL_ID_SECRET|openssl/,
        "internal configuration detail must not reach the caller");
      assert.equal(logged.length, 1, "it must still be logged server-side");
    } finally {
      console.error = savedError;
      process.env.PRINCIPAL_ID_SECRET = savedSecret;
      await close();
    }
  });
});

test("a mongoose cast failure is a 400 naming the field, not a 500 and not the raw value", async () => {
  await withDb(async (conn) => {
    const { call, close } = await app(conn);
    try {
      // pii.address is a String path; a JSON client sending a structured
      // address makes mongoose fail the cast. That is the caller's fault, and
      // reporting it as 500 would repeat M6 in the opposite direction.
      const res = await call("POST", "/consent", {
        pii: { ...PII, address: { line1: "12 Nehru Marg", city: "Pune" } },
        consentTypes: [],
      });
      assert.equal(res.status, 400, "a bad field value is a client error");
      const body = await res.json();
      assert.match(body.error, /pii\.address/);
      assert.doesNotMatch(body.error, /Nehru Marg/, "mongoose's raw text echoes the value back");
    } finally {
      await close();
    }
  });
});
