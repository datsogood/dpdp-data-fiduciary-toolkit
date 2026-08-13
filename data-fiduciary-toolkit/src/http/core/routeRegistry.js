const routeRegistry = [
  { method: "get", path: "/consent/new", operationId: "getConsentForm", auth: false, noStore: false, html: true,
    requestBody: null, successStatus: 200, successSchema: null, queryParams: ["lang"], tags: ["Consent"] },
  { method: "post", path: "/consent", operationId: "createConsent", auth: false, noStore: false, html: true,
    requestBody: "ConsentSignupRequest", successStatus: 201, successSchema: "ConsentWriteResponse", queryParams: ["lang"], tags: ["Consent"] },
  { method: "put", path: "/consent", operationId: "updateConsent", auth: true, noStore: false, html: false,
    requestBody: "ConsentUpdateRequest", successStatus: 200, successSchema: "ConsentWriteResponse", queryParams: ["lang"], tags: ["Consent"] },
  { method: "get", path: "/consent", operationId: "getConsentState", auth: true, noStore: true, html: false,
    requestBody: null, successStatus: 200, successSchema: "ConsentState", tags: ["Consent"] },
  { method: "get", path: "/consent/withdraw", operationId: "getWithdrawalForm", auth: true, noStore: true, html: true,
    requestBody: null, successStatus: 200, successSchema: null, tags: ["Consent"] },
  { method: "put", path: "/consent/withdraw", operationId: "withdrawConsentPut", auth: true, noStore: false, html: true,
    requestBody: "WithdrawRequest", successStatus: 200, successSchema: "WithdrawResponse", tags: ["Consent"] },
  { method: "post", path: "/consent/withdraw", operationId: "withdrawConsentPost", auth: true, noStore: false, html: true,
    requestBody: "WithdrawRequest", successStatus: 200, successSchema: "WithdrawResponse", tags: ["Consent"] },
  { method: "get", path: "/rights", operationId: "listRights", auth: false, noStore: false, html: true,
    requestBody: null, successStatus: 200, successSchema: "RightsCatalog", tags: ["Rights"] },
  { method: "post", path: "/rights/exercise", operationId: "exerciseRight", auth: true, noStore: false, html: true,
    requestBody: "ExerciseRightRequest", successStatus: 201, successSchema: "ExerciseRightResponse", tags: ["Rights"] },
  { method: "get", path: "/rights/requests", operationId: "listRightsRequests", auth: true, noStore: true, html: false,
    requestBody: null, successStatus: 200, successSchema: "RightsRequestList", tags: ["Rights"] },
  { method: "get", path: "/rights/requests/{refId}", operationId: "getRightsRequest", auth: true, noStore: true, html: false,
    requestBody: null, successStatus: 200, successSchema: "RightsRequest", pathParams: ["refId"], tags: ["Rights"] },
  { method: "get", path: "/grievance/new", operationId: "getGrievanceForm", auth: false, noStore: false, html: true,
    requestBody: null, successStatus: 200, successSchema: null, tags: ["Grievance"] },
  { method: "post", path: "/grievance", operationId: "fileGrievance", auth: true, noStore: false, html: true,
    requestBody: "GrievanceRequest", successStatus: 201, successSchema: "GrievanceFiledResponse", tags: ["Grievance"] },
  { method: "post", path: "/grievance/{refId}/escalate", operationId: "escalateGrievance", auth: true, noStore: false, html: false,
    requestBody: null, successStatus: 200, successSchema: "GrievanceEscalatedResponse", pathParams: ["refId"], tags: ["Grievance"] },
  { method: "get", path: "/grievances", operationId: "listGrievances", auth: true, noStore: true, html: false,
    requestBody: null, successStatus: 200, successSchema: "GrievanceList", tags: ["Grievance"] },
  { method: "get", path: "/grievances/{refId}", operationId: "getGrievance", auth: true, noStore: true, html: false,
    requestBody: null, successStatus: 200, successSchema: "Grievance", pathParams: ["refId"], tags: ["Grievance"] },
  { method: "get", path: "/consent-manager/new", operationId: "getConsentManagerForm", auth: false, noStore: false, html: true,
    requestBody: null, successStatus: 200, successSchema: null, tags: ["ConsentManager"] },
  { method: "post", path: "/consent-manager", operationId: "requestConsentManager", auth: true, noStore: false, html: true,
    requestBody: "ConsentManagerRequestBody", successStatus: 201, successSchema: "ConsentManagerResponse", tags: ["ConsentManager"] },
  { method: "get", path: "/consent-manager/requests", operationId: "listConsentManagerRequests", auth: true, noStore: true, html: false,
    requestBody: null, successStatus: 200, successSchema: "ConsentManagerRequestList", tags: ["ConsentManager"] },
];

function toExpressPath(openApiPath) {
  return openApiPath.replace(/\{(\w+)\}/g, ":$1");
}

const toFastifyPath = toExpressPath;

function normalizeBasePath(basePath) {
  if (!basePath || basePath === "/") return "";
  return basePath;
}

module.exports = { routeRegistry, toExpressPath, toFastifyPath, normalizeBasePath };
