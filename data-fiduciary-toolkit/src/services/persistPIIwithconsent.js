const { CONSENT_CATALOG, VALID_CONSENT_TYPES, REQUIRED_CONSENT_TYPES } = require("../config/catalog");
const { derivePrincipalId, generateDocRef } = require("../utils/principalId");

/**
 * Persists a data principal's PII along with the consent choices they made,
 * confirming the choice with a receipt. Required (legal-basis) purposes are
 * always recorded as granted regardless of what's passed in, since they
 * don't depend on consent — but they're still logged, because the principal
 * is still owed notice of them.
 *
 * @param {object} input
 * @param {object} input.models - model registry, must include ConsentRecord
 * @param {object} input.pii - { name, email, phone, dob?, pan?, address? }
 * @param {string[]} input.consentTypes - optional purposes the principal agreed to (e.g. ['marketing'])
 * @returns {Promise<{ docRef: string, principalId: string, events: object[] }>}
 */
async function persistPIIwithconsent({ models, pii, consentTypes = [], regrant } = {}) {
  if (!pii || !pii.name || !pii.email || !pii.phone) {
    throw new Error("pii.name, pii.email, and pii.phone are required");
  }

  const unknownTypes = consentTypes.filter((t) => !VALID_CONSENT_TYPES.includes(t));
  if (unknownTypes.length) {
    throw new Error(`Unknown consent type(s): ${unknownTypes.join(", ")}`);
  }

  const principalId = derivePrincipalId(pii.email);
  const now = new Date();

  // Every purpose in the catalog gets an event: required ones are always
  // 'granted' (legal basis, not choice); optional ones follow what was passed in.
  const events = CONSENT_CATALOG.map((entry) => ({
    type: entry.type,
    status: entry.required || consentTypes.includes(entry.type) ? "granted" : "withdrawn",
    basis: entry.basis,
    timestamp: now,
  }));

  let record = await models.ConsentRecord.findOne({ principalId });

  if (record) {
    // Returning principal confirming choices again — append new events,
    // keep the original docRef and PII record, update contact details.
    record.events.push(...events);
    record.updatedAt = now;
    await record.save();
  } else {
    record = await models.ConsentRecord.create({
      principalId,
      docRef: generateDocRef("CN"),
      pii,
      events,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    docRef: record.docRef,
    principalId,
    events,
    requiredPurposes: REQUIRED_CONSENT_TYPES,
  };
}

module.exports = persistPIIwithconsent;
