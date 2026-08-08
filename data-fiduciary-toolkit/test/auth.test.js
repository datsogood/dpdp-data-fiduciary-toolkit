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

test("principalId in the request body is ignored by an AUTHENTICATED handler too", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
    const asha = (await persistPIIwithconsent({ models, pii: PII, consentTypes: [] })).principalId;
    const bhim = (
      await persistPIIwithconsent({
        models,
        pii: { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" },
        consentTypes: [],
      })
    ).principalId;

    // Signed in as Bhim. The 401 case above never reaches a handler, so it
    // cannot show that a handler ignores the body - this one can.
    const { call, close } = await app(conn, { resolvePrincipal: () => bhim });
    try {
      const res = await call("POST", "/grievance", {
        principalId: asha,
        subject: "filed in someone else's name",
        description: "d",
      });
      assert.equal(res.status, 201);
      const { refId } = await res.json();
      const stored = await models.Grievance.findOne({ refId });
      assert.equal(stored.principalId, bhim, "the grievance must be attributed to the session, not the body");
      assert.equal(await models.Grievance.countDocuments({ principalId: asha }), 0,
        "nothing may be filed against the principal named in the body");
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

test("the 409 does not lock out two household members who have NO email at all", async () => {
  // The test above gives both women their own email, which is why it passed
  // while this one - the case the stated audience actually lives in - did not.
  // With phoneHash in the existence check, the second phone-only registration
  // matched the first person's document and 409'd, leaving her permanently
  // unable to register over HTTP.
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { call, close } = await app(conn);
    try {
      const mother = await call("POST", "/consent", {
        pii: { name: "Asha", phone: "9876543210", dob: "1970-04-01" },
        consentTypes: ["marketing"],
      });
      assert.equal(mother.status, 201);

      const daughter = await call("POST", "/consent", {
        pii: { name: "Priya", phone: "9876543210", dob: "1995-06-15" },
        consentTypes: ["analytics"],
      });
      assert.equal(daughter.status, 201,
        "a beneficiary with no email, on a handset she shares, must still be able to register");

      const motherId = (await mother.json()).principalId;
      const daughterId = (await daughter.json()).principalId;
      assert.notEqual(daughterId, motherId);
      assert.equal(await models.Principal.countDocuments({}), 2);
      assert.equal((await models.Principal.findOne({ principalId: motherId })).pii.name, "Asha",
        "the second registration must not have overwritten the first person's PII");
      assert.equal(await models.ConsentRecord.countDocuments({}), 2, "each of them needs her own ledger");
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

    const ledgerBefore = await models.ConsentRecord.findOne({ principalId: asha }).lean();

    // Bhim is signed in. Everything below acts as Bhim.
    const { call: asBhim, close: closeBhim } = await app(conn, { resolvePrincipal: () => bhim });
    try {
      const before = await models.Principal.countDocuments({});
      const ok = await asBhim("PUT", "/consent", { consentTypes: ["analytics", "underwriting"] });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(body.principalId, bhim, "the update must land on the session principal");
      assert.equal(body.state.underwriting.status, "granted");
      assert.equal(body.created, false, "an authenticated update never creates a principal");
      assert.equal(await models.Principal.countDocuments({}), before,
        "an update must not mint a new principal");

      // C1 again, merely requiring an account: pass the victim's email.
      const attack = await asBhim("PUT", "/consent", {
        pii: { name: "Bhim", email: "asha@example.com", phone: "9000000000", dob: "1985-02-02" },
        consentTypes: [],
      });
      assert.equal(attack.status, 403, "supplying another principal's contact details must be refused");

      const victim = await models.Principal.findOne({ principalId: asha }).lean();
      assert.equal(victim.pii.name, "Asha", "the victim's PII must be untouched");
      const ledger = await models.ConsentRecord.findOne({ principalId: asha }).lean();
      assert.equal(ledger.events.length, ledgerBefore.events.length,
        "no event of any kind may be appended to the victim's ledger");
      assert.equal(JSON.stringify(ledger.events), JSON.stringify(ledgerBefore.events));
    } finally {
      await closeBhim();
    }
  });
});

test("PUT /consent still lands on the session principal after PRINCIPAL_ID_SECRET is rotated", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const saved = process.env.PRINCIPAL_ID_SECRET;
    const { call, close } = await app(conn);
    let principalId;
    try {
      principalId = (await (await call("POST", "/consent", { pii: PII, consentTypes: ["marketing"] })).json())
        .principalId;
    } finally {
      await close();
    }

    // Rotating the secret makes every stored emailHash stale. lookupHash reads
    // the env per call, so this is exactly what a real rotation looks like.
    // Resolving identity by contact hash here would match nothing and MINT a
    // new principal carrying this one's PII, returning a different id and
    // forking the ledger, leaving the original orphaned with live PII.
    process.env.PRINCIPAL_ID_SECRET = "a-rotated-secret-also-at-least-32-characters";
    const { call: after, close: closeAfter } = await app(conn, { resolvePrincipal: () => principalId });
    try {
      const res = await after("PUT", "/consent", { consentTypes: ["marketing", "underwriting"] });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.principalId, principalId, "a stale contact hash must not redirect the write");
      assert.equal(body.created, false);
      assert.equal(body.state.underwriting.status, "granted");
      assert.equal(await models.Principal.countDocuments({}), 1, "no second principal may be minted");
      assert.equal(await models.ConsentRecord.countDocuments({}), 1, "the ledger must not fork");
    } finally {
      process.env.PRINCIPAL_ID_SECRET = saved;
      await closeAfter();
    }
  });
});

test("a household sharing a handset cannot have an update land on the wrong member", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { call, close } = await app(conn);
    let phoneOnly;
    let housemate;
    try {
      // A phone-only principal, then a second member of the household who
      // registers the same handset with an email. phoneHash is deliberately
      // non-unique, so resolving by contact hash leaves two candidates and the
      // winner is decided by insertion order rather than by anything asserted.
      phoneOnly = (await (
        await call("POST", "/consent", {
          pii: { name: "Asha", phone: "9876543210", dob: "1970-04-01" },
          consentTypes: ["marketing"],
        })
      ).json()).principalId;

      const second = await call("POST", "/consent", {
        pii: { name: "Riya", email: "riya@example.com", phone: "9876543210", dob: "1995-06-15" },
        consentTypes: ["analytics"],
      });
      assert.equal(second.status, 201);
      // Taken from the response rather than found with { $ne: phoneOnly }: the
      // harness now builds its connection through connect(), so sanitizeFilter
      // is on here exactly as it is in production and an operator filter
      // CastErrors. That is the point - a test query the shipped library could
      // not execute is not testing the shipped library.
      housemate = (await second.json()).principalId;
    } finally {
      await close();
    }

    // Snapshot rather than assert on one event type: Riya's own signup already
    // recorded underwriting as "denied", so counting that type would fail on
    // her own history rather than on anything Asha's update did.
    assert.notEqual(housemate, phoneOnly);
    const housemateBefore = await models.ConsentRecord.findOne({ principalId: housemate }).lean();

    const { call: asAsha, close: closeAsha } = await app(conn, { resolvePrincipal: () => phoneOnly });
    try {
      const res = await asAsha("PUT", "/consent", { consentTypes: ["underwriting"] });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.principalId, phoneOnly, "the write must land on the session principal, not a housemate");
      assert.equal(body.state.underwriting.status, "granted");
      assert.equal(await models.Principal.countDocuments({}), 2);

      const housemateAfter = await models.ConsentRecord.findOne({ principalId: housemateBefore.principalId }).lean();
      assert.equal(JSON.stringify(housemateAfter.events), JSON.stringify(housemateBefore.events),
        "the housemate's ledger must be untouched");
    } finally {
      await closeAsha();
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

test("a form-encoded withdrawal with one ticked box is accepted on both methods", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
    const { principalId } = await persistPIIwithconsent({
      models,
      pii: PII,
      consentTypes: ["marketing", "analytics"],
    });

    const { form, close } = await app(conn, { resolvePrincipal: () => principalId });
    try {
      // POST exists because an HTML form cannot issue PUT, and this is the one
      // route where a wrong asArray would 400 a data principal exercising a
      // statutory right - urlencoded sends a single ticked box as a STRING.
      const posted = await form("POST", "/consent/withdraw", { consentTypes: "marketing" });
      assert.equal(posted.status, 200, "a single ticked box must not fail array validation");
      assert.deepEqual((await posted.json()).withdrawn, ["marketing"]);

      const put = await form("PUT", "/consent/withdraw", { consentTypes: "analytics" });
      assert.equal(put.status, 200);
      assert.deepEqual((await put.json()).withdrawn, ["analytics"]);

      const record = await models.ConsentRecord.findOne({ principalId });
      const state = record.currentState();
      assert.equal(state.marketing.status, "withdrawn");
      assert.equal(state.analytics.status, "withdrawn");
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
      // 404, not 403: a 403 would confirm the refId is real, turning this
      // route into an existence oracle for other principals' GR- references
      // - the same property GET /grievances/:refId is held to.
      assert.equal(res.status, 404, "a different principal must not learn this grievance exists");
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
