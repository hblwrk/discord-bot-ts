import fs from "node:fs";

const secretCache = new Map<string, string>();

function readDockerSecret(secretName: string, environment: "production" | "staging"): string | undefined {
  try {
    return fs.readFileSync(`/run/secrets/${environment}_${secretName}`, "utf8");
  } catch {
    return undefined;
  }
}

function cacheSecret(secretName: string, value: string) {
  secretCache.set(secretName, value);
}

export function readSecret(secretName: string): string {
  const cachedSecret = secretCache.get(secretName);
  if (undefined !== cachedSecret) {
    return cachedSecret;
  }

  const productionSecret = readDockerSecret(secretName, "production");
  if (undefined !== productionSecret) {
    cacheSecret(secretName, productionSecret);
    return productionSecret;
  }

  const stagingSecret = readDockerSecret(secretName, "staging");
  if (undefined !== stagingSecret) {
    cacheSecret(secretName, stagingSecret);
    return stagingSecret;
  }

  throw new Error(
    `Missing secret "${secretName}" (checked Docker secrets with production_/staging_ prefixes).`,
  );
}
