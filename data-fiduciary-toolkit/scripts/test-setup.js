// Global setup/teardown for `node --test` (--test-global-setup=scripts/test-setup.js).
// Node runs globalSetup once in the parent process before any test file is
// forked, and globalTeardown once after all forked test processes finish -
// verified against the actual Node v26.3.1 binary, since this contract is
// easy to get wrong by name (it is globalSetup/globalTeardown, not
// setup/teardown or a default export).
//
// This starts exactly one mongod for the entire suite and puts its URI on
// MONGO_TEST_URI, which every forked test process inherits from the parent
// environment. That replaces the previous one-server-per-test-file pooling
// in test/helpers/db.js, which silently grew from 8 to 11 servers as test
// files were added and, combined with the 5 servers test/connection.test.js
// started directly, produced 16 mongod instances racing for random free
// ports with no retry on collision (mongodb-memory-server-core's
// MongoInstance.js does not retry a busy port - it emits a fatal error).
//
// The version is pinned so the binary cache key is stable and a first run
// on a clean machine is deterministic, rather than resolving "latest" at
// runtime. This matches what is already cached at ~/.cache/mongodb-binaries.
const { MongoMemoryServer } = require("mongodb-memory-server");

const MONGOD_VERSION = "7.0.24";

let server;

async function globalSetup() {
  server = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
  process.env.MONGO_TEST_URI = server.getUri();
}

async function globalTeardown() {
  if (server) await server.stop();
}

module.exports = { globalSetup, globalTeardown };
