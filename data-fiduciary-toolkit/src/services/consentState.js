const { assertPrincipalId } = require("../utils/validate");
const { AppError } = require("../utils/errors");

/**
 * The read side of the ledger.
 *
 * Without this the toolkit was write-only: consent was recorded correctly and
 * could not be got out, so the Section 11 right of access it advertises could
 * not be answered, and an auditor asking for a principal's consent history had
 * to be given raw database access. currentState() existed on the model and had
 * no call sites at all.
 *
 * Scoped by construction: the query filters on principalId, so a caller who
 * supplies someone else's id simply finds no record - see the 404 below,
 * which is deliberately the same whether the id belongs to nobody or to
 * somebody else's ledger. A 403 would confirm the ledger exists.
 */
async function getConsentState({ models, principalId }) {
  assertPrincipalId(principalId);

  const record = await models.ConsentRecord.findOne({ principalId });
  if (!record) throw new AppError("No consent record found for this principal", 404);
  const principal = await models.Principal.findOne({ principalId });

  return {
    docRef: record.docRef,
    principalId,
    state: record.currentState(),
    ledger: record.events.map((e) => ({
      type: e.type, status: e.status, basis: e.basis,
      lawfulBasisKind: e.lawfulBasisKind, receiptId: e.receiptId, timestamp: e.timestamp,
    })),
    notice: record.lastNotice ? { version: record.lastNotice.version, language: record.lastNotice.language, shownAt: record.lastNotice.shownAt } : null,
    pii: principal && !principal.erasedAt ? principal.pii : null,
    erasedAt: principal ? principal.erasedAt : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

module.exports = { getConsentState };
