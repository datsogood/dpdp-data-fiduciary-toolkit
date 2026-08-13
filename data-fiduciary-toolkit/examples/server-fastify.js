// Runnable Fastify demo — same curl sequence as examples/server.js.
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
const fastifyFactory = require("fastify");
const { connect, createPlugin, buildModels, findPrincipalByContact } = require("../src/index");

async function main() {
  const db = await connect(process.env.MONGO_URI);
  const models = buildModels(db);
  const fastify = fastifyFactory({ logger: true });
  const demoSessions = new Map();

  fastify.post("/demo/login", async (request, reply) => {
    if (!request.body?.email) {
      return reply.code(400).send({
        error: "email is required - a phone number alone does not identify a data principal",
      });
    }
    const principal = await findPrincipalByContact({ models, email: request.body.email });
    if (!principal) return reply.code(404).send({ error: "no such principal - POST /consent first" });
    const token = crypto.randomBytes(16).toString("hex");
    demoSessions.set(token, principal.principalId);
    return { demoSessionToken: token, hint: "send this as the x-demo-session header" };
  });

  await fastify.register(
    createPlugin({
      db,
      resolvePrincipal: (request) => demoSessions.get(request.headers["x-demo-session"]) ?? null,
      onWithdrawal: async ({ principalId, types }) => {
        console.log(`[demo] cease processing for ${principalId}: ${types.join(", ")}`);
      },
      onGrievanceFiled: async ({ refId }) => console.log(`[demo] notify the DPO about ${refId}`),
    }),
    { prefix: "/" }
  );

  const port = Number(process.env.PORT) || 4000;
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`DPDP toolkit Fastify example running on http://localhost:${port}`);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
