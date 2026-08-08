// Downloads and extracts the mongod binary once, before node --test forks a
// process per test file. Without this, a cold cache means every file races
// for ~/.cache/mongodb-binaries/<version>.lock and the losers fail their
// first test - so a fresh clone's first `npm test` fails and the second
// passes.
//
// Lives under scripts/, not test/helpers/ - node --test treats every file
// inside any directory literally named "test" as a test file in its own
// right, even one with no test() calls in it (this is why test/helpers/db.js
// already shows up as its own passing "test" in the suite's totals). Putting
// this file there would have added a second such phantom entry.
const { MongoMemoryServer } = require("mongodb-memory-server");

(async () => {
  const server = await MongoMemoryServer.create();
  await server.stop();
})().catch((err) => {
  console.error("could not prepare the in-memory MongoDB binary:", err);
  process.exit(1);
});
