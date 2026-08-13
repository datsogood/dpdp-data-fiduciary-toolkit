const fs = require("node:fs");
const path = require("node:path");

const { buildOpenApiDocument } = require("../src/openapi/buildSpec");

const OUT = path.join(__dirname, "..", "openapi", "openapi.json");
const doc = buildOpenApiDocument({ serverUrl: "http://localhost:4000" });
const json = `${JSON.stringify(doc, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const existing = fs.readFileSync(OUT, "utf8");
  if (existing !== json) {
    console.error("openapi/openapi.json is out of date — run npm run openapi:generate");
    process.exit(1);
  }
  console.log("openapi/openapi.json is up to date");
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(`Wrote ${OUT}`);
}
