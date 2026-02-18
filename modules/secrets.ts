import fs from "node:fs";

const secretCache = new Map<string, string>();
let configCache: Record<string, unknown> | undefined;

function readDockerSecret(secretName: string, environment: "production" | "staging"): string | undefined {
  try {
    return fs.readFileSync(`/run/secrets/${environment}_${secretName}`, "utf8");
  } catch {
    return undefined;
  }
}

function getConfig(): Record<string, unknown> {
  if (undefined !== configCache) {
    return configCache;
  }

  configCache = JSON.parse(fs.readFileSync("config.json", "utf8")) as Record<string, unknown>;
  return configCache;
}

export function readSecret(secretName: string): string {
  const cachedSecret = secretCache.get(secretName);
  if (undefined !== cachedSecret) {
    return cachedSecret;
  }

  const productionSecret = readDockerSecret(secretName, "production");
  if (undefined !== productionSecret) {
    secretCache.set(secretName, productionSecret);
    return productionSecret;
  }

  const stagingSecret = readDockerSecret(secretName, "staging");
  if (undefined !== stagingSecret) {
    secretCache.set(secretName, stagingSecret);
    return stagingSecret;
  }

  // Fall back to config.json in case Docker secret is unavailable.
  // Errors out if no config can be loaded.
  const config = getConfig();
  const configSecret = getValueFromJsonConfig(config, secretName);
  secretCache.set(secretName, configSecret);
  return configSecret;
}

function getValueFromJsonConfig(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if ("string" === typeof value) {
    return value;
  }

  if (null === value || undefined === value) {
    return "";
  }

  return String(value);
}
