const { AppError } = require("../../utils/errors");
const { findPrincipalByContact, findPrincipalById, lookupHash } = require("../../utils/principalId");
const persistPIIwithconsent = require("../../services/persistPIIwithconsent");
const withdrawConsent = require("../../services/withdrawConsent");
const { getConsentState } = require("../../services/consentState");
const { buildNotice, DEFAULT_NOTICE_LANGUAGE } = require("../../config/notice");
const { listRights, exerciseRight, listRightsRequests, getRightsRequest } = require("../../services/dataPrincipalRights");
const { complaintToTheBoard, escalateToBoard, listGrievances, getGrievance } = require("../../services/complaintToTheBoard");
const consentManagerRequest = require("../../services/consentManagerRequest");
const { listConsentManagerRequests } = consentManagerRequest;
const {
  escapeHtml,
  renderRightsPage,
  renderGrievanceForm,
  renderConsentManagerForm,
  renderConsentPage,
  renderConsentReceipt,
  renderWithdrawalPage,
  renderWithdrawalReceipt,
} = require("../forms");
const { wantsHtml } = require("../negotiate");
const { noStoreHeaders } = require("./middleware");
const { asArray, readConsentTypes, readPii, isTrue } = require("./requestParsers");

function createHandlers({ models, onWithdrawal, onGrievanceFiled }) {
  function assertOwnContact(principal, pii) {
    const mismatch =
      (pii.email && lookupHash(pii.email) !== principal.emailHash) ||
      (pii.phone && lookupHash(pii.phone) !== principal.phoneHash);
    if (mismatch) {
      throw new AppError(
        "The contact details supplied do not belong to the signed-in data principal. Use the correction route to change them.",
        403
      );
    }
  }

  const withdraw = async (ctx) => {
    const result = await withdrawConsent({
      models,
      principalId: ctx.principalId,
      consentTypes: asArray(ctx.body.consentTypes),
      onWithdrawal,
    });
    if (wantsHtml(ctx.headers.accept)) {
      return {
        status: 200,
        headers: noStoreHeaders(),
        html: renderWithdrawalReceipt({ basePath: ctx.basePath, result }),
      };
    }
    return { status: 200, json: result };
  };

  return {
    getConsentForm(ctx) {
      const notice = buildNotice({ language: ctx.query.lang || DEFAULT_NOTICE_LANGUAGE });
      return { status: 200, html: renderConsentPage({ basePath: ctx.basePath, notice }) };
    },

    async createConsent(ctx) {
      const pii = readPii(ctx.body);
      const existing = await findPrincipalByContact({ models, email: pii.email });
      if (existing) {
        throw new AppError("principal already exists - sign in to change your consent", 409);
      }
      const notice = buildNotice({ language: ctx.query.lang || DEFAULT_NOTICE_LANGUAGE });
      const result = await persistPIIwithconsent({
        models, pii, consentTypes: readConsentTypes(ctx.body), notice,
      });
      if (wantsHtml(ctx.headers.accept)) {
        return {
          status: 201,
          headers: noStoreHeaders(),
          html: renderConsentReceipt({ basePath: ctx.basePath, result }),
        };
      }
      return { status: 201, json: result };
    },

    async updateConsent(ctx) {
      const principal = await findPrincipalById({ models, principalId: ctx.principalId });
      if (!principal) throw new AppError("No principal found for that id", 404);
      if (principal.erasedAt) {
        throw new AppError("This data principal's record has been erased and cannot be updated", 409);
      }
      assertOwnContact(principal, readPii(ctx.body));
      const notice = buildNotice({ language: ctx.query.lang || DEFAULT_NOTICE_LANGUAGE });
      const result = await persistPIIwithconsent({
        models,
        principalId: ctx.principalId,
        pii: principal.pii.toObject(),
        consentTypes: readConsentTypes(ctx.body),
        regrant: isTrue(ctx.body.regrant),
        notice,
      });
      return { status: 200, json: result };
    },

    async getConsentState(ctx) {
      const result = await getConsentState({ models, principalId: ctx.principalId });
      return { status: 200, json: result };
    },

    async getWithdrawalForm(ctx) {
      const { state } = await getConsentState({ models, principalId: ctx.principalId });
      return { status: 200, html: renderWithdrawalPage({ basePath: ctx.basePath, state }) };
    },

    withdrawConsentPut: withdraw,
    withdrawConsentPost: withdraw,

    listRights(ctx) {
      if (wantsHtml(ctx.headers.accept)) {
        return { status: 200, html: renderRightsPage({ basePath: ctx.basePath }) };
      }
      return { status: 200, json: listRights() };
    },

    async exerciseRight(ctx) {
      const result = await exerciseRight({
        models,
        principalId: ctx.principalId,
        right: ctx.body.right,
        details: ctx.body.details,
      });
      if (wantsHtml(ctx.headers.accept)) {
        return {
          status: 201,
          html: `<p>Request received. Reference: <b>${escapeHtml(result.refId)}</b></p>`,
        };
      }
      return { status: 201, json: result };
    },

    async listRightsRequests(ctx) {
      return { status: 200, json: await listRightsRequests({ models, principalId: ctx.principalId }) };
    },

    async getRightsRequest(ctx) {
      return {
        status: 200,
        json: await getRightsRequest({ models, principalId: ctx.principalId, refId: ctx.params.refId }),
      };
    },

    getGrievanceForm(ctx) {
      return { status: 200, html: renderGrievanceForm({ basePath: ctx.basePath }) };
    },

    async fileGrievance(ctx) {
      const result = await complaintToTheBoard({
        models,
        principalId: ctx.principalId,
        subject: ctx.body.subject,
        description: ctx.body.description,
      });
      if (typeof onGrievanceFiled === "function") {
        try {
          await onGrievanceFiled({ principalId: ctx.principalId, ...result });
        } catch (hookErr) {
          console.error("[dpdp-toolkit] onGrievanceFiled threw after the grievance was filed:", hookErr);
        }
      }
      if (wantsHtml(ctx.headers.accept)) {
        return {
          status: 201,
          html:
            `<p>Recorded for ${escapeHtml(result.addressedTo)}. Reference: <b>${escapeHtml(result.refId)}</b>. ` +
            `Due for resolution by ${escapeHtml(result.slaDueAt.toISOString().slice(0, 10))}.</p>`,
        };
      }
      return { status: 201, json: result };
    },

    async escalateGrievance(ctx) {
      const result = await escalateToBoard({
        models,
        refId: ctx.params.refId,
        principalId: ctx.principalId,
      });
      return { status: 200, json: result };
    },

    async listGrievances(ctx) {
      return { status: 200, json: await listGrievances({ models, principalId: ctx.principalId }) };
    },

    async getGrievance(ctx) {
      return {
        status: 200,
        json: await getGrievance({ models, principalId: ctx.principalId, refId: ctx.params.refId }),
      };
    },

    getConsentManagerForm(ctx) {
      return { status: 200, html: renderConsentManagerForm({ basePath: ctx.basePath }) };
    },

    async requestConsentManager(ctx) {
      const result = await consentManagerRequest({
        models,
        principalId: ctx.principalId,
        message: ctx.body.message,
        preferredConsentManager: ctx.body.preferredConsentManager,
      });
      if (wantsHtml(ctx.headers.accept)) {
        return {
          status: 201,
          html: `<p>Request received. Reference: <b>${escapeHtml(result.refId)}</b></p>`,
        };
      }
      return { status: 201, json: result };
    },

    async listConsentManagerRequests(ctx) {
      return {
        status: 200,
        json: await listConsentManagerRequests({ models, principalId: ctx.principalId }),
      };
    },
  };
}

module.exports = { createHandlers };
