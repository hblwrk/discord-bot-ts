const mockPut = jest.fn();
const mockGet = jest.fn();
const mockOn = jest.fn();
const mockSetToken = jest.fn().mockReturnValue({
  put: mockPut,
  get: mockGet,
  on: mockOn,
});
const mockRest = jest.fn().mockImplementation(() => ({setToken: mockSetToken}));
const mockApplicationGuildCommands = jest.fn(() => "/applications/test/commands");
const loggerMock = {
  log: jest.fn(),
};

jest.mock("discord.js", () => {
  const actual = jest.requireActual("discord.js");

  return {
    ...actual,
    REST: mockRest,
    Routes: {
      ...actual.Routes,
      applicationGuildCommands: mockApplicationGuildCommands,
    },
  };
});

import {ImageAsset, TextAsset} from "./assets.js";
import {buildSlashCommandPayload, defineSlashCommands} from "./slash-commands.js";
import {readSecret} from "./secrets.js";

jest.mock("./secrets.js", () => ({
  readSecret: jest.fn(secretName => {
    if ("discord_token" === secretName) {
      return "test-token";
    }

    if ("discord_client_ID" === secretName) {
      return "client-id";
    }

    if ("discord_guild_ID" === secretName) {
      return "guild-id";
    }

    return "";
  }),
}));

jest.mock("./logging.js", () => ({
  getLogger: () => loggerMock,
  getDiscordLogger: () => loggerMock,
}));

const mockedReadSecret = readSecret as jest.MockedFunction<typeof readSecret>;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function toRemoteCommandPayload(commands: any[]): any[] {
  return commands
    .map((command, index) => ({
      id: `command-${index}`,
      application_id: "application-id",
      guild_id: "guild-id",
      version: "42",
      dm_permission: true,
      ...cloneJson(command),
    }))
    .reverse();
}

describe("defineSlashCommands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadSecret.mockClear();
    mockPut.mockImplementation(async (_route, options) => options?.body ?? []);
    mockGet.mockResolvedValue([]);
  });

  test("does a GET-only noop when the remote payload already matches after canonicalization", async () => {
    const asset = new TextAsset();
    asset.title = "Hello title";
    (asset as any).trigger = ["hello world"];
    asset.response = "Hello";
    const desiredPayload = buildSlashCommandPayload(
      [asset],
      [{title: "FAQ", name: "whatis_faq"}],
      [{name: "alice"}],
    ).slashCommands;
    mockGet.mockResolvedValueOnce(toRemoteCommandPayload(desiredPayload));

    await defineSlashCommands(
      [asset],
      [{title: "FAQ", name: "whatis_faq"}],
      [{name: "alice"}],
    );

    expect(mockRest).toHaveBeenCalledWith(expect.objectContaining({
      version: "10",
      timeout: 120000,
      rejectOnRateLimit: expect.any(Function),
    }));
    expect(mockRest.mock.calls[0][0].rejectOnRateLimit({
      route: "/applications/:id/guilds/:id/commands",
    })).toBe(true);
    expect(mockSetToken).toHaveBeenCalledWith("test-token");
    expect(mockApplicationGuildCommands).toHaveBeenCalledWith("client-id", "guild-id");
    expect(mockOn).toHaveBeenCalledWith("rateLimited", expect.any(Function));
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockPut).not.toHaveBeenCalled();

    expect(loggerMock.log).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({
        source: "slash-registration",
        message: "slash-registration:noop",
      }),
    );
  });

  test("logs warn when Discord REST emits a rate-limit event during slash reconciliation", async () => {
    const desiredPayload = buildSlashCommandPayload([], [], []).slashCommands;
    mockGet.mockResolvedValueOnce(toRemoteCommandPayload(desiredPayload));

    await defineSlashCommands([], [], []);

    const rateLimitedListener = mockOn.mock.calls.find(([eventName]) => "rateLimited" === eventName)?.[1];
    expect(rateLimitedListener).toBeDefined();

    rateLimitedListener({
      global: false,
      hash: "bucket-hash",
      limit: 1,
      majorParameter: "guild-id",
      method: "PUT",
      retryAfter: 11_902,
      route: "/applications/client-id/guilds/guild-id/commands",
      scope: "shared",
      sublimitTimeout: 0,
      timeToReset: 11_902,
    });

    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        source: "slash-registration",
        rate_limited: true,
        rate_limit_global: false,
        retry_after_ms: 11902,
        retry_in_ms: 11902,
        rate_limit_method: "PUT",
        rate_limit_scope: "shared",
        message: "slash-registration:rate-limit-event",
      }),
    );
    expect(loggerMock.log).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({
        source: "slash-registration",
        rate_limited: true,
        rate_limit_global: false,
        retry_after_ms: 11902,
        retry_in_ms: 11902,
        rate_limit_method: "PUT",
        rate_limit_scope: "shared",
        message: "slash-registration:rate-limit-event",
      }),
    );
  });

  test("updates slash commands when the remote payload differs and uses the PUT response for verification", async () => {
    const asset = new TextAsset();
    asset.title = "Hello title";
    (asset as any).trigger = ["hello world"];
    asset.response = "Hello";
    const desiredPayload = buildSlashCommandPayload([asset], [], []).slashCommands;
    const remotePayload = toRemoteCommandPayload(desiredPayload);
    remotePayload.find(command => "hello_world" === command.name).description = "Old description";
    mockGet.mockResolvedValueOnce(remotePayload);

    await defineSlashCommands([asset], [], []);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut.mock.calls[0][1].body.find(command => command.name === "hello_world").description).toBe("Hello title");
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        source: "slash-registration",
        changed_command_count: 1,
        changed_commands: ["hello_world"],
        message: "slash-registration:diff-detected",
      }),
    );
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        source: "slash-registration",
        message: "slash-registration:put-sent",
      }),
    );
    expect(loggerMock.log).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({
        source: "slash-registration",
        message: "slash-registration:completed",
      }),
    );
  });

  test("falls back to GET when the PUT response shape is unexpected", async () => {
    const asset = new TextAsset();
    asset.title = "Hello title";
    (asset as any).trigger = ["hello world"];
    asset.response = "Hello";
    const desiredPayload = buildSlashCommandPayload([asset], [], []).slashCommands;
    const remotePayload = toRemoteCommandPayload(desiredPayload);
    remotePayload.find(command => "hello_world" === command.name).description = "Old description";
    mockGet
      .mockResolvedValueOnce(remotePayload)
      .mockResolvedValueOnce(toRemoteCommandPayload(desiredPayload));
    mockPut.mockResolvedValueOnce({});

    await defineSlashCommands([asset], [], []);

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        source: "slash-registration",
        message: "slash-registration:verification-fallback-get",
      }),
    );
  });

  test("logs warning and throws when post-write verification still mismatches", async () => {
    const dracoonImageAsset = new ImageAsset();
    dracoonImageAsset.title = "Dracoon image";
    (dracoonImageAsset as any).trigger = ["dracooncmd"];
    dracoonImageAsset.location = "dracoon";
    mockGet
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPut.mockResolvedValueOnce({});

    await expect(defineSlashCommands([dracoonImageAsset], [], [])).rejects.toThrow("does not match requested payload");

    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        source: "slash-registration",
        missing_dracoon_command_count: 1,
        missing_dracoon_commands: ["dracooncmd"],
        message: "Slash command registration response does not match requested payload.",
      }),
    );
  });

  test("logs warning and throws when the current GET response shape is unexpected", async () => {
    mockGet.mockResolvedValueOnce({});

    await expect(defineSlashCommands([], [], [])).rejects.toThrow("unexpected response shape");

    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        source: "slash-registration",
        message: "Slash command registration returned unexpected response shape.",
      }),
    );
  });

  test("logs registration errors when the REST PUT request fails", async () => {
    const expectedError = new Error("discord api unavailable");
    mockGet.mockResolvedValueOnce([]);
    mockPut.mockRejectedValueOnce(expectedError);

    await expect(defineSlashCommands([], [], [])).rejects.toThrow("discord api unavailable");

    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        source: "slash-registration",
        guild_id: "guild-id",
        client_id: "client-id",
        registration_rejected: true,
        error_message: "discord api unavailable",
        message: "Slash command registration was rejected by Discord.",
      }),
    );
    expect(loggerMock.log).toHaveBeenCalledWith("error", expectedError);
  });

  test("throws create-limit error with retry-after details when Discord limit is reached", async () => {
    const createLimitError: any = new Error("Max number of daily application command creates has been reached (200)");
    createLimitError.code = 30034;
    createLimitError.rawError = {
      message: "Max number of daily application command creates has been reached (200)",
      retry_after: 360.919,
    };
    mockGet.mockResolvedValueOnce([]);
    mockPut.mockRejectedValueOnce(createLimitError);

    await expect(defineSlashCommands([], [], [])).rejects.toMatchObject({
      name: "SlashRegistrationCreateLimitError",
      retryAfterMs: 360919,
      discordErrorMessage: "Max number of daily application command creates has been reached (200)",
    });

    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        source: "slash-registration",
        registration_rejected: true,
        daily_create_limit_reached: true,
        discord_error_message: "Max number of daily application command creates has been reached (200)",
        retry_after_ms: 360919,
        message: "slash-registration:daily-create-limit-reached",
      }),
    );
  });

  test("throws rate-limit error with retry-after details when Discord responds with 429", async () => {
    const rateLimitError: any = new Error("You are being rate limited.");
    rateLimitError.status = 429;
    rateLimitError.rawError = {
      message: "You are being rate limited.",
      retry_after: 11.902,
      global: false,
    };
    mockGet.mockResolvedValueOnce([]);
    mockPut.mockRejectedValueOnce(rateLimitError);

    await expect(defineSlashCommands([], [], [])).rejects.toMatchObject({
      name: "SlashRegistrationRateLimitError",
      retryAfterMs: 11902,
      isGlobal: false,
      discordErrorMessage: "You are being rate limited.",
    });
  });

  test("uses the Retry-After header when Discord omits retry_after in a 429 response", async () => {
    const rateLimitError: any = new Error("You are being rate limited.");
    rateLimitError.status = 429;
    rateLimitError.response = {
      headers: {
        "Retry-After": "12",
      },
    };
    mockGet.mockResolvedValueOnce([]);
    mockPut.mockRejectedValueOnce(rateLimitError);

    await expect(defineSlashCommands([], [], [])).rejects.toMatchObject({
      name: "SlashRegistrationRateLimitError",
      retryAfterMs: 12_000,
      discordErrorMessage: "You are being rate limited.",
    });
  });

  test("uses the largest delay from discord.js RateLimitError objects", async () => {
    const rateLimitError: any = new Error("");
    rateLimitError.name = "RateLimitError[/applications/:id/guilds/:id/commands]";
    rateLimitError.global = false;
    rateLimitError.retryAfter = 11_902;
    rateLimitError.timeToReset = 12_000;
    rateLimitError.sublimitTimeout = 11_950;
    mockGet.mockResolvedValueOnce([]);
    mockPut.mockRejectedValueOnce(rateLimitError);

    await expect(defineSlashCommands([], [], [])).rejects.toMatchObject({
      name: "SlashRegistrationRateLimitError",
      retryAfterMs: 12_000,
      isGlobal: false,
    });
  });

  test("normalizes trigger names and skips invalid or duplicate slash command names", async () => {
    const asset = new TextAsset();
    asset.title = "Title";
    (asset as any).trigger = ["kursänderung", "kursanderung", "!!!"];
    asset.response = "ok";
    mockGet.mockResolvedValueOnce([]);

    await defineSlashCommands([asset], [], []);

    const commandPayload = mockPut.mock.calls[0][1].body;
    const kursCommands = commandPayload.filter(command => command.name === "kursanderung");
    expect(kursCommands).toHaveLength(1);

    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Skipping duplicate slash command \"kursanderung\""),
    );
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Skipping slash command for trigger \"!!!\""),
    );
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        source: "slash-registration",
        skipped_empty_triggers: 1,
        skipped_duplicate_names: 1,
        message: "Slash command payload built with skipped asset triggers.",
      }),
    );
  });

  test("groups numbered asset triggers into one slash command with optional variant parameter", () => {
    const firstImage = new ImageAsset();
    firstImage.title = "Betrug 1";
    firstImage.location = "dracoon";
    (firstImage as any).trigger = ["betrug 1"];
    const secondImage = new ImageAsset();
    secondImage.title = "Betrug 2";
    secondImage.location = "dracoon";
    (secondImage as any).trigger = ["betrug 2"];

    const payload = buildSlashCommandPayload([firstImage, secondImage], [], []);
    const betrugCommand = payload.slashCommands.find(command => command.name === "betrug");

    expect(payload.expectedCommandNames).toContain("betrug");
    expect(payload.expectedCommandNames).not.toContain("betrug_1");
    expect(payload.expectedCommandNames).not.toContain("betrug_2");
    expect(payload.assetCommandsRegistered).toBe(1);
    expect(payload.imageDracoonAssetCommandsRegistered).toBe(1);
    expect(betrugCommand).toEqual(expect.objectContaining({
      name: "betrug",
      options: [
        expect.objectContaining({
          name: "variant",
          required: false,
          choices: [
            {name: "1", value: 1},
            {name: "2", value: 2},
          ],
        }),
      ],
    }));
  });

  test("caps slash command payload at 100 commands and preserves fixed commands", () => {
    const assets: TextAsset[] = [];
    for (let index = 1; index <= 95; index++) {
      const asset = new TextAsset();
      asset.title = `Title ${index}`;
      asset.response = `Response ${index}`;
      (asset as any).trigger = [`asset-${index}`];
      assets.push(asset);
    }

    const payload = buildSlashCommandPayload(assets, [], []);

    expect(payload.slashCommands).toHaveLength(100);
    expect(payload.assetCommandsRegistered).toBe(89);
    expect(payload.fixedCommandsRegistered).toBe(11);
    expect(payload.skippedCommandLimit).toBe(6);
    expect(payload.expectedCommandNames).toContain("quote");
    expect(payload.expectedCommandNames).toContain("calendar");
    expect(payload.expectedCommandNames).toContain("paywall");
    expect(payload.expectedCommandNames).toContain("asset-89");
    expect(payload.expectedCommandNames).not.toContain("asset-90");
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        source: "slash-registration",
        max_commands_per_scope: 100,
        total_commands_registered: 100,
        skipped_command_limit: 6,
        message: "Slash command payload built with skipped asset triggers.",
      }),
    );
  });
});
