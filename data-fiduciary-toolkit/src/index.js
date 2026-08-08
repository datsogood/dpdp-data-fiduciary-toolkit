const { connect } = require("./db/connection");
const { buildModels } = require("./models");
const persistPIIwithconsent = require("./services/persistPIIwithconsent");
const withdrawConsent = require("./services/withdrawConsent");
const { getConsentState } = require("./services/consentState");
const { listRights, exerciseRight, listRightsRequests, getRightsRequest } = require("./services/dataPrincipalRights");
const { complaintToTheBoard, escalateToBoard, listGrievances, getGrievance } = require("./services/complaintToTheBoard");
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
  // The read path - the Section 11 right of access and per-request tracking.
  getConsentState,
  listRights,
  exerciseRight,
  listRightsRequests,
  getRightsRequest,
  complaintToTheBoard,
  escalateToBoard,
  listGrievances,
  getGrievance,
  consentManagerRequest,
  listConsentManagerRequests: consentManagerRequest.listConsentManagerRequests,
  // Express router with all five APIs pre-wired.
  createRouter,
  // Config, exposed for introspection / building your own UI against it.
  CONSENT_CATALOG,
  RIGHTS_CATALOG,
  FIDUCIARY,
};
