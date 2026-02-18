import fs from "node:fs";

const secretCache = new Map<string, string>();
let configCache: Record<string, unknown> | undefined;
let configLoadAttempted = false;
const secretSuffixMappings = [
  ["_client_ID", "_clientID"],
  ["_guild_ID", "_guildID"],
  ["_channel_ID", "_channelID"],
  ["_message_ID", "_messageID"],
] as const;

function readDockerSecret(secretName: string, environment: "production" | "staging"): string | undefined {
  try {
    return fs.readFileSync(`/run/secrets/${environment}_${secretName}`, "utf8");
  } catch {
    return undefined;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  if ("object" !== typeof error || null === error) {
    return false;
  }

  const maybeError = error as {
    code?: string;
  };
  return "ENOENT" === maybeError.code;
}

function getConfig(): Record<string, unknown> | undefined {
  if (true === configLoadAttempted) {
    return configCache;
  }

  configLoadAttempted = true;
  try {
    configCache = JSON.parse(fs.readFileSync("config.json", "utf8")) as Record<string, unknown>;
  } catch (error: unknown) {
    if (false === isFileNotFoundError(error)) {
      throw error;
    }

    configCache = undefined;
  }

  return configCache;
}

function addCandidate(candidates: string[], candidate: string) {
  if (false === candidates.includes(candidate)) {
    candidates.push(candidate);
  }
}

function getSecretCandidates(secretName: string): string[] {
  const candidates = [secretName];
  for (const [newSuffix, oldSuffix] of secretSuffixMappings) {
    const currentCandidates = [...candidates];
    for (const candidate of currentCandidates) {
      if (true === candidate.includes(newSuffix)) {
        addCandidate(candidates, candidate.replaceAll(newSuffix, oldSuffix));
      }

      if (true === candidate.includes(oldSuffix)) {
        addCandidate(candidates, candidate.replaceAll(oldSuffix, newSuffix));
      }
    }
  }

  return candidates;
}

function cacheSecret(secretName: string, candidate: string, value: string) {
  secretCache.set(secretName, value);
  if (candidate !== secretName) {
    secretCache.set(candidate, value);
  }
}

export function readSecret(secretName: string): string {
  const cachedSecret = secretCache.get(secretName);
  if (undefined !== cachedSecret) {
    return cachedSecret;
  }

  const secretCandidates = getSecretCandidates(secretName);
  for (const candidate of secretCandidates) {
    const productionSecret = readDockerSecret(candidate, "production");
    if (undefined !== productionSecret) {
      cacheSecret(secretName, candidate, productionSecret);
      return productionSecret;
    }

    const stagingSecret = readDockerSecret(candidate, "staging");
    if (undefined !== stagingSecret) {
      cacheSecret(secretName, candidate, stagingSecret);
      return stagingSecret;
    }
  }

  // Fall back to config.json in case Docker secret is unavailable.
  const config = getConfig();
  if (undefined === config) {
    throw new Error(
      `Missing secret "${secretName}" (checked Docker secrets in production_/staging_ prefixes and no config.json found).`,
    );
  }

  for (const candidate of secretCandidates) {
    if (true === Object.prototype.hasOwnProperty.call(config, candidate)) {
      const configSecret = getValueFromJsonConfig(config, candidate);
      cacheSecret(secretName, candidate, configSecret);
      return configSecret;
    }
  }

  secretCache.set(secretName, "");
  return "";
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
