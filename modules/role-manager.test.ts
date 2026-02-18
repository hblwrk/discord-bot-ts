import {roleManager} from "./role-manager.js";
import {readSecret} from "./secrets.js";

jest.mock("./logging.js", () => ({
  ...(() => {
    const mockLogger = {
      log: jest.fn(),
    };

    return {
      getLogger: jest.fn(() => mockLogger),
      __mockLogger: mockLogger,
    };
  })(),
}));

jest.mock("./secrets.js", () => ({
  readSecret: jest.fn(),
}));

const mockedReadSecret = readSecret as jest.MockedFunction<typeof readSecret>;
const mockedLoggingModule = jest.requireMock("./logging.js") as {
  __mockLogger: {
    log: jest.Mock;
  };
};

function createRoleManagerClient(customEmoji: any = {id: "emoji-id", name: "broker"}) {
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();

  const guildUser = {
    roles: {
      add: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    },
  };

  const brokerMessage = {
    id: "broker-message-id",
    react: jest.fn().mockResolvedValue(undefined),
  };

  const specialMessage = {
    id: "special-message-id",
    react: jest.fn().mockResolvedValue(undefined),
  };

  const roleChannel = {
    messages: {
      fetch: jest.fn(async messageId => {
        if ("broker-message-id" === messageId) {
          return brokerMessage;
        }

        return specialMessage;
      }),
    },
  };

  const guild = {
    emojis: {
      cache: {
        find: jest.fn((predicate: (emoji: any) => boolean) => {
          if (!customEmoji) {
            return undefined;
          }

          return predicate(customEmoji) ? customEmoji : undefined;
        }),
      },
    },
    channels: {
      cache: {
        get: jest.fn(() => roleChannel),
      },
      fetch: jest.fn().mockResolvedValue(roleChannel),
    },
    members: {
      fetch: jest.fn().mockResolvedValue(guildUser),
    },
  };

  const client = {
    guilds: {
      cache: {
        get: jest.fn(() => guild),
      },
      fetch: jest.fn().mockResolvedValue(guild),
    },
    on: jest.fn((eventName, handler) => {
      handlers.set(eventName, handler);
      return client;
    }),
  };

  return {
    client,
    guildUser,
    brokerMessage,
    specialMessage,
    getHandler(eventName: string) {
      return handlers.get(eventName);
    },
  };
}

describe("roleManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadSecret.mockImplementation(secretName => {
      if ("discord_client_ID" === secretName) {
        return "client-id";
      }

      if ("discord_guild_ID" === secretName) {
        return "guild-id";
      }

      if ("hblwrk_role_assignment_channel_ID" === secretName) {
        return "channel-id";
      }

      if ("hblwrk_role_assignment_broker_message_ID" === secretName) {
        return "broker-message-id";
      }

      if ("hblwrk_role_assignment_special_message_ID" === secretName) {
        return "special-message-id";
      }

      if ("hblwrk_role_broker_yes_ID" === secretName) {
        return "broker-yes-role-id";
      }

      return "";
    });
  });

  test("adds and removes role for matching emoji reaction", async () => {
    const {client, guildUser, brokerMessage, getHandler} = createRoleManagerClient();
    const assetRoles = [{
      triggerReference: "hblwrk_role_assignment_broker_message_ID",
      emoji: "✅",
      trigger: "broker-message-id",
      id: "broker-role-id",
      idReference: "hblwrk_role_broker_test_ID",
    }];

    await roleManager(client, assetRoles);
    expect(brokerMessage.react).toHaveBeenCalledWith("✅");

    const reaction = {
      partial: false,
      message: {
        partial: false,
        id: "broker-message-id",
      },
      emoji: {
        id: null,
        name: "✅",
      },
    };
    const user = {
      id: "member-id",
      username: "member-name",
    };

    const addHandler = getHandler("messageReactionAdd");
    await addHandler(reaction, user);

    expect(guildUser.roles.add).toHaveBeenCalledWith("broker-yes-role-id");
    expect(guildUser.roles.add).toHaveBeenCalledWith("broker-role-id");

    const removeHandler = getHandler("messageReactionRemove");
    await removeHandler(reaction, user);

    expect(guildUser.roles.remove).toHaveBeenCalledWith("broker-role-id");
  });

  test("logs warning and skips when custom emoji is missing", async () => {
    const missingEmojiClient = createRoleManagerClient(null);
    const assetRoles = [{
      triggerReference: "hblwrk_role_assignment_broker_message_ID",
      emoji: "custom:missing",
      trigger: "broker-message-id",
      id: "broker-role-id",
      idReference: "hblwrk_role_broker_test_ID",
    }];

    await roleManager(missingEmojiClient.client, assetRoles);

    expect(mockedLoggingModule.__mockLogger.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("custom emoji custom:missing not found"),
    );
  });
});
