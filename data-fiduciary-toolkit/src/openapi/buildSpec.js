const { routeRegistry } = require("../http/core/routeRegistry");
const { buildSchemas } = require("./schemas");

const PACKAGE = require("../../package.json");

const TAGS = [
  { name: "Consent", description: "Notice, consent capture, withdrawal, and Section 11 access." },
  { name: "Rights", description: "Chapter III data principal rights requests." },
  { name: "Grievance", description: "Section 13 grievance redressal." },
  { name: "ConsentManager", description: "Consent Manager handoff requests." },
];

const QUERY_PARAM_DEFS = {
  lang: {
    name: "lang",
    in: "query",
    required: false,
    schema: { type: "string", default: "en", enum: ["en"] },
  },
};

const PATH_PARAM_DEFS = {
  refId: {
    name: "refId",
    in: "path",
    required: true,
    schema: { type: "string" },
  },
};

const ACCEPT_PARAM = {
  name: "Accept",
  in: "header",
  required: false,
  schema: { type: "string", default: "application/json" },
};

function errorResponse(description) {
  return {
    description,
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Error" } },
      "text/html": { schema: { type: "string" } },
    },
  };
}

function successResponse(entry) {
  if (!entry.successSchema) {
    if (entry.html) {
      return { description: "Success", content: { "text/html": { schema: { type: "string" } } } };
    }
    return { description: "Success" };
  }
  const content = {
    "application/json": { schema: { $ref: `#/components/schemas/${entry.successSchema}` } },
  };
  if (entry.html) content["text/html"] = { schema: { type: "string" } };
  return { description: "Success", content };
}

function buildOperation(entry) {
  const parameters = [];
  if (entry.html) parameters.push(ACCEPT_PARAM);
  for (const name of entry.queryParams || []) {
    if (QUERY_PARAM_DEFS[name]) parameters.push(QUERY_PARAM_DEFS[name]);
  }
  for (const name of entry.pathParams || []) {
    if (PATH_PARAM_DEFS[name]) parameters.push(PATH_PARAM_DEFS[name]);
  }

  const op = {
    operationId: entry.operationId,
    tags: entry.tags,
    parameters: parameters.length ? parameters : undefined,
    responses: {
      [String(entry.successStatus)]: successResponse(entry),
      "400": errorResponse("Bad request"),
      "401": errorResponse("Authentication required"),
      "403": errorResponse("Forbidden"),
      "404": errorResponse("Not found"),
      "409": errorResponse("Conflict"),
      "422": errorResponse("Unprocessable"),
      "500": errorResponse("Internal error"),
    },
    security: entry.auth ? [{ HostSession: [] }] : [],
  };

  if (entry.requestBody) {
    op.requestBody = {
      required: true,
      content: {
        "application/json": { schema: { $ref: `#/components/schemas/${entry.requestBody}` } },
        "application/x-www-form-urlencoded": { schema: { $ref: `#/components/schemas/${entry.requestBody}` } },
      },
    };
  }
  if (!op.parameters) delete op.parameters;
  return op;
}

function buildOpenApiDocument({ basePath = "", serverUrl } = {}) {
  const paths = {};
  for (const entry of routeRegistry) {
    if (!paths[entry.path]) paths[entry.path] = {};
    paths[entry.path][entry.method] = buildOperation(entry);
  }

  const normalisedBase = basePath === "/" ? "" : (basePath || "").replace(/\/$/, "");
  const servers = serverUrl
    ? [{ url: `${serverUrl.replace(/\/$/, "")}${normalisedBase}` }]
    : [{ url: normalisedBase || "/" }];

  return {
    openapi: "3.1.0",
    info: {
      title: "DPDP Data Fiduciary Toolkit API",
      version: PACKAGE.version,
      description: "HTTP API for India's DPDP Act 2023 data-fiduciary obligations.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers,
    tags: TAGS,
    paths,
    components: {
      securitySchemes: {
        HostSession: {
          type: "apiKey",
          in: "header",
          name: "x-demo-session",
          description: "Host-provided session via resolvePrincipal.",
        },
      },
      schemas: buildSchemas(),
    },
  };
}

module.exports = { buildOpenApiDocument };
