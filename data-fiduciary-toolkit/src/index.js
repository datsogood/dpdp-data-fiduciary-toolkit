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
const createBackOfficeRouter = require("./http/backOfficeRouter");
const { getConsentTrail, findConsentTrailByContact } = require("./services/consentTrail");
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
  // The consent audit trail: the merged lineage of what a data principal did
  // and what they were told, across the consent ledger and the five other
  // collections that already carry a timestamp. Refusals and silent no-ops are
  // stored because nothing else records them; everything a primary collection
  // can already answer is derived at read time and never copied, so no act is
  // ever reported twice. Covers forward from its release date only - the
  // returned coverageFrom says so, rather than letting an empty timeline imply
  // that nothing happened.
  getConsentTrail,
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
  // The back-office counterpart, mounted SEPARATELY and never on the same
  // path: it is operator-facing, so nothing on it is scoped to a session
  // principal. Operator identity comes from your own staff auth through
  // resolveOperator, every disclosure it makes is recorded before any data
  // leaves, and it refuses to build without rateLimitedByHost: true - it is a
  // people-search over a guessable keyspace and this package ships no rate
  // limiting. See the README's "The consent audit trail".
  createBackOfficeRouter,
  // Look a data principal up by a contact detail, then read their trail.
  // Deliberately NOT mounted on a route - the same pattern as
  // updatePrincipalContact and erasePrincipalPII. A raw contact value must
  // never reach a URL, and a principal-facing lookup by PII is either
  // redundant (it must equal your own) or a cross-principal read by
  // construction. This one keeps the phone branch the HTTP surface refuses,
  // because a direct library caller is already inside your trust boundary.
  findConsentTrailByContact,
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
