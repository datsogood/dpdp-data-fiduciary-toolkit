const { getValidConsentTypes, RIGHTS_CATALOG } = require("../config/catalog");

function buildSchemas() {
  const consentTypes = getValidConsentTypes();
  const exercisableRights = RIGHTS_CATALOG.map((r) => r.key).filter(
    (k) => k !== "withdrawal" && k !== "grievance"
  );
  const allRightKeys = RIGHTS_CATALOG.map((r) => r.key);

  return {
    Error: {
      type: "object",
      required: ["error"],
      properties: { error: { type: "string" } },
    },
    Pii: {
      type: "object",
      required: ["name", "dob"],
      properties: {
        name: { type: "string" },
        email: { type: "string", format: "email" },
        phone: { type: "string" },
        dob: { type: "string", format: "date" },
        pan: { type: "string" },
        address: { type: "string" },
      },
    },
    ConsentType: { type: "string", enum: consentTypes },
    ConsentSignupRequest: {
      type: "object",
      required: ["pii"],
      properties: {
        pii: { $ref: "#/components/schemas/Pii" },
        consentTypes: { type: "array", items: { $ref: "#/components/schemas/ConsentType" } },
      },
    },
    ConsentUpdateRequest: {
      type: "object",
      properties: {
        consentTypes: { type: "array", items: { $ref: "#/components/schemas/ConsentType" } },
        regrant: { type: "boolean" },
        pii: { $ref: "#/components/schemas/Pii" },
      },
    },
    ConsentWriteResponse: {
      type: "object",
      properties: {
        docRef: { type: "string" },
        receiptId: { type: "string" },
        principalId: { type: "string", pattern: "^[a-f0-9]{64}$" },
        created: { type: "boolean" },
        events: { type: "array", items: { type: "object" } },
        state: { type: "object", additionalProperties: { type: "object" } },
        refusedForChild: { type: "array", items: { type: "string" } },
      },
    },
    ConsentState: {
      type: "object",
      properties: {
        docRef: { type: "string" },
        principalId: { type: "string" },
        state: { type: "object" },
        ledger: { type: "array", items: { type: "object" } },
        notice: { type: "object", nullable: true },
        pii: { oneOf: [{ $ref: "#/components/schemas/Pii" }, { type: "null" }] },
        erasedAt: { type: "string", format: "date-time", nullable: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
    },
    WithdrawRequest: {
      type: "object",
      required: ["consentTypes"],
      properties: {
        consentTypes: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/ConsentType" } },
      },
    },
    WithdrawResponse: {
      type: "object",
      properties: {
        docRef: { type: "string" },
        receiptId: { type: "string" },
        withdrawn: { type: "array", items: { type: "string" } },
        rejected: { type: "array", items: { type: "object" } },
        noChange: { type: "array", items: { type: "string" } },
        effectiveFrom: { type: "string", format: "date-time", nullable: true },
        contact: { $ref: "#/components/schemas/DpoContact" },
      },
    },
    DpoContact: {
      type: "object",
      properties: { dpoName: { type: "string" }, dpoEmail: { type: "string", format: "email" } },
    },
    ExercisableRight: { type: "string", enum: exercisableRights },
    RightsCatalog: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", enum: allRightKeys },
          title: { type: "string" },
          section: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    ExerciseRightRequest: {
      type: "object",
      required: ["right"],
      properties: {
        right: { $ref: "#/components/schemas/ExercisableRight" },
        details: { type: "string", maxLength: 5000 },
      },
    },
    ExerciseRightResponse: {
      type: "object",
      properties: {
        refId: { type: "string" },
        right: { type: "string" },
        status: { type: "string" },
        contact: { $ref: "#/components/schemas/DpoContact" },
      },
    },
    RightsRequest: {
      type: "object",
      properties: {
        refId: { type: "string" },
        right: { type: "string" },
        details: { type: "string" },
        status: { type: "string" },
        slaDueAt: { type: "string", format: "date-time" },
        resolution: { type: "string", nullable: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
    },
    RightsRequestList: { type: "array", items: { $ref: "#/components/schemas/RightsRequest" } },
    GrievanceRequest: {
      type: "object",
      required: ["subject", "description"],
      properties: {
        subject: { type: "string", maxLength: 200 },
        description: { type: "string", maxLength: 10000 },
      },
    },
    GrievanceFiledResponse: {
      type: "object",
      properties: {
        refId: { type: "string" },
        addressedTo: { type: "string" },
        dpoEmail: { type: "string", format: "email" },
        slaDueAt: { type: "string", format: "date-time" },
        note: { type: "string" },
      },
    },
    GrievanceEscalatedResponse: {
      type: "object",
      properties: {
        refId: { type: "string" },
        status: { type: "string", enum: ["escalated"] },
        escalatedAt: { type: "string", format: "date-time" },
      },
    },
    Grievance: { type: "object", properties: { refId: { type: "string" }, subject: { type: "string" } } },
    GrievanceList: { type: "array", items: { $ref: "#/components/schemas/Grievance" } },
    ConsentManagerRequestBody: {
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string", maxLength: 5000 },
        preferredConsentManager: { type: "string", maxLength: 200 },
      },
    },
    ConsentManagerResponse: {
      type: "object",
      properties: { refId: { type: "string" }, status: { type: "string" } },
    },
    ConsentManagerRequestList: { type: "array", items: { type: "object" } },
  };
}

module.exports = { buildSchemas };
