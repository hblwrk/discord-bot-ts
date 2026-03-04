const mockPut = jest.fn();
const mockGet = jest.fn();
const mockSetToken = jest.fn().mockReturnValue({put: mockPut, get: mockGet});
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
import {defineSlashCommands} from "./slash-commands.js";
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
const getLastPutBody = () => {
  const lastCallIndex = mockPut.mock.calls.length - 1;
  if (lastCallIndex < 0) {
    return [];
  }

  return mockPut.mock.calls[lastCallIndex]?.[1]?.body ?? [];
};

describe("defineSlashCommands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadSecret.mockClear();
    mockPut.mockImplementation(async (_route, options) => options?.body ?? []);
    mockGet.mockImplementation(async () => getLastPutBody());
  });

  test("registers slash commands with v10 REST route and v14 choice structures", async () => {
    const asset = new TextAsset();
    asset.title = "Hello title";
    (asset as any).trigger = ["hello world"];
    asset.response = "Hello";

    await defineSlashCommands(
      [asset],
      [{title: "FAQ", name: "whatis_faq"}],
      [{name: "alice"}],
    );

    expect(mockRest).toHaveBeenCalledWith(expect.objectContaining({version: "10"}));
    expect(mockSetToken).toHaveBeenCalledWith("test-token");
    expect(mockApplicationGuildCommands).toHaveBeenCalledWith("client-id", "guild-id");
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);

    const commandPayload = mockPut.mock.calls[0][1].body;

    expect(commandPayload.some(command => command.name === "hello_world")).toBe(true);

    const whatisCommand = commandPayload.find(command => command.name === "whatis");
    const whatisSearchOption = whatisCommand.options.find(option => option.name === "search");
    expect(whatisSearchOption.choices).toContainEqual({name: "FAQ", value: "whatis_faq"});

    const earningsCommand = commandPayload.find(command => command.name === "earnings");
    const whenOption = earningsCommand.options.find(option => option.name === "when");
    expect(whenOption.choices).toContainEqual({name: "Alle", value: "all"});
    const daysOption = earningsCommand.options.find(option => option.name === "days");
    expect(daysOption.max_value).toBe(10);
    const filterOption = earningsCommand.options.find(option => option.name === "filter");
    expect(filterOption.choices).toContainEqual({name: "Alle", value: "all"});
    expect(filterOption.choices).toContainEqual({name: "Bluechips (>= $10B)", value: "bluechips"});

    const lifecycleMessages = [
      "slash-registration:start",
      "slash-registration:put-sent",
      "slash-registration:get-sent",
      "slash-registration:completed",
    ];
    for (const message of lifecycleMessages) {
      expect(loggerMock.log).toHaveBeenCalledWith(
        "warn",
        expect.objectContaining({
          source: "slash-registration",
          message,
        }),
      );
    }
  });

  test("logs registration errors when REST command deployment fails", async () => {
    const expectedError = new Error("discord api unavailable");
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

  test("logs warning and throws when Discord returns truncated slash registration payload", async () => {
    const asset = new TextAsset();
    asset.title = "Title";
    (asset as any).trigger = ["hello"];
    asset.response = "ok";
    mockGet.mockImplementationOnce(async () => {
      return getLastPutBody().slice(0, 3);
    });

    await expect(defineSlashCommands([asset], [], [])).rejects.toThrow("does not match requested payload");

    const mismatchLogCall = loggerMock.log.mock.calls.find(([level, payload]) => {
      return "warn" === level && payload?.message === "Slash command registration response does not match requested payload.";
    });
    expect(mismatchLogCall).toBeDefined();
    expect((mismatchLogCall as any)[1]).toEqual(expect.objectContaining({
      source: "slash-registration",
      truncated: true,
    }));
    expect((mismatchLogCall as any)[1].missing_command_count).toBeGreaterThan(0);
  });

  test("logs missing dracoon command details when dracoon-backed slash commands are missing", async () => {
    const dracoonImageAsset = new ImageAsset();
    dracoonImageAsset.title = "Dracoon image";
    (dracoonImageAsset as any).trigger = ["dracooncmd"];
    dracoonImageAsset.location = "dracoon";

    mockGet.mockImplementationOnce(async () => {
      return getLastPutBody().filter(command => "dracooncmd" !== command.name);
    });

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

  test("logs warning and throws when slash registration GET response shape is unexpected", async () => {
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

  test("normalizes trigger names and skips invalid or duplicate slash command names", async () => {
    const asset = new TextAsset();
    asset.title = "Title";
    (asset as any).trigger = ["kursänderung", "kursanderung", "!!!"];
    asset.response = "ok";

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
});
