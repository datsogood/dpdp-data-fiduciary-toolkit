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
const { buildNotice } = require("../src/config/notice");

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

test("the ledger surfaces noticeVersion per event, not just on currentState()'s latest one", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const notice = buildNotice({ language: "en" });
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"], notice });

    const view = await getConsentState({ models, principalId });
    const grant = view.ledger.find((e) => e.type === "marketing" && e.status === "granted");
    assert.equal(
      grant.noticeVersion, notice.version,
      "the full ledger must expose the same noticeVersion that currentState()'s raw event subdocuments already do"
    );
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

test("GET /consent carries Cache-Control: no-store and Vary: Cookie - PII must never be cached", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/dpdp/consent`, { headers: { Accept: "application/json" } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store",
        "a shared cache or CDN must never be told it may store this response");
      assert.equal(res.headers.get("vary"), "Cookie",
        "the URL carries no identifying component - only the session cookie distinguishes one principal's " +
          "response from another's");
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

test("GET /rights/requests/:refId and GET /grievances/:refId are 404 for a syntactically valid refId that never existed", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: [] });

    const asPrincipal = await bootApp(conn, principalId);
    try {
      const rights = await asPrincipal.call("GET", "/rights/requests/RQ-0000000000000000");
      assert.equal(rights.status, 404, "a well-formed but unknown refId must 404, same as a stranger's real one");

      const grievances = await asPrincipal.call("GET", "/grievances/GR-0000000000000000");
      assert.equal(grievances.status, 404, "a well-formed but unknown refId must 404, same as a stranger's real one");
    } finally {
      await asPrincipal.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /consent/trail - the Section 11 lineage view
// ---------------------------------------------------------------------------

test("GET /consent/trail returns the session principal's own lineage, uncacheable, with operator refs withheld", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { recordTrail, getConsentTrail } = require("../src/services/consentTrail");
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });

    // A back-office read of this principal's record, written BEFORE the
    // request. Without it this principal has only just signed up, the timeline
    // holds nothing but derived ledger entries, and NOTHING IN IT COULD CARRY
    // an actor.ref or a caseRef - so every withholding assertion below would
    // pass without the withholding ever running. This row is the only entry in
    // the fixture that has something to withhold.
    await recordTrail(models, {
      principalId,
      kind: "operator_trail_read",
      outcome: "recorded",
      actor: { role: "operator", ref: "emp-10432", channel: "api" },
      caseRef: "INC-0042199",
    });

    const asPrincipal = await bootApp(conn, principalId);
    try {
      const res = await asPrincipal.call("GET", "/consent/trail");
      assert.equal(res.status, 200);
      assert.equal(
        res.headers.get("cache-control"), "no-store",
        "the trail names every act taken about one person - a shared cache or CDN must never be told it may store it"
      );
      assert.equal(
        res.headers.get("vary"), "Cookie",
        "the URL carries no identifying component - only the session cookie distinguishes one principal's trail from another's"
      );

      const body = await res.json();
      assert.equal(body.principalId, principalId);
      assert.equal(
        body.coverageFrom, "2026-09-04",
        "a trail with nothing in it must say we were not recording before this date, never imply nothing happened"
      );
      assert.equal(body.truncated, false);
      assert.equal(typeof body.totalEntries, "number");
      assert.ok(Array.isArray(body.timeline));
      assert.ok(body.timeline.length > 0, "signing up is itself lineage - a fresh principal's trail is not empty");

      for (const entry of body.timeline) {
        assert.ok(entry.at, "every timeline entry carries an observed timestamp, stored or derived");
        assert.ok(entry.kind, "every timeline entry names what happened");
        assert.ok(
          entry.source === "stored" || entry.source === "derived",
          "a consumer must be able to tell a recorded fact from a derived one without branching on shape"
        );
        assert.ok(entry.actor && entry.actor.role && entry.actor.channel);
        assert.equal(
          entry.actor.ref, undefined,
          "a data principal may learn that a member of staff read their record, never which one - actor.ref is the adopter's own employee's personal data, held under a different basis"
        );
        assert.equal(
          entry.caseRef, undefined,
          "the adopter's own ticket reference is back-office data and is never rendered back to a data principal"
        );
      }

      // The row that makes the loop above mean something. It must be PRESENT -
      // withholding is not the same as hiding, and that a member of staff read
      // their record is precisely what a data principal is owed under Section
      // 11 - and it must arrive stripped.
      const looked = body.timeline.find((e) => e.kind === "operator_trail_read");
      assert.ok(
        looked,
        "the back-office access row is included, not filtered out - the headline of this feature is that a person can see they were looked at"
      );
      assert.equal(looked.source, "stored");
      assert.deepEqual(
        looked.actor, { role: "operator", channel: "api" },
        "role and channel survive, ref does not - the principal learns that staff read the record, never which member of staff"
      );
      assert.equal(Object.hasOwn(looked.actor, "ref"), false, "absent, not null - a null ref is still a field where an employee's id used to be");
      assert.equal(Object.hasOwn(looked, "caseRef"), false, "the ticket reference never leaves the back office");
    } finally {
      await asPrincipal.close();
    }

    // The inverse, so the two assertions above cannot pass because the read
    // simply never carried either field. The same row, read the way the back
    // office reads it, has both.
    const backOffice = await getConsentTrail({ models, principalId, includeOperatorRefs: true });
    const seen = backOffice.timeline.find((e) => e.kind === "operator_trail_read");
    assert.deepEqual(
      seen.actor, { role: "operator", ref: "emp-10432", channel: "api" },
      "includeOperatorRefs: true is the whole difference between the two reads - if this is stripped too, the route above is withholding nothing"
    );
    assert.equal(
      seen.caseRef, "INC-0042199",
      "who and why together is what makes an access record accountability rather than a counter"
    );
  });
});

test("GET /consent/trail is scoped to the session - a principalId in the query string is ignored", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId: a } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const { principalId: b } = await persistPIIwithconsent({
      models,
      pii: { name: "Bhim", email: "bhim@example.com", phone: "9000000000", dob: "1985-02-02" },
      consentTypes: ["analytics"],
    });

    let bRefId;
    const asB = await bootApp(conn, b);
    try {
      const filed = await asB.call("POST", "/rights/exercise", { right: "access" });
      assert.equal(filed.status, 201);
      ({ refId: bRefId } = await filed.json());
    } finally {
      await asB.close();
    }

    const asA = await bootApp(conn, a);
    try {
      const res = await asA.call("GET", `/consent/trail?principalId=${b}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.principalId, a, "the query string must never override the authenticated session");
      assert.equal(
        body.timeline.some((e) => e.refId === bRefId), false,
        "another principal's rights request must not appear in this trail - the scope is req.principalId and nothing else"
      );

      // Unlike principalId, ?limit= IS read from the query string - it bounds
      // an input the partition rule does not, since operator_lookup and
      // operator_trail_read rows are filed under the subject rather than the
      // acting principal. A valid value is honoured...
      const limited = await asA.call("GET", "/consent/trail?limit=1");
      assert.equal(limited.status, 200);
      const limitedBody = await limited.json();
      assert.equal(limitedBody.timeline.length, 1, "a valid ?limit= is honoured, not silently ignored the way ?principalId= is");
      assert.equal(limitedBody.truncated, true);

      // ...and a hostile or malformed one is refused with a 400 before it ever
      // reaches getConsentTrail, reusing the same assertLimit guard the read
      // already validates a direct-call limit with.
      for (const hostile of ["limit[$ne]=1", "limit=abc", "limit=-1", "limit=100000", "limit=1.5"]) {
        const bad = await asA.call("GET", `/consent/trail?${hostile}`);
        assert.equal(bad.status, 400, `?${hostile} must be refused, not coerced into a query filter or silently clamped`);
      }
    } finally {
      await asA.close();
    }
  });
});
