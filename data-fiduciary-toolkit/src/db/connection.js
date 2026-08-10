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
