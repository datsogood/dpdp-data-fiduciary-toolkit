/** Clear cached HTTP stack modules so env-driven catalog config is re-read. */
function clearHttpModuleCache() {
  for (const mod of [
    "../../src/config/catalog",
    "../../src/http/core/createHttpCore",
    "../../src/http/core/handlers",
    "../../src/http/adapters/express",
    "../../src/http/adapters/fastify",
    "../../src/http/router",
  ]) {
    delete require.cache[require.resolve(mod)];
  }
}

module.exports = { clearHttpModuleCache };
