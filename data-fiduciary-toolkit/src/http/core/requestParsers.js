function asArray(value) {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value : [value];
}

function readConsentTypes(body) {
  const types = asArray(body.consentTypes);
  if (types !== undefined) return types;
  return body.consentSubmitted ? [] : undefined;
}

function readPii(body) {
  if (body.pii && typeof body.pii === "object") return body.pii;
  const { name, email, phone, dob, pan, address } = body;
  const pii = { name, email, phone, dob, pan, address };
  for (const k of Object.keys(pii)) if (pii[k] === undefined) delete pii[k];
  return pii;
}

function isTrue(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

module.exports = { asArray, readConsentTypes, readPii, isTrue };
