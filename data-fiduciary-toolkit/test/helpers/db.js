const { MongoMemoryServer } = require("mongodb-memory-server");
const { after } = require("node:test");
const { connect } = require("../../src/db/connection");

/**
 * Runs `fn(connection)` against a throwaway in-memory MongoDB. Uses an
 * isolated connection (not the global mongoose singleton) so tests exercise
 * the same path the library uses.
 *
 * Built through the library's own connect(), NOT a bare
 * mongoose.createConnection(). connect() sets sanitizeFilter on the
 * connections it returns, and building the harness's connection by hand meant
 * the whole suite ran under query semantics production never has: an operator
 * filter that CastErrors in front of a real data principal cast cleanly here,
 * so 144 of 145 tests could not see it. Every query these tests run must be a
 * query the shipped library can actually execute.
 *
 * One server per process, not one per call. `node --test` forks one process
 * per test file, so a module-level server here is naturally one-per-file -
 * 8 instead of 76. Starting a mongod per withDb call made ports collide
 * often enough to fail whole runs.
 */
let serverPromise;
let counter = 0;

function getServer() {
  if (!serverPromise) serverPromise = MongoMemoryServer.create();
  return serverPromise;
}

async function withDb(fn) {
  const server = await getServer();
  // A fresh database per call, so isolation is unchanged - no test can see
  // another's documents, and model indexes are rebuilt per database. The
  // connection itself is also new per call, so buildModels' per-connection
  // model cache and each model's Model.init() index-build promise are fresh
  // too - neither can leak state from a previous database.
  const dbName = `t${process.pid}_${counter++}`;
  const conn = await connect(server.getUri(dbName));
  try {
    return await fn(conn);
  } finally {
    await conn.dropDatabase().catch(() => {});
    await conn.close();
  }
}

// Stop the shared server after this file's tests finish, so no mongod is
// left running once the process exits. `after()` (not process.on("exit"))
// because the exit event only allows synchronous work - stopping mongod is
// async - and after() is guaranteed by node --test to run once, after every
// test in this file has settled, before the process moves on.
after(async () => {
  if (serverPromise) {
    const server = await serverPromise;
    await server.stop();
  }
});

module.exports = { withDb };
