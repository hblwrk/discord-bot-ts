const mockPut = jest.fn().mockResolvedValue(undefined);
const mockSetToken = jest.fn().mockReturnValue({put: mockPut});
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

import {TextAsset} from "./assets.js";
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

describe("defineSlashCommands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadSecret.mockClear();
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

    expect(mockRest).toHaveBeenCalledWith({version: "10"});
    expect(mockSetToken).toHaveBeenCalledWith("test-token");
    expect(mockApplicationGuildCommands).toHaveBeenCalledWith("client-id", "guild-id");
    expect(mockPut).toHaveBeenCalledTimes(1);

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
        error_message: "discord api unavailable",
        message: "Failed to register slash commands with Discord.",
      }),
    );
    expect(loggerMock.log).toHaveBeenCalledWith("error", expectedError);
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
