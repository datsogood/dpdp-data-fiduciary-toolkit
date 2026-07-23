const mongoose = require("mongoose");

let connected = false;

async function connect(uri = process.env.MONGO_URI) {
  if (connected) return mongoose.connection;
  if (!uri) throw new Error("MONGO_URI is not set — pass one explicitly or set it in the environment");
  await mongoose.connect(uri);
  connected = true;
  return mongoose.connection;
}

module.exports = { connect, mongoose };
