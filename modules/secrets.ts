const fs = require("node:fs");

const secrets = {};

secrets.read = function read(secretName) {
  try {
    // Attempting to fetch Docker secret
    return fs.readFileSync(`/run/secrets/${secretName}`, "utf8");
  } catch {
    // Fall back to config.json in case Docker secret is unavailable
    const keys = JSON.parse(fs.readFileSync("config.json", "utf8"))
    return getValueFromJsonConfig(keys, secretName);
  }
};

function getValueFromJsonConfig(config, key) {
  const string = JSON.stringify(config);
  const objectValue = JSON.parse(string);
  return objectValue[key];
}

module.exports = secrets;
