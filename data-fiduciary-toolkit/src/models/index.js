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
