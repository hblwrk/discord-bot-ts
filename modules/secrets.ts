import fs from "node:fs";

const supportedEnvironments = ["production", "staging"] as const;
type SecretEnvironment = typeof supportedEnvironments[number];
const secretCache = new Map<string, string>();
let cachedActiveEnvironment: SecretEnvironment | undefined;

function getSecretPath(secretName: string, environment: SecretEnvironment): string {
  return `/run/secrets/${environment}_${secretName}`;
}

function isSupportedEnvironment(value: string): value is SecretEnvironment {
  return true === supportedEnvironments.includes(value as SecretEnvironment);
}

function readDockerSecret(secretName: string, environment: SecretEnvironment): string | undefined {
  try {
    return fs.readFileSync(getSecretPath(secretName, environment), "utf8");
  } catch {
    return undefined;
  }
}

function getSecretCacheKey(secretName: string, environment: SecretEnvironment): string {
  return `${environment}:${secretName}`;
}

function cacheSecret(secretName: string, environment: SecretEnvironment, value: string) {
  secretCache.set(getSecretCacheKey(secretName, environment), value);
}

function getActiveEnvironment(): SecretEnvironment {
  if (undefined !== cachedActiveEnvironment) {
    return cachedActiveEnvironment;
  }

  const mountedEnvironmentSecrets = supportedEnvironments.flatMap(environment => {
    const environmentSecret = readDockerSecret("environment", environment);
    if (undefined === environmentSecret) {
      return [];
    }

    return [{
      environment,
      value: environmentSecret,
    }];
  });

  if (0 === mountedEnvironmentSecrets.length) {
    throw new Error(
      "Missing environment secret. Expected exactly one of /run/secrets/production_environment or /run/secrets/staging_environment.",
    );
  }

  if (1 < mountedEnvironmentSecrets.length) {
    throw new Error(
      "Ambiguous environment secrets. Found both /run/secrets/production_environment and /run/secrets/staging_environment. Mount exactly one environment prefix.",
    );
  }

  const mountedEnvironmentSecret = mountedEnvironmentSecrets[0];
  if (undefined === mountedEnvironmentSecret) {
    throw new Error(
      "Missing environment secret. Expected exactly one of /run/secrets/production_environment or /run/secrets/staging_environment.",
    );
  }

  const normalizedEnvironment = mountedEnvironmentSecret.value.trim();
  if (false === isSupportedEnvironment(normalizedEnvironment)) {
    throw new Error(
      `Invalid environment secret in "${getSecretPath("environment", mountedEnvironmentSecret.environment)}": "${normalizedEnvironment}". Expected "production" or "staging".`,
    );
  }

  if (normalizedEnvironment !== mountedEnvironmentSecret.environment) {
    throw new Error(
      `Environment secret in "${getSecretPath("environment", mountedEnvironmentSecret.environment)}" does not match mounted prefix. Expected "${mountedEnvironmentSecret.environment}" but received "${normalizedEnvironment}".`,
    );
  }

  cachedActiveEnvironment = mountedEnvironmentSecret.environment;
  cacheSecret("environment", mountedEnvironmentSecret.environment, mountedEnvironmentSecret.value);
  return cachedActiveEnvironment;
}

export function readSecret(secretName: string): string {
  const activeEnvironment = getActiveEnvironment();
  const cachedSecret = secretCache.get(getSecretCacheKey(secretName, activeEnvironment));
  if (undefined !== cachedSecret) {
    return cachedSecret;
  }

  const environmentSecret = readDockerSecret(secretName, activeEnvironment);
  if (undefined !== environmentSecret) {
    cacheSecret(secretName, activeEnvironment, environmentSecret);
    return environmentSecret;
  }

  throw new Error(
    `Missing secret "${secretName}" for active environment "${activeEnvironment}" (checked "${getSecretPath(secretName, activeEnvironment)}").`,
  );
}
