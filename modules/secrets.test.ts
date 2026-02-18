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

  test("throws when secret is missing in docker secrets", () => {
    readFileSyncMock.mockImplementation(path => {
      if ("string" === typeof path && path.startsWith("/run/secrets/")) {
        throw new Error("docker secret missing");
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    const readSecret = loadReadSecret();
    expect(() => readSecret("missing_secret")).toThrow(
      /Missing secret "missing_secret"/,
    );
  });

  test("does not resolve legacy secret names when requesting new _ID format", () => {
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
    expect(() => readSecret("discord_client_ID")).toThrow(
      /Missing secret "discord_client_ID"/,
    );
  });

  test("throws clear error when docker secrets are unavailable", () => {
    readFileSyncMock.mockImplementation(path => {
      if ("string" === typeof path && path.startsWith("/run/secrets/")) {
        const error = new Error("docker secret missing");
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
