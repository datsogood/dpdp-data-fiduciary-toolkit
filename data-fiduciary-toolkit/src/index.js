const { connect } = require("./db/connection");
const { buildModels } = require("./models");
const persistPIIwithconsent = require("./services/persistPIIwithconsent");
const withdrawConsent = require("./services/withdrawConsent");
const { getConsentState } = require("./services/consentState");
const { listRights, exerciseRight, listRightsRequests, getRightsRequest } = require("./services/dataPrincipalRights");
const { complaintToTheBoard, escalateToBoard, listGrievances, getGrievance } = require("./services/complaintToTheBoard");
const consentManagerRequest = require("./services/consentManagerRequest");
const { erasePrincipalPII } = require("./services/erasure");
const { advanceRightsRequest, advanceGrievance, advanceConsentManagerRequest } = require("./services/requestLifecycle");
const createRouter = require("./http/router");
const { buildNotice } = require("./config/notice");
const { newPrincipalId, findPrincipalByContact, updatePrincipalContact } = require("./utils/principalId");
const { CONSENT_CATALOG, RIGHTS_CATALOG, FIDUCIARY } = require("./config/catalog");

module.exports = {
  connect,
  buildModels,
  // Framework-agnostic service functions - call these directly if you're
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
  // Erasure - clears a Principal's PII, leaves the pseudonymous consent
  // ledger intact. See its own JSDoc for what it does NOT reach.
  erasePrincipalPII,
  // Fiduciary-side status transitions - deliberately NOT mounted on
  // createRouter's principal-facing routes. A data principal must not be
  // able to close their own grievance, and the fiduciary's staff auth is the
  // host's concern, not this library's. Wire these into your own back-office
  // surface.
  advanceRightsRequest,
  advanceGrievance,
  advanceConsentManagerRequest,
  // Express router with every route pre-wired.
  createRouter,
  // The Section 5 notice generator, and a fresh random identifier - exposed
  // for a host building its own UI or transport around the services above.
  buildNotice,
  newPrincipalId,
  // Read-only lookup by contact detail. This is how a host turns "I have
  // just verified this email/phone belongs to this person" (an emailed
  // one-time link, an OTP, whatever the host's own auth does) into the
  // principalId that resolvePrincipal must return - the building block for
  // real sign-in, not just the demo login in examples/server.js.
  findPrincipalByContact,
  // The supported way to honour a Section 12 correction of a principal's own
  // contact details. Deliberately NOT mounted on a route: changing a stored
  // email rewrites the emailHash that signup matches on, so accepting a new
  // address without proving the person controls it points that lookup at an
  // unverified mailbox - this library cannot send mail or verify anything,
  // only the host can. See the README's "Correcting contact details" section
  // before wiring this into your own route.
  updatePrincipalContact,
  // Config, exposed for introspection / building your own UI against it.
  CONSENT_CATALOG,
  RIGHTS_CATALOG,
  FIDUCIARY,
};
