const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

/**
 * Runs `fn(connection)` against a throwaway in-memory MongoDB. Uses an
 * isolated connection (not the global mongoose singleton) so tests exercise
 * the same path the library uses.
 */
async function withDb(fn) {
  const server = await MongoMemoryServer.create();
  const conn = await mongoose.createConnection(server.getUri()).asPromise();
  try {
    return await fn(conn);
  } finally {
    await conn.close();
    await server.stop();
  }
}

module.exports = { withDb };
