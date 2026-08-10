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
 * One mongod for the entire suite, not one per process. It is started once,
 * in the parent, by scripts/test-setup.js's globalSetup (wired in via
 * `node --test --test-global-setup=...` in the "test" script), which puts
 * its URI on MONGO_TEST_URI for every forked test process to inherit. A
 * server per test file - even pooled - still meant 11+ mongod instances
 * starting near-simultaneously and racing for random free ports with no
 * retry on collision.
 */
function testDbUri(dbName) {
  const base = process.env.MONGO_TEST_URI;
  if (!base) {
    throw new Error(
      "MONGO_TEST_URI is not set. This is set by scripts/test-setup.js via " +
        "`node --test --test-global-setup=...`, which only runs under `npm test`. " +
        "Run the suite with `npm test`, not `node --test` directly."
    );
  }
  const uri = new URL(base);
  uri.pathname = `/${dbName}`;
  return uri.toString();
}

let counter = 0;

async function withDb(fn) {
  // A fresh database per call, so isolation is unchanged - no test can see
  // another's documents, and model indexes are rebuilt per database. The
  // connection itself is also new per call, so buildModels' per-connection
  // model cache and each model's Model.init() index-build promise are fresh
  // too - neither can leak state from a previous database.
  const dbName = `t${process.pid}_${counter++}`;
  const conn = await connect(testDbUri(dbName));
  try {
    return await fn(conn);
  } finally {
    await conn.dropDatabase().catch(() => {});
    await conn.close();
  }
}

// Exported for test/connection.test.js, which needs distinct URIs and
// independent connections it manages itself (including one built with a bare
// mongoose.createConnection(), to stand in for a host app) rather than the
// fn-wrapper + auto-cleanup withDb gives everything else.
module.exports = { withDb, testDbUri };
