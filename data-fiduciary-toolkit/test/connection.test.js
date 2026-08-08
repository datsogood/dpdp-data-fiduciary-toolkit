const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { connect } = require("../src/db/connection");
const { buildModels } = require("../src/models");
const { testDbUri } = require("./helpers/db");

// These tests used to each start their own MongoMemoryServer (5 total: one
// per test, plus a second in the "two connects" test), because they need
// distinct URIs and independent connections. Neither of those requires a
// distinct mongod process: testDbUri(name) gives a distinct URI (a different
// database on the one mongod scripts/test-setup.js starts for the whole
// suite), and connect()/mongoose.createConnection() always build a genuinely
// new connection object per call regardless of how many URIs point at the
// same server. Verified against src/db/connection.js: connect() has no
// connection cache to accidentally satisfy with a stale server.

test("connect returns an isolated connection, not the global mongoose default", async () => {
  const conn = await connect(testDbUri("isolated"));
  assert.notEqual(conn, mongoose.connection, "must not be the global default connection");
  assert.equal(mongoose.connection.readyState, 0, "global default must stay disconnected");
  assert.equal(conn.readyState, 1);
  await conn.close();
});

test("two connects to different URIs yield two independent connections", async () => {
  const connA = await connect(testDbUri("connA"));
  const connB = await connect(testDbUri("connB"));
  assert.notEqual(connA, connB, "a second connect must not silently return the first connection");
  await connA.close();
  await connB.close();
});

test("sanitizeFilter is scoped to our connection and does not break a host app's queries", async () => {
  // A host application, using the global mongoose default connection, on its
  // own database - not ours, but the same shared mongod.
  const hostConn = await mongoose.createConnection(testDbUri("host")).asPromise();
  const Host = hostConn.model("HostThing", new mongoose.Schema({ age: Number }));
  await Host.create([{ age: 10 }, { age: 20 }]);

  const ours = await connect(testDbUri("ours"));

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

  await ours.close();
  await hostConn.close();
});

test("buildModels binds models to the given connection and does not pollute the global registry", async () => {
  const conn = await connect(testDbUri("buildModels"));
  const models = buildModels(conn);
  assert.equal(models.ConsentRecord.db, conn);
  assert.ok(!mongoose.models.ConsentRecord, "global mongoose registry must stay clean");
  await conn.close();
});
