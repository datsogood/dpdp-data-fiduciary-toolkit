const { connect } = require("./db/connection");
const { buildModels } = require("./models");
const persistPIIwithconsent = require("./services/persistPIIwithconsent");
const withdrawConsent = require("./services/withdrawConsent");
const { listRights, exerciseRight } = require("./services/dataPrincipalRights");
const { complaintToTheBoard, escalateToBoard } = require("./services/complaintToTheBoard");
const consentManagerRequest = require("./services/consentManagerRequest");
const createRouter = require("./http/router");
const { CONSENT_CATALOG, RIGHTS_CATALOG, FIDUCIARY } = require("./config/catalog");

module.exports = {
  connect,
  buildModels,
  // Framework-agnostic service functions — call these directly if you're
  // not using Express, or wrap them in your own transport layer.
  persistPIIwithconsent,
  withdrawConsent,
  listRights,
  exerciseRight,
  complaintToTheBoard,
  escalateToBoard,
  consentManagerRequest,
  // Express router with all five APIs pre-wired.
  createRouter,
  // Config, exposed for introspection / building your own UI against it.
  CONSENT_CATALOG,
  RIGHTS_CATALOG,
  FIDUCIARY,
};
