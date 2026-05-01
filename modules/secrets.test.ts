const readFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  __esModule: true,
  default: {
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  },
}));

async function loadReadSecret() {
  vi.resetModules();
  return (await import("./secrets.js")).readSecret;
}

function mockDockerSecrets(secretMap: Record<string, string>) {
  readFileSyncMock.mockImplementation(path => {
    if ("string" === typeof path && path in secretMap) {
      return secretMap[path];
    }

    if ("string" === typeof path && path.startsWith("/run/secrets/")) {
      throw new Error("docker secret missing");
    }

    throw new Error(`Unexpected path: ${path}`);
  });
}

describe("readSecret", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("uses production docker secrets when production is the active environment", async () => {
    mockDockerSecrets({
      "/run/secrets/production_environment": "production",
      "/run/secrets/production_discord_token": "prod-token",
    });

    const readSecret = await loadReadSecret();
    expect(readSecret("discord_token")).toBe("prod-token");
  });

  test("uses staging docker secrets when staging is the active environment", async () => {
    mockDockerSecrets({
      "/run/secrets/staging_environment": "staging",
      "/run/secrets/staging_discord_token": "staging-token",
    });

    const readSecret = await loadReadSecret();
    expect(readSecret("discord_token")).toBe("staging-token");
  });

  test("caches repeated reads within the active environment", async () => {
    mockDockerSecrets({
      "/run/secrets/staging_environment": "staging",
      "/run/secrets/staging_discord_token": "staging-token",
    });

    const readSecret = await loadReadSecret();
    expect(readSecret("discord_token")).toBe("staging-token");
    expect(readSecret("discord_token")).toBe("staging-token");
    expect(readFileSyncMock).toHaveBeenCalledTimes(3);
  });

  test("does not fall back to the other prefix once the active environment is known", async () => {
    mockDockerSecrets({
      "/run/secrets/production_environment": "production",
      "/run/secrets/staging_discord_token": "staging-token",
    });

    const readSecret = await loadReadSecret();
    expect(() => readSecret("discord_token")).toThrow(
      /Missing secret "discord_token" for active environment "production"/,
    );
    expect(readFileSyncMock).not.toHaveBeenCalledWith("/run/secrets/staging_discord_token", "utf8");
  });

  test("throws when both environment prefixes are mounted", async () => {
    mockDockerSecrets({
      "/run/secrets/production_environment": "production",
      "/run/secrets/staging_environment": "staging",
    });

    const readSecret = await loadReadSecret();
    expect(() => readSecret("discord_token")).toThrow(
      /Ambiguous environment secrets/,
    );
  });

  test("throws when the environment secret is missing", async () => {
    mockDockerSecrets({});

    const readSecret = await loadReadSecret();
    expect(() => readSecret("discord_token")).toThrow(
      /Missing environment secret/,
    );
  });

  test("throws when the mounted environment secret contains an invalid value", async () => {
    mockDockerSecrets({
      "/run/secrets/staging_environment": "qa",
    });

    const readSecret = await loadReadSecret();
    expect(() => readSecret("discord_token")).toThrow(
      /Invalid environment secret/,
    );
  });

  test("throws when the mounted environment secret value does not match the mounted prefix", async () => {
    mockDockerSecrets({
      "/run/secrets/production_environment": "staging",
    });

    const readSecret = await loadReadSecret();
    expect(() => readSecret("discord_token")).toThrow(
      /does not match mounted prefix/,
    );
  });

  test("throws when a secret is missing under the active prefix", async () => {
    mockDockerSecrets({
      "/run/secrets/staging_environment": "staging",
    });

    const readSecret = await loadReadSecret();
    expect(() => readSecret("missing_secret")).toThrow(
      /Missing secret "missing_secret" for active environment "staging"/,
    );
  });

  test("does not resolve legacy secret names when requesting new _ID format", async () => {
    mockDockerSecrets({
      "/run/secrets/production_environment": "production",
      "/run/secrets/production_discord_clientID": "legacy-client-id",
    });

    const readSecret = await loadReadSecret();
    expect(() => readSecret("discord_client_ID")).toThrow(
      /Missing secret "discord_client_ID" for active environment "production"/,
    );
  });

  test("returns the environment secret through the unchanged readSecret API", async () => {
    mockDockerSecrets({
      "/run/secrets/staging_environment": "staging\n",
    });

    const readSecret = await loadReadSecret();
    expect(readSecret("environment")).toBe("staging\n");
  });
});
