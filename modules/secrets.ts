import fs from "node:fs";

export function readSecret(secretName: string): string {
  try {
    // Attempting to fetch Docker production secret
    return fs.readFileSync(`/run/secrets/production_${secretName}`, "utf8");
  } catch {
    try {
      // Attempting to fetch Docker staging secret
      return fs.readFileSync(`/run/secrets/staging_${secretName}`, "utf8");
    } catch {
      // Fall back to config.json in case Docker secret is unavailable
      // Errors out if no config can be loaded.
      const keys = JSON.parse(fs.readFileSync("config.json", "utf8"));
      return getValueFromJsonConfig(keys, secretName);
    }
  }
}

function getValueFromJsonConfig(config, key): string {
  const string = JSON.stringify(config);
  const objectValue = JSON.parse(string);
  return objectValue[key];
}
