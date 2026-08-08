// Runnable demo of the toolkit end to end.
//
// Sequence:
//   1. POST /consent            - create a principal (pii + consentTypes)
//   2. POST /demo/login         - exchange the email/phone you just used for
//                                 a demo session token
//   3. any authenticated route  - send the token back as x-demo-session
//
// Example, with the server running on the default port:
//
//   curl -s localhost:4000/consent -X POST -H 'Content-Type: application/json' -d '{
//     "pii": {"name":"Asha Rao","email":"asha@example.com","dob":"1990-01-01"},
//     "consentTypes": ["marketing"]
//   }'
//
//   curl -s localhost:4000/demo/login -X POST -H 'Content-Type: application/json' \
//     -d '{"email":"asha@example.com"}'
//
//   curl -s localhost:4000/consent -H 'x-demo-session: <token from above>'
require("dotenv").config();
const crypto = require("node:crypto");
const express = require("express");
const { connect, createRouter, buildModels, findPrincipalByContact } = require("../src/index");

async function main() {
  const db = await connect(process.env.MONGO_URI);
  const models = buildModels(db);
  const app = express();

  // DEMO ONLY - an in-memory token map, not a session store.
  //
  // A real deployment authenticates the data principal (an emailed one-time
  // link, or an existing account session) and returns the principalId from
  // that. It must never trust a client-supplied value: principalId is a
  // database key, not a credential.
  const demoSessions = new Map();

  app.use(express.json());

  // Clearly-labelled demo sign-in, so the rest of the example is reachable.
  // Exchange a contact detail for a token. A real deployment would send a
  // one-time link to that address instead of returning a token here.
  app.post("/demo/login", async (req, res) => {
    const principal = await findPrincipalByContact({ models, email: req.body.email, phone: req.body.phone });
    if (!principal) return res.status(404).json({ error: "no such principal - POST /consent first" });
    const token = crypto.randomBytes(16).toString("hex");
    demoSessions.set(token, principal.principalId);
    res.json({ demoSessionToken: token, hint: "send this as the x-demo-session header" });
  });

  app.use("/", createRouter({
    db,
    resolvePrincipal: (req) => demoSessions.get(req.get("x-demo-session")) ?? null,
    onWithdrawal: async ({ principalId, types }) => {
      // Where a real deployment would tell its processors to stop and run its
      // erasure pipeline. See erasePrincipalPII for the erasure primitive.
      console.log(`[demo] cease processing for ${principalId}: ${types.join(", ")}`);
    },
    onGrievanceFiled: async ({ refId }) => console.log(`[demo] notify the DPO about ${refId}`),
  }));

  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`DPDP toolkit example running on http://localhost:${port}`));
}

main().catch((err) => { console.error("Failed to start:", err); process.exit(1); });
