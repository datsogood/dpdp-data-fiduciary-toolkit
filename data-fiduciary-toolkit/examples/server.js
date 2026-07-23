require("dotenv").config();
const express = require("express");
const { connect, createRouter } = require("../src/index");

async function main() {
  await connect(process.env.MONGO_URI);

  const app = express();
  app.use("/", createRouter());

  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`DPDP toolkit example running on http://localhost:${port}`));
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
