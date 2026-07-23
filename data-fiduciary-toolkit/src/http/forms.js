const { RIGHTS_CATALOG, FIDUCIARY } = require("../config/catalog");

// Shared, minimal styling so these compliance pages don't look like an
// unstyled default form — kept deliberately plain, this is a utility screen.
const baseStyle = `
  body { font-family: Inter, system-ui, sans-serif; background:#eeebe0; color:#182640; max-width:640px; margin:2.5rem auto; padding:0 1.25rem; }
  h1 { font-size:1.4rem; margin-bottom:0.25rem; }
  p.lede { color:#4c5568; font-size:0.9rem; margin-top:0; }
  .card { background:#e4e0d0; border:1px solid #c6bfa8; padding:1rem 1.25rem; border-radius:2px; margin-bottom:0.85rem; }
  label { display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.3rem; }
  input, textarea { width:100%; box-sizing:border-box; padding:0.5rem 0.65rem; border:1px solid #c6bfa8; background:#f7f5ee; font-size:0.9rem; margin-bottom:0.9rem; }
  button { background:#182640; color:#fff; border:none; padding:0.6rem 1.1rem; font-size:0.85rem; cursor:pointer; }
  .right-title { font-weight:600; margin-bottom:0.15rem; }
  .right-meta { font-size:0.75rem; color:#4c5568; margin-bottom:0.4rem; }
`;

/** GET page: "Data Principal Rights" — lists rights, each with its own request form. */
function renderRightsPage() {
  const cards = RIGHTS_CATALOG.filter((r) => r.key !== "grievance")
    .map(
      (r) => `
    <div class="card">
      <div class="right-title">${r.title}</div>
      <div class="right-meta">${r.section}</div>
      <p style="font-size:0.85rem;">${r.description}</p>
      <form method="POST" action="/rights/exercise">
        <input type="hidden" name="right" value="${r.key}" />
        <label>Principal ID</label>
        <input name="principalId" placeholder="Returned when you confirmed your consent" required />
        <label>Details (optional)</label>
        <textarea name="details" rows="2" placeholder="e.g. which field to correct"></textarea>
        <button type="submit">Request this</button>
      </form>
    </div>`
    )
    .join("");

  return `<!doctype html><html><head><style>${baseStyle}</style></head><body>
    <h1>Your rights with ${FIDUCIARY.name}</h1>
    <p class="lede">Chapter III, DPDP Act 2023. Submitting a request here logs it and gives you a reference ID.</p>
    ${cards}
  </body></html>`;
}

/** GET page: grievance form addressed to the DPO. */
function renderGrievanceForm() {
  return `<!doctype html><html><head><style>${baseStyle}</style></head><body>
    <h1>Raise a grievance</h1>
    <p class="lede">Addressed to ${FIDUCIARY.dpoName} (${FIDUCIARY.dpoEmail}). If unresolved within the SLA, this can be escalated to the Data Protection Board.</p>
    <form method="POST" action="/grievance">
      <label>Principal ID</label>
      <input name="principalId" required />
      <label>Subject</label>
      <input name="subject" required />
      <label>Description</label>
      <textarea name="description" rows="4" required></textarea>
      <button type="submit">Send to the Grievance Officer</button>
    </form>
  </body></html>`;
}

/** GET page: request form to be connected with a Consent Manager. */
function renderConsentManagerForm() {
  return `<!doctype html><html><head><style>${baseStyle}</style></head><body>
    <h1>Talk to a Consent Manager</h1>
    <p class="lede">A Consent Manager is an independent, Board-registered entity that can manage your consent across services on your behalf.</p>
    <form method="POST" action="/consent-manager">
      <label>Principal ID</label>
      <input name="principalId" required />
      <label>Preferred Consent Manager (optional)</label>
      <input name="preferredConsentManager" />
      <label>What do you need help with?</label>
      <textarea name="message" rows="4" required></textarea>
      <button type="submit">Send request</button>
    </form>
  </body></html>`;
}

module.exports = { renderRightsPage, renderGrievanceForm, renderConsentManagerForm };
