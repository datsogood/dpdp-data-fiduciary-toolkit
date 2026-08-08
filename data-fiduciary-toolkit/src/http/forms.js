const { RIGHTS_CATALOG, FIDUCIARY, getCatalogEntry } = require("../config/catalog");

/**
 * Escapes a value for interpolation into HTML text or a double-quoted
 * attribute.
 *
 * Nothing reaching these templates today is attacker-controlled - the catalog
 * and the fiduciary's own identity are both operator-supplied - but the
 * templates are about to gain user-supplied fields, and an escaper added
 * afterwards is an escaper someone forgets on one line. Applied to every
 * interpolated value, including the ones that cannot currently be hostile, so
 * that omission is visible rather than assumed safe.
 */
function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Shared, minimal styling so these compliance pages don't look like an
// unstyled default form - kept deliberately plain, this is a utility screen.
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

/**
 * Every form action is built from basePath, which the router supplies as
 * req.baseUrl. Hardcoded absolute actions 404 for every adopter who mounts
 * the router anywhere but /, which is most of them - and a 404 on a
 * withdrawal form is a withdrawal the data principal cannot make.
 *
 * Mounted at /, express reports req.baseUrl as "", so the actions below stay
 * "/rights/exercise" and so on with no special case.
 */

/** GET page: "Data Principal Rights" - lists rights, each with its own request form. */
function renderRightsPage({ basePath = "" } = {}) {
  const action = escapeHtml(`${basePath}/rights/exercise`);
  const cards = RIGHTS_CATALOG.filter((r) => r.key !== "grievance")
    .map(
      (r) => `
    <div class="card">
      <div class="right-title">${escapeHtml(r.title)}</div>
      <div class="right-meta">${escapeHtml(r.section)}</div>
      <p style="font-size:0.85rem;">${escapeHtml(r.description)}</p>
      <form method="POST" action="${action}">
        <input type="hidden" name="right" value="${escapeHtml(r.key)}" />
        <label>Details (optional)</label>
        <textarea name="details" rows="2" placeholder="e.g. which field to correct"></textarea>
        <button type="submit">Request this</button>
      </form>
    </div>`
    )
    .join("");

  return `<!doctype html><html><head><style>${baseStyle}</style></head><body>
    <h1>Your rights with ${escapeHtml(FIDUCIARY.name)}</h1>
    <p class="lede">Chapter III, Digital Personal Data Protection Act, 2023. Submitting a request here logs it and gives you a reference ID.</p>
    ${cards}
  </body></html>`;
}

/** GET page: grievance form addressed to the Grievance Officer. */
function renderGrievanceForm({ basePath = "" } = {}) {
  return `<!doctype html><html><head><style>${baseStyle}</style></head><body>
    <h1>Raise a grievance</h1>
    <p class="lede">Addressed to ${escapeHtml(FIDUCIARY.dpoName)} (${escapeHtml(FIDUCIARY.dpoEmail)}). If unresolved within the SLA, this can be escalated to the Data Protection Board.</p>
    <form method="POST" action="${escapeHtml(`${basePath}/grievance`)}">
      <label>Subject</label>
      <input name="subject" required />
      <label>Description</label>
      <textarea name="description" rows="4" required></textarea>
      <button type="submit">File this grievance</button>
    </form>
  </body></html>`;
}

/** GET page: request form to be connected with a Consent Manager. */
function renderConsentManagerForm({ basePath = "" } = {}) {
  return `<!doctype html><html><head><style>${baseStyle}</style></head><body>
    <h1>Talk to a Consent Manager</h1>
    <p class="lede">A Consent Manager is an independent, Board-registered entity that can manage your consent across services on your behalf.</p>
    <form method="POST" action="${escapeHtml(`${basePath}/consent-manager`)}">
      <label>Preferred Consent Manager (optional)</label>
      <input name="preferredConsentManager" />
      <label>What do you need help with?</label>
      <textarea name="message" rows="4" required></textarea>
      <button type="submit">Send request</button>
    </form>
  </body></html>`;
}

/**
 * GET page: notice and consent capture - the entry point that gives a
 * browser user their principalId at all, via the receipt page after
 * submitting. Section 5 requires the itemised notice to accompany or precede
 * the request for consent. A purpose whose lawful basis is a Section 7
 * legitimate use is not a choice the data principal gets to make, so it is
 * stated here, never rendered as a checkbox - only consent-based purposes are.
 */
function renderConsentPage({ basePath = "", notice } = {}) {
  const action = escapeHtml(`${basePath}/consent`);
  const consentPurposes = notice.purposes.filter((p) => p.lawfulBasis.kind === "consent");
  const statedPurposes = notice.purposes.filter((p) => p.lawfulBasis.kind !== "consent");

  const stated = statedPurposes
    .map(
      (p) => `
    <div class="card">
      <div class="right-title">${escapeHtml(p.title)}</div>
      <div class="right-meta">${escapeHtml(p.lawfulBasis.clause)}</div>
      <p style="font-size:0.85rem;">${escapeHtml(p.purpose)} ${escapeHtml(p.lawfulBasis.description)}.</p>
    </div>`
    )
    .join("");

  const checkboxes = consentPurposes
    .map(
      (p) => `
    <div class="card">
      <div class="right-title">${escapeHtml(p.title)}</div>
      <p style="font-size:0.85rem;">${escapeHtml(p.purpose)}</p>
      <label style="font-weight:400;">
        <input type="checkbox" name="consentTypes" value="${escapeHtml(p.type)}" style="width:auto;display:inline-block;margin-right:0.4rem;vertical-align:middle;" />
        I consent to this
      </label>
    </div>`
    )
    .join("");

  return `<!doctype html><html><head><style>${baseStyle}</style></head><body>
    <h1>Notice and consent - ${escapeHtml(notice.fiduciary.name)}</h1>
    <p class="lede">Digital Personal Data Protection Act, 2023, Section 5. This is what we collect, why, and on what basis.</p>
    <h2 style="font-size:1rem;">We already have a lawful basis for these - they are not a choice</h2>
    ${stated}
    <form method="POST" action="${action}">
      <input type="hidden" name="consentSubmitted" value="1" />
      <label>Full name</label>
      <input name="name" required />
      <label>Email</label>
      <input name="email" type="email" />
      <label>Mobile number</label>
      <input name="phone" />
      <label>Date of birth</label>
      <input name="dob" type="date" required />
      <h2 style="font-size:1rem;">Choose what you consent to</h2>
      ${checkboxes}
      <p style="font-size:0.75rem;">${escapeHtml(notice.withdrawal.description)}</p>
      <button type="submit">Submit</button>
    </form>
  </body></html>`;
}

/**
 * The receipt shown right after POST /consent succeeds - the only place a
 * browser user's principalId is ever shown, because there is no other page
 * that could hand it to them. Not a secret: the three other forms rely on
 * the host's own session (via requireAuth), not on this value, so showing it
 * in plain text is showing a reference number, not a credential.
 */
function renderConsentReceipt({ basePath = "", result } = {}) {
  const { principalId, receiptId } = result;
  const rightsUrl = escapeHtml(`${basePath}/rights`);
  const withdrawUrl = escapeHtml(`${basePath}/consent/withdraw`);
  return `<!doctype html><html><head><style>${baseStyle}</style></head><body>
    <h1>Consent recorded</h1>
    <p class="lede">Save this Principal ID somewhere safe - it is not a password, but outside of a signed-in session it is the only way to identify yourself to us.</p>
    <div class="card">
      <label>Principal ID</label>
      <input value="${escapeHtml(principalId)}" readonly />
      <label>Receipt</label>
      <input value="${escapeHtml(receiptId)}" readonly />
    </div>
    <p><a href="${rightsUrl}">See your rights</a> &middot; <a href="${withdrawUrl}">Withdraw consent</a></p>
  </body></html>`;
}

/**
 * GET page: withdrawal, given the same prominence as consenting - Rule
 * 3(c)(i) requires withdrawal to be as easy as giving consent. Only
 * currently-granted, withdrawable purposes are offered: a purpose resting on
 * a Section 7 legitimate use is never a choice, so it is never listed here
 * either, the same restriction renderConsentPage applies on the way in.
 */
function renderWithdrawalPage({ basePath = "", state = {} } = {}) {
  const action = escapeHtml(`${basePath}/consent/withdraw`);
  const withdrawable = Object.entries(state)
    .filter(([, event]) => event.status === "granted")
    .map(([type]) => getCatalogEntry(type))
    .filter((entry) => entry && entry.withdrawable);

  const checkboxes = withdrawable
    .map(
      (entry) => `
    <div class="card">
      <div class="right-title">${escapeHtml(entry.title)}</div>
      <p style="font-size:0.85rem;">${escapeHtml(entry.purpose)}</p>
      <label style="font-weight:400;">
        <input type="checkbox" name="consentTypes" value="${escapeHtml(entry.type)}" style="width:auto;display:inline-block;margin-right:0.4rem;vertical-align:middle;" />
        Withdraw this
      </label>
    </div>`
    )
    .join("");

  const empty = withdrawable.length
    ? ""
    : `<p class="lede">You have no active, withdrawable consent to change right now.</p>`;

  return `<!doctype html><html><head><style>${baseStyle}</style></head><body>
    <h1>Withdraw consent</h1>
    <p class="lede">As easy as giving it. Tick what you want to withdraw and submit.</p>
    ${empty}
    <form method="POST" action="${action}">
      <input type="hidden" name="consentSubmitted" value="1" />
      ${checkboxes}
      <button type="submit">Withdraw selected</button>
    </form>
  </body></html>`;
}

/**
 * The receipt shown right after POST /consent/withdraw succeeds. Without this
 * a data principal who withdraws lands on raw JSON while one who consents
 * gets a styled page - backwards for a right the Act requires to be as easy
 * as granting. States plainly what changed: what was withdrawn (effective
 * now), what could not be and why (withdrawConsent's own reason text, which
 * already names the clause a rejected purpose rests on), and what needed no
 * change - already withdrawn, declined, or never granted is not an error and
 * must not read like one.
 */
function renderWithdrawalReceipt({ basePath = "", result } = {}) {
  const { withdrawn = [], rejected = [], noChange = [], receiptId, contact } = result;

  const titleOf = (type) => {
    const entry = getCatalogEntry(type);
    return entry ? entry.title : type;
  };

  const withdrawnSection = withdrawn.length
    ? `<div class="card">
        <div class="right-title">Withdrawn</div>
        <p style="font-size:0.85rem;">This takes effect now.</p>
        <ul>${withdrawn.map((type) => `<li>${escapeHtml(titleOf(type))}</li>`).join("")}</ul>
      </div>`
    : "";

  const rejectedSection = rejected.length
    ? `<div class="card">
        <div class="right-title">Could not be withdrawn</div>
        <ul>${rejected.map((r) => `<li>${escapeHtml(titleOf(r.type))} - ${escapeHtml(r.reason)}</li>`).join("")}</ul>
      </div>`
    : "";

  const noChangeSection = noChange.length
    ? `<div class="card">
        <div class="right-title">No change needed</div>
        <p style="font-size:0.85rem;">Already withdrawn, declined, or never granted - not an error, there was simply nothing left to do.</p>
        <ul>${noChange.map((type) => `<li>${escapeHtml(titleOf(type))}</li>`).join("")}</ul>
      </div>`
    : "";

  return `<!doctype html><html><head><style>${baseStyle}</style></head><body>
    <h1>Withdrawal recorded</h1>
    <p class="lede">Receipt: ${escapeHtml(receiptId)}</p>
    ${withdrawnSection}
    ${rejectedSection}
    ${noChangeSection}
    <p style="font-size:0.75rem;">Questions? Contact ${escapeHtml(contact.dpoName)} at ${escapeHtml(contact.dpoEmail)}.</p>
  </body></html>`;
}

module.exports = {
  escapeHtml,
  renderRightsPage,
  renderGrievanceForm,
  renderConsentManagerForm,
  renderConsentPage,
  renderConsentReceipt,
  renderWithdrawalPage,
  renderWithdrawalReceipt,
};
