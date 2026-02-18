const mockPut = jest.fn().mockResolvedValue(undefined);
const mockSetToken = jest.fn().mockReturnValue({put: mockPut});
const mockRest = jest.fn().mockImplementation(() => ({setToken: mockSetToken}));
const mockApplicationGuildCommands = jest.fn(() => "/applications/test/commands");

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

    defineSlashCommands(
      [asset],
      [{title: "FAQ", name: "whatis_faq"}],
      [{name: "alice"}],
    );

    await new Promise(resolve => {
      setImmediate(resolve);
    });

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
  });
});
