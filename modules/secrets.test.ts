const readFileSyncMock = jest.fn();

jest.mock("node:fs", () => ({
  __esModule: true,
  default: {
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  },
}));

function loadReadSecret() {
  let readSecretFn: (secretName: string) => string = () => "";
  jest.isolateModules(() => {
    ({readSecret: readSecretFn} = require("./secrets.js"));
  });

  return readSecretFn;
}

describe("readSecret", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("uses production docker secret and caches the value", () => {
    readFileSyncMock.mockImplementation(path => {
      if ("/run/secrets/production_discord_token" === path) {
        return "prod-token";
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    const readSecret = loadReadSecret();
    expect(readSecret("discord_token")).toBe("prod-token");
    expect(readSecret("discord_token")).toBe("prod-token");
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to staging secret when production secret is unavailable", () => {
    readFileSyncMock.mockImplementation(path => {
      if ("/run/secrets/production_discord_token" === path) {
        throw new Error("production missing");
      }

      if ("/run/secrets/staging_discord_token" === path) {
        return "staging-token";
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    const readSecret = loadReadSecret();
    expect(readSecret("discord_token")).toBe("staging-token");
  });

  test("falls back to config.json once and returns empty string for missing key", () => {
    readFileSyncMock.mockImplementation(path => {
      if ("config.json" === path) {
        return JSON.stringify({
          present_secret: "present",
        });
      }

      if ("string" === typeof path && path.startsWith("/run/secrets/")) {
        throw new Error("docker secret missing");
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    const readSecret = loadReadSecret();
    expect(readSecret("present_secret")).toBe("present");
    expect(readSecret("missing_secret")).toBe("");

    const configReads = readFileSyncMock.mock.calls
      .filter(call => "config.json" === call[0])
      .length;
    expect(configReads).toBe(1);
  });

  test("resolves legacy secret name when requesting new _ID format", () => {
    readFileSyncMock.mockImplementation(path => {
      if ("/run/secrets/production_discord_client_ID" === path) {
        throw new Error("new secret missing");
      }

      if ("/run/secrets/staging_discord_client_ID" === path) {
        throw new Error("new staging secret missing");
      }

      if ("/run/secrets/production_discord_clientID" === path) {
        return "legacy-client-id";
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    const readSecret = loadReadSecret();
    expect(readSecret("discord_client_ID")).toBe("legacy-client-id");
  });

  test("throws clear error when docker secrets and config are both unavailable", () => {
    readFileSyncMock.mockImplementation(path => {
      if ("string" === typeof path && path.startsWith("/run/secrets/")) {
        const error = new Error("docker secret missing") as Error & { code?: string };
        error.code = "ENOENT";
        throw error;
      }

      if ("config.json" === path) {
        const error = new Error("config missing") as Error & { code?: string };
        error.code = "ENOENT";
        throw error;
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    const readSecret = loadReadSecret();
    expect(() => readSecret("discord_token")).toThrow(
      /Missing secret "discord_token"/,
    );
  });
});
