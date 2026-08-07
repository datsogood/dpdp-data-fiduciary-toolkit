const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connection");
const { buildModels } = require("../src/models");

test("connect returns an isolated connection, not the global mongoose default", async () => {
  const server = await MongoMemoryServer.create();
  try {
    const conn = await connect(server.getUri());
    assert.notEqual(conn, mongoose.connection, "must not be the global default connection");
    assert.equal(mongoose.connection.readyState, 0, "global default must stay disconnected");
    assert.equal(conn.readyState, 1);
    await conn.close();
  } finally {
    await server.stop();
  }
});

test("two connects to different URIs yield two independent connections", async () => {
  const a = await MongoMemoryServer.create();
  const b = await MongoMemoryServer.create();
  try {
    const connA = await connect(a.getUri());
    const connB = await connect(b.getUri());
    assert.notEqual(connA, connB, "a second connect must not silently return the first connection");
    await connA.close();
    await connB.close();
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("sanitizeFilter is scoped to our connection and does not break a host app's queries", async () => {
  const server = await MongoMemoryServer.create();
  try {
    // A host application, using the global mongoose default connection.
    const hostConn = await mongoose.createConnection(server.getUri()).asPromise();
    const Host = hostConn.model("HostThing", new mongoose.Schema({ age: Number }));
    await Host.create([{ age: 10 }, { age: 20 }]);

    const ours = await connect(server.getUri());

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
  } finally {
    await server.stop();
  }
});

test("buildModels binds models to the given connection and does not pollute the global registry", async () => {
  const server = await MongoMemoryServer.create();
  try {
    const conn = await connect(server.getUri());
    const models = buildModels(conn);
    assert.equal(models.ConsentRecord.db, conn);
    assert.ok(!mongoose.models.ConsentRecord, "global mongoose registry must stay clean");
    await conn.close();
  } finally {
    await server.stop();
  }
});
