const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { withDb } = require("./helpers/db");

process.env.PRINCIPAL_ID_SECRET = "test-secret-not-for-production-min32chars";
process.env.FIDUCIARY_DPO_EMAIL = "dpo@test.example";
const { buildModels } = require("../src/models");
const createRouter = require("../src/http/router");
const createBackOfficeRouter = require("../src/http/backOfficeRouter");
const persistPIIwithconsent = require("../src/services/persistPIIwithconsent");
const { lookupHash } = require("../src/utils/principalId");

const PII = { name: "Asha", email: "asha@example.com", phone: "9876543210", dob: "1990-04-01" };
const OPERATOR = { actorRef: "staff-4471" };

/**
 * Mounts the back-office router on an ephemeral port. Options are spread LAST
 * on purpose, so a test can pass `resolveOperator: undefined` and actually get
 * no hook - a default parameter would silently reinstate one, and "fails
 * closed with no hook configured" is one of the things under test.
 */
async function bootBackOffice(conn, opts = {}) {
  const models = buildModels(conn);
  const app = express();
  app.use(
    "/back-office",
    createBackOfficeRouter({ db: conn, rateLimitedByHost: true, resolveOperator: () => OPERATOR, ...opts })
  );
  const server = app.listen(0);
  const port = server.address().port;
  return {
    models,
    call: (path, body) =>
      fetch(`http://localhost:${port}/back-office${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test("the back-office factory refuses to build without an explicit rate-limiting acknowledgement", async () => {
  await withDb(async (conn) => {
    assert.throws(
      () => createBackOfficeRouter({ db: conn, resolveOperator: () => OPERATOR }),
      /express-rate-limit/,
      "this router is a people-search over a guessable keyspace and the package ships no rate limiting, so the acknowledgement is the whole point of the guard"
    );
    for (const bad of [false, "true", 1, null]) {
      assert.throws(
        () => createBackOfficeRouter({ db: conn, resolveOperator: () => OPERATOR, rateLimitedByHost: bad }),
        /rateLimitedByHost/,
        `rateLimitedByHost: ${JSON.stringify(bad)} is not an acknowledgement - only the literal true is`
      );
    }
    assert.equal(
      typeof createBackOfficeRouter({ db: conn, resolveOperator: () => OPERATOR, rateLimitedByHost: true }),
      "function",
      "with the acknowledgement it must build - if this throws, every assertion above is passing for the wrong reason"
    );
  });
});

test("the back-office factory requires a db handle and a string allowedOrigins list, like createRouter", async () => {
  await withDb(async (conn) => {
    assert.throws(
      () => createBackOfficeRouter({ resolveOperator: () => OPERATOR, rateLimitedByHost: true }),
      /db is required/
    );
    assert.throws(
      () => createBackOfficeRouter({ db: conn, resolveOperator: () => OPERATOR, rateLimitedByHost: true, allowedOrigins: [1] }),
      /allowedOrigins/
    );
  });
});

// ---------------------------------------------------------------------------
// Operator authentication - fail closed, and never crash
// ---------------------------------------------------------------------------

test("with no resolveOperator configured every back-office route denies - a misconfigured mount fails closed", async () => {
  await withDb(async (conn) => {
    const bo = await bootBackOffice(conn, { resolveOperator: undefined });
    try {
      for (const path of ["/principals/lookup", "/principals/trail"]) {
        const res = await bo.call(path, { email: PII.email, principalId: "a".repeat(64) });
        assert.equal(res.status, 401, `${path} must deny when there is no staff auth hook at all`);
        assert.deepEqual(await res.json(), { error: "operator authentication required" });
      }
      assert.equal(
        await bo.models.TrailEntry.countDocuments({}),
        0,
        "a request that never got past authentication disclosed nothing, so it must record nothing - otherwise an unauthenticated caller can append rows to the accountability record"
      );
    } finally {
      await bo.close();
    }
  });
});

test("a hostile or throwing resolveOperator denies with 401 and does not crash the process", async () => {
  await withDb(async (conn) => {
    const hooks = [
      ["throws synchronously", () => { throw new Error("staff session store is down"); }],
      ["rejects", async () => { throw new Error("staff session store is down"); }],
      ["returns null", () => null],
      ["returns undefined", () => undefined],
      ["returns a bare string instead of an object", () => "staff-4471"],
      ["returns an operator payload as the ref", () => ({ actorRef: { $ne: null } })],
      ["returns a ref containing a space", () => ({ actorRef: "asha patel" })],
      ["returns an email address as the ref", () => ({ actorRef: "asha@example.com" })],
      ["throws from an actorRef getter", () => ({ get actorRef() { throw new Error("boom"); } })],
    ];
    for (const [label, resolveOperator] of hooks) {
      const bo = await bootBackOffice(conn, { resolveOperator });
      try {
        const res = await bo.call("/principals/lookup", { email: PII.email });
        assert.equal(res.status, 401, `a hook that ${label} must produce a 401`);
        assert.equal(
          await bo.models.TrailEntry.countDocuments({}),
          0,
          `a hook that ${label} disclosed nothing, so it must have recorded nothing`
        );
      } finally {
        await bo.close();
      }
    }

    // The whole point of putting the shape check inside the try/catch: after
    // nine hostile hooks the process is still up and a good one still works.
    const ok = await bootBackOffice(conn);
    try {
      const res = await ok.call("/principals/lookup", { email: "nobody@example.com" });
      assert.equal(res.status, 404, "a hostile hook must not have taken the router down with it");
    } finally {
      await ok.close();
    }
  });
});

test("the actorRef recorded is the one that was validated - a shifting getter cannot swap it after the check", async () => {
  await withDb(async (conn) => {
    let reads = 0;
    const shifty = {
      get actorRef() {
        reads += 1;
        return reads === 1 ? "staff-4471" : { $ne: null };
      },
    };
    const bo = await bootBackOffice(conn, { resolveOperator: () => shifty });
    try {
      const res = await bo.call("/principals/lookup", { email: "nobody@example.com" });
      assert.equal(res.status, 404);
      const rows = await bo.models.TrailEntry.find({}).lean();
      assert.equal(rows.length, 1);
      assert.equal(
        rows[0].actor.ref,
        "staff-4471",
        "the value must be copied into a local and validated there - re-reading the property after the check is what lets a getter hand over something else"
      );
      assert.equal(reads, 1, "reading actorRef more than once is exactly the defect this test exists to catch");
    } finally {
      await bo.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /principals/lookup
// ---------------------------------------------------------------------------

test("a back-office lookup records the disclosure before it answers - a hit files under principalId, a miss files no subject at all", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const bo = await bootBackOffice(conn);
    try {
      const hit = await bo.call("/principals/lookup", { email: PII.email, caseRef: "TKT-90210" });
      assert.equal(hit.status, 200);
      assert.deepEqual(
        await hit.json(),
        { principalId },
        "a lookup answers with the principalId and nothing else - name, phone, dob and PAN are not part of finding someone"
      );

      const miss = await bo.call("/principals/lookup", { email: "nobody@example.com", caseRef: "TKT-90211" });
      assert.equal(miss.status, 404);

      const rows = await models.TrailEntry.find({}).lean();
      assert.equal(rows.length, 2, "both the hit and the miss are uses of the surface, and both are recorded");
      const hitRow = rows.find((r) => r.reasonCode === undefined);
      const missRow = rows.find((r) => r.reasonCode === "no_match");
      assert.ok(hitRow && missRow, "one row for the hit, one for the miss, distinguished by reasonCode");

      assert.equal(hitRow.kind, "operator_lookup");
      assert.equal(hitRow.outcome, "recorded");
      assert.equal(hitRow.principalId, principalId);
      assert.equal(hitRow.caseRef, "TKT-90210", "the record must say which ticket the access was for, not only who made it");
      assert.deepEqual(
        { role: hitRow.actor.role, ref: hitRow.actor.ref, channel: hitRow.actor.channel },
        { role: "operator", ref: "staff-4471", channel: "api" }
      );

      assert.equal(missRow.kind, "operator_lookup");
      assert.equal(
        missRow.outcome,
        "refused",
        "an auditor reading 'recorded' here could not tell a probe from someone's whole lineage having been read - the same rule the trail route's miss branch already follows"
      );
      assert.equal(
        missRow.principalId,
        undefined,
        "a lookup that matched nobody has no data principal to file under, and inventing one would be a claim the record cannot back"
      );

      // THE CENTRAL PRIVACY INVARIANT. A row carrying the contact hash beside
      // the principalId would rebuild the email-to-person index erasure exists
      // to destroy; a row carrying it on a miss would mint a permanent
      // contact-derived identifier for someone who is not a data principal of
      // this fiduciary at all.
      const dump = JSON.stringify(rows);
      assert.doesNotMatch(
        dump,
        new RegExp(lookupHash(PII.email)),
        "the hash of a matched address must appear nowhere in the trail - the fiduciary holds PRINCIPAL_ID_SECRET and could recompute it to rejoin an erased person to their surviving record"
      );
      assert.doesNotMatch(
        dump,
        new RegExp(lookupHash("nobody@example.com")),
        "the hash of an address that matched nobody must appear nowhere - there is no lawful basis for retaining an identifier for a person this fiduciary has no relationship with"
      );
      assert.doesNotMatch(dump, /asha@example\.com|nobody@example\.com/, "and no raw address either");
    } finally {
      await bo.close();
    }
  });
});

test("the back-office lookup is email only - it refuses to search by phone number", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const bo = await bootBackOffice(conn);
    try {
      const res = await bo.call("/principals/lookup", { phone: PII.phone });
      assert.equal(res.status, 400, "one handset can belong to a whole household, so a number identifies nobody on its own");
      const body = await res.json();
      assert.match(body.error, /email/);
      assert.equal(await models.TrailEntry.countDocuments({}), 0, "a refused request disclosed nothing and records nothing");
    } finally {
      await bo.close();
    }
  });
});

test("operator payloads are refused at every back-office entry point, and refusing one records nothing", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const bo = await bootBackOffice(conn);
    const before = await models.TrailEntry.countDocuments({});
    try {
      for (const payload of [{ $ne: null }, { $gt: "" }, { $regex: ".*" }]) {
        const lookup = await bo.call("/principals/lookup", { email: payload });
        assert.equal(lookup.status, 400, `email: ${JSON.stringify(payload)} must be refused, never run as a filter`);

        const trail = await bo.call("/principals/trail", { principalId: payload });
        assert.equal(trail.status, 400, `principalId: ${JSON.stringify(payload)} must be refused, never run as a filter`);
      }
      // caseRef reaches a stored field, so it is guarded as a primitive too.
      const badCase = await bo.call("/principals/lookup", { email: PII.email, caseRef: { $ne: null } });
      assert.equal(badCase.status, 400, "caseRef is written to the record, so it is validated before it gets there");

      assert.equal(
        await models.TrailEntry.countDocuments({}),
        before,
        "nothing was disclosed, so nothing is recorded - a refused payload must not become a way to append rows"
      );
      assert.ok(
        await models.Principal.findOne({ principalId }),
        "setup check - the data principal an operator filter would have matched must actually be on file, or these refusals prove nothing"
      );
    } finally {
      await bo.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /principals/trail
// ---------------------------------------------------------------------------

test("POST /principals/trail records the read first, then answers with the trail including operator refs", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const bo = await bootBackOffice(conn);
    try {
      const res = await bo.call("/principals/trail", { principalId, caseRef: "TKT-90212" });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.principalId, principalId);
      assert.equal(
        body.coverageFrom,
        "2026-09-04",
        "a trail with nothing in it must be able to say we were not recording before this date, rather than implying nothing happened"
      );
      assert.ok(Array.isArray(body.timeline));

      const rows = await models.TrailEntry.find({ kind: "operator_trail_read" }).lean();
      assert.equal(rows.length, 1, "reading someone's trail is itself a disclosure and is itself recorded");
      assert.equal(rows[0].principalId, principalId);
      assert.equal(rows[0].outcome, "recorded");
      assert.equal(
        rows[0].reasonCode,
        undefined,
        "a real disclosure carries no reasonCode - that field exists to say why access was refused, not to annotate a success"
      );
      assert.equal(rows[0].caseRef, "TKT-90212");
      assert.equal(rows[0].actor.ref, "staff-4471");

      // The rows already written are visible to the next read, and on THIS
      // surface they carry actor.ref. That is the only difference between the
      // back-office read and the data principal's own.
      //
      // TWO rows, not one, and the count is the assertion: the route records
      // the read BEFORE it performs it, so the second call writes its own row
      // and then reads a trail containing both. A 1 here would mean the record
      // is being written after the disclosure, at which point a failed write
      // could no longer stop the data going out - which is the whole of D7.
      const second = await bo.call("/principals/trail", { principalId });
      const seen = (await second.json()).timeline.filter((e) => e.kind === "operator_trail_read");
      assert.equal(seen.length, 2, "the first read and the second read's own row are both in the second read's timeline");
      assert.ok(
        seen.every((e) => e.actor.ref === "staff-4471"),
        "includeOperatorRefs: true is what distinguishes this read from the principal's own, where the ref is withheld"
      );
      assert.ok(
        seen.some((e) => e.caseRef === "TKT-90212"),
        "and the first read's ticket reference survives into the timeline, so the back office can see which case an access was for"
      );
    } finally {
      await bo.close();
    }
  });
});

test("POST /principals/trail 404s for an id with no data principal behind it, and records the attempt anyway", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const bo = await bootBackOffice(conn);
    try {
      const res = await bo.call("/principals/trail", { principalId: "c".repeat(64) });
      assert.equal(res.status, 404);
      const rows = await models.TrailEntry.find({ kind: "operator_trail_read" }).lean();
      assert.equal(
        rows.length,
        1,
        "an operator who probes an id that does not exist has still used this surface - a 404 that left no trace would be the one way to use it unrecorded"
      );
      assert.equal(
        rows[0].outcome,
        "refused",
        "a probe of an id with nothing behind it must not be recorded as a disclosure - an auditor reading 'recorded' here could not tell a probe from someone's whole lineage having been read"
      );
      assert.equal(rows[0].reasonCode, "no_match", "the same reasonCode the lookup route's miss branch uses, for the same reason: nothing was found");
    } finally {
      await bo.close();
    }
  });
});

test("no disclosure without a record - a failed access write is a 503 and returns no principal data", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const bo = await bootBackOffice(conn);

    // recordTrailStrict writes through models.TrailEntry.create. Patching it
    // is the only way to make the access write fail without breaking the
    // database out from under the rest of the request. The patch lives on a
    // model bound to this test's throwaway connection, so it cannot leak.
    const realCreate = models.TrailEntry.create;
    let attempted = 0;
    models.TrailEntry.create = async () => {
      attempted += 1;
      throw new Error("trailentries is unwritable");
    };

    try {
      const lookup = await bo.call("/principals/lookup", { email: PII.email });
      assert.equal(lookup.status, 503, "an unaudited people-search is worse than no people-search: no record, no disclosure");
      const lookupBody = await lookup.text();
      assert.doesNotMatch(
        lookupBody,
        new RegExp(principalId),
        "the principalId must not come back when the access could not be recorded"
      );

      const trail = await bo.call("/principals/trail", { principalId });
      assert.equal(trail.status, 503);
      const trailBody = await trail.text();
      assert.doesNotMatch(trailBody, new RegExp(principalId));
      assert.doesNotMatch(trailBody, /marketing|timeline/, "no part of the trail may be disclosed when the access could not be recorded");

      assert.equal(
        attempted,
        2,
        "both routes must have attempted the access write before answering - if this is 0, the write is not on the path this test believes it is"
      );
    } finally {
      models.TrailEntry.create = realCreate;
      await bo.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The two surfaces stay separate
// ---------------------------------------------------------------------------

test("a back-office route is not reachable on createRouter - the two surfaces never share a mount", async () => {
  await withDb(async (conn) => {
    const models = buildModels(conn);
    const { principalId } = await persistPIIwithconsent({ models, pii: PII, consentTypes: ["marketing"] });
    const before = await models.TrailEntry.countDocuments({});

    const app = express();
    app.use("/dpdp", createRouter({ db: conn, resolvePrincipal: () => principalId }));
    const server = app.listen(0);
    const port = server.address().port;
    try {
      for (const path of ["/principals/lookup", "/principals/trail"]) {
        const res = await fetch(`http://localhost:${port}/dpdp${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ email: PII.email, principalId }),
        });
        assert.equal(
          res.status,
          404,
          `${path} must not exist on the principal-facing router - a data principal must never be able to look another one up`
        );
      }
      assert.equal(
        await models.TrailEntry.countDocuments({}),
        before,
        "and reaching for a back-office route on the wrong router must not have recorded anything"
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
