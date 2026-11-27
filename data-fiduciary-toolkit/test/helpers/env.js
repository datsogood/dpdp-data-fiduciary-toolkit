// Runs fn with process.env[name] set to value, or unset when value is
// undefined, then puts back whatever was there before. Assigning undefined
// to a process.env key stores the string "undefined", so unset means delete.
async function withEnv(name, value, fn) {
  const saved = process.env[name];
  const put = (v) => {
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  };
  put(value);
  try {
    return await fn();
  } finally {
    put(saved);
  }
}

module.exports = { withEnv };
