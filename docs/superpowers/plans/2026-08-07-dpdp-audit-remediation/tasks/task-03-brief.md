# Task 3 brief

Extracted from `docs/superpowers/plans/2026-08-07-dpdp-audit-remediation/plan.md`. Do not edit - regenerate if the plan changes.

## Global Constraints

These bind this task even where its steps do not repeat them.

- **Writing style:** always use a hyphen ( - ). Never an em dash or en dash. Applies to all code comments, prose, docs, and commit messages.
- **Statute citations:** the Act is the **Digital Personal Data Protection Act, 2023**. Never write "DPDP Act, 2025". The DPDP Rules, 2025 are a separate instrument and must be cited by their own name where referenced.
- **License:** `Apache-2.0`. The root `LICENSE` file (Apache 2.0) is authoritative; `package.json` must declare `"license": "Apache-2.0"`.
- **No secrets in source:** every org-specific value comes from an env var with a documented default. A placeholder default that would be shown to a data principal must fail startup instead.
- **`principalId` is never read from `req.body` or `req.query` on any route.** It comes only from `resolvePrincipal(req)`. Services still accept it as a parameter so they stay framework-agnostic.
- **Every value that reaches a Mongoose query filter must be validated as a primitive first.** Per-field validation in `src/utils/validate.js` is the primary control. `sanitizeFilter` is defence in depth and **must be set on the library's own connection only** - `connection.set("sanitizeFilter", true)`. **Never `mongoose.set("sanitizeFilter", true)`**: verified against mongoose 8.24 by executing real queries, that global setting makes a host application's own `Model.find({ age: { $gt: 5 } })` throw `CastError`, which is precisely the global-singleton hijack H8 exists to eliminate. Also verified: per-query `.setOptions({ sanitizeFilter: true })` does **not** sanitize and is silently inert - do not use it.
- **The consent ledger is append-only.** No code path may delete or mutate an existing event. Erasure removes PII from `Principal`, never events from `ConsentRecord`.
- **Test commands:** `npm test` runs the whole suite via bare `node --test` (no path argument). **Verified in this environment (Node v26.3.1): `node --test test/` FAILS** - it treats the positional `test/` as a module to load and reports a phantom failing test regardless of the real suite. Bare `node --test` discovers `test/**/*.test.js` correctly and treats `test/helpers/db.js` as a zero-test file. To run one file, invoke it directly: `node --test test/validate.test.js`. **Never write `npm test -- test/<file>`** - npm appends the argument, producing the broken two-path form. Every task that changes behaviour ships tests in the same commit.
- **Commit style:** conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`). Every commit message body ends with the two trailer lines used in this repo:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K
  ```
- **Working directory:** all paths below are relative to `data-fiduciary-toolkit/` unless prefixed with `repo-root:`.
- **Finding IDs** (`C1`, `H5`, `M12`, `L3` ...) refer to [`spec.md`](spec.md) beside this plan. Every task lists the findings it closes; a task is not complete until each listed finding is actually addressed.

---

### Task 3: Isolated connection and per-connection model registry

**Closes:** H8, M10

**Files:**
- Rewrite: `src/db/connection.js`
- Create: `src/models/index.js`
- Modify: all four files in `src/models/` (export schema-and-factory, not a global model)
- Create: `test/connection.test.js`
- Modify: `src/index.js`

**Interfaces:**
- Consumes: `withDb` from T2.
- Produces:
  - `connect(uri)` returns a **mongoose Connection** (not the global singleton) with `connection.models` populated. Callers pass it to `createRouter({ db })`.
  - `buildModels(connection)` returns `{ Principal, ConsentRecord, RightsRequest, Grievance, ConsentManagerRequest }` bound to that connection. `Principal` is added in T4 - until then the object has four keys.
  - Every model file exports `{ schema, build(connection) }`.

- [ ] **Step 1: Write the failing test `test/connection.test.js`**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connection");
const { buildModels } = require("../src/models");

test("connect returns an isolated connection, not the global mongoose default", async () => {
  const server = await MongoMemoryServer.create();
  let conn;
  try {
    conn = await connect(server.getUri());
    assert.notEqual(conn, mongoose.connection, "must not be the global default connection");
    assert.equal(mongoose.connection.readyState, 0, "global default must stay disconnected");
    assert.equal(conn.readyState, 1);
  } finally {
    // Close in finally, not in the try: a failing assertion would otherwise
    // leak the connection, and stopping the in-memory server does not close
    // the client side.
    if (conn) await conn.close();
    await server.stop();
  }
});

test("two connects to different URIs yield two independent connections", async () => {
  const a = await MongoMemoryServer.create();
  const b = await MongoMemoryServer.create();
  let connA, connB;
  try {
    connA = await connect(a.getUri());
    connB = await connect(b.getUri());
    assert.notEqual(connA, connB, "a second connect must not silently return the first connection");
  } finally {
    if (connA) await connA.close();
    if (connB) await connB.close();
    await a.stop();
    await b.stop();
  }
});

test("sanitizeFilter is scoped to our connection and does not break a host app's queries", async () => {
  const server = await MongoMemoryServer.create();
  let hostConn, ours;
  try {
    // A host application, using the global mongoose default connection.
    hostConn = await mongoose.createConnection(server.getUri()).asPromise();
    const Host = hostConn.model("HostThing", new mongoose.Schema({ age: Number }));
    await Host.create([{ age: 10 }, { age: 20 }]);

    ours = await connect(server.getUri());

    // The host's legitimate operator query must still work.
    const found = await Host.find({ age: { $gt: 5 } });
    assert.equal(found.length, 2, "requiring this library must not break a host app's operator queries");

    // Ours must reject an operator object.
    const models = buildModels(ours);
    await assert.rejects(
      () => models.ConsentRecord.findOne({ principalId: { $gt: "" } }),
      (err) => err.name === "CastError",
      "our own connection must sanitize operator filters"
    );

  } finally {
    if (ours) await ours.close();
    if (hostConn) await hostConn.close();
    await server.stop();
  }
});

test("buildModels binds models to the given connection and does not pollute the global registry", async () => {
  const server = await MongoMemoryServer.create();
  let conn;
  try {
    conn = await connect(server.getUri());
    const models = buildModels(conn);
    assert.equal(models.ConsentRecord.db, conn);
    assert.ok(!mongoose.models.ConsentRecord, "global mongoose registry must stay clean");
  } finally {
    if (conn) await conn.close();
    await server.stop();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/connection.test.js`
Expected: FAIL - the current `connect` returns `mongoose.connection`.

- [ ] **Step 3: Rewrite `src/db/connection.js`**

```js
const mongoose = require("mongoose");
const { AppError } = require("../utils/errors");

/**
 * Opens an isolated connection this library owns.
 *
 * Deliberately NOT mongoose.connect(): that mutates the global default
 * connection and the global model registry, so a host application already
 * using mongoose would either fail to connect or find its own models
 * silently rebound to this library's schemas.
 *
 * Each call returns a new connection - the caller owns its lifetime and
 * should close it on shutdown.
 */
async function connect(uri = process.env.MONGO_URI) {
  if (!uri || typeof uri !== "string") {
    throw new AppError("MONGO_URI is not set - pass one explicitly or set it in the environment", 500);
  }
  const connection = mongoose.createConnection(uri);

  // Defence in depth against query-operator injection, scoped to OUR
  // connection. Deliberately not mongoose.set(...): that is global process
  // state, and it would make a host application's own
  // Model.find({ age: { $gt: 5 } }) throw CastError just because this library
  // was required. Verified: set here, the host's default connection is
  // unaffected while our queries still reject operator objects.
  //
  // The primary control remains per-field validation in utils/validate.js.
  connection.set("sanitizeFilter", true);

  await connection.asPromise();
  return connection;
}

module.exports = { connect, mongoose };
```

- [ ] **Step 4: Convert each model file to a factory**

Pattern, applied to all four. `src/models/ConsentRecord.js`:

```js
const { Schema } = require("mongoose");

// Every grant, decline AND withdrawal is its own event, never overwritten -
// this is the audit trail DPDP expects a fiduciary to be able to produce.
// This document holds NO PII: PII lives on Principal so it can be erased
// without destroying the consent evidence.
const consentEventSchema = new Schema(
  {
    type: { type: String, required: true },
    status: { type: String, enum: ["granted", "denied", "withdrawn"], required: true },
    basis: { type: String, required: true },
    lawfulBasisKind: { type: String, enum: ["consent", "legitimate_use"], required: true },
    receiptId: { type: String, required: true },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

const consentRecordSchema = new Schema({
  principalId: { type: String, required: true, unique: true, index: true },
  docRef: { type: String, required: true, unique: true },
  events: { type: [consentEventSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

/** Current status per consent type, derived from the latest event of each type. */
consentRecordSchema.methods.currentState = function currentState() {
  const latestByType = {};
  for (const event of this.events) {
    const existing = latestByType[event.type];
    if (!existing || event.timestamp >= existing.timestamp) latestByType[event.type] = event;
  }
  return latestByType;
};

module.exports = {
  schema: consentRecordSchema,
  build: (connection) => connection.model("ConsentRecord", consentRecordSchema),
};
```

Note the two new event fields (`lawfulBasisKind`, `receiptId`) - T6 and T7 populate them. `status` gains `denied` (M5). The `pii` block is **removed** here; T4 moves it to `Principal`.

Apply the same `{ schema, build }` shape to `RightsRequest.js`, `Grievance.js`, `ConsentManagerRequest.js`, keeping their existing fields plus the T2 `maxlength` caps.

- [ ] **Step 5: Write `src/models/index.js`**

```js
const ConsentRecord = require("./ConsentRecord");
const RightsRequest = require("./RightsRequest");
const Grievance = require("./Grievance");
const ConsentManagerRequest = require("./ConsentManagerRequest");

/**
 * Binds every model to one connection and caches the registry on it, so
 * repeated calls with the same connection return the same model objects
 * (mongoose throws on re-registering a model name).
 */
function buildModels(connection) {
  if (!connection || typeof connection.model !== "function") {
    throw new Error("buildModels requires a mongoose Connection - pass the value returned by connect()");
  }
  if (connection.$dpdpModels) return connection.$dpdpModels;

  const models = {
    ConsentRecord: ConsentRecord.build(connection),
    RightsRequest: RightsRequest.build(connection),
    Grievance: Grievance.build(connection),
    ConsentManagerRequest: ConsentManagerRequest.build(connection),
  };
  connection.$dpdpModels = models;
  return models;
}

module.exports = { buildModels };
```

- [ ] **Step 6: Thread `models` through every service**

Each service takes `models` as its first destructured parameter instead of importing a model at module scope. Signatures become:

```js
persistPIIwithconsent({ models, pii, consentTypes, regrant })
withdrawConsent({ models, principalId, consentTypes })
exerciseRight({ models, principalId, right, details })
complaintToTheBoard({ models, principalId, subject, description })
escalateToBoard({ models, refId, principalId })
consentManagerRequest({ models, principalId, message, preferredConsentManager })
```

- [ ] **Step 7: Update `src/index.js` to export `buildModels`**

```js
const { connect } = require("./db/connection");
const { buildModels } = require("./models");
...
module.exports = { connect, buildModels, /* ...services, createRouter, config */ };
```

- [ ] **Step 8: Run the tests**

Also rewrite `test/injection.test.js` to use the registry: delete its inline `modelsFor` helper and the `Schema` import, `require("../src/models")`, and call `buildModels(conn)`. Add `lawfulBasisKind: "consent"` and `receiptId: "RC-TEST"` to the seeded event so it satisfies the tightened schema.

Run: `npm test`
Expected: `test/connection.test.js` 4/4 PASS, `test/validate.test.js` 4/4 PASS, `test/injection.test.js` 1/1 PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: own an isolated connection and model registry

Closes H8, M10.

The library called mongoose.connect() and registered models on the global
mongoose singleton, so the integration the README documents - dropping the
router into an existing Express app - either failed to connect or silently
rebound a host app's same-named models to this library's schemas. The
connected flag also made a second connect() with a different URI return
the first connection.

- connect() returns a dedicated mongoose.createConnection()
- models become { schema, build(connection) } factories
- buildModels(connection) caches a per-connection registry
- services take models as a parameter instead of importing globals
- ConsentRecord drops its pii block (moves to Principal in the next task)
  and gains the denied status plus lawfulBasisKind and receiptId

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XmUWwPHKGBfo77jnx1yw3K"
```

---
