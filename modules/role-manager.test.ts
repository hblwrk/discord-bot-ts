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

type EventHandler = (...args: unknown[]) => Promise<void>;
type RoleManagerTestClient = {
  guilds: {
    cache: {
      get: jest.Mock;
    };
    fetch: jest.Mock;
  };
  on: jest.MockedFunction<(eventName: string, handler: EventHandler) => RoleManagerTestClient>;
};

type TestEmoji = {
  id: string;
  name: string;
};

function createRoleManagerClient(customEmoji: TestEmoji | null = {id: "emoji-id", name: "broker"}) {
  const handlers = new Map<string, EventHandler>();

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
        find: jest.fn((predicate: (emoji: TestEmoji) => boolean) => {
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

  const client = {} as RoleManagerTestClient;
  client.guilds = {
      cache: {
        get: jest.fn(() => guild),
      },
      fetch: jest.fn().mockResolvedValue(guild),
  };
  client.on = jest.fn((eventName: string, handler: EventHandler) => {
    handlers.set(eventName, handler);
    return client;
  });

  return {
    client,
    guildUser,
    brokerMessage,
    specialMessage,
    getHandler(eventName: string) {
      const handler = handlers.get(eventName);
      if (!handler) {
        throw new Error(`Missing handler for ${eventName}.`);
      }

      return handler;
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

  test("bootstraps and assigns alerts role from the special roles message via bellhop emoji", async () => {
    const {client, guildUser, specialMessage, getHandler} = createRoleManagerClient();
    const assetRoles = [{
      name: "alerts",
      triggerReference: "hblwrk_role_assignment_special_message_ID",
      emoji: "🛎️",
      trigger: "special-message-id",
      id: "alerts-role-id",
      idReference: "hblwrk_role_special_alerts_ID",
    }];

    await roleManager(client, assetRoles);
    expect(specialMessage.react).toHaveBeenCalledWith("🛎️");

    const reaction = {
      partial: false,
      message: {
        partial: false,
        id: "special-message-id",
      },
      emoji: {
        id: null,
        name: "🛎️",
      },
    };
    const user = {
      id: "member-id",
      username: "member-name",
    };

    const addHandler = getHandler("messageReactionAdd");
    await addHandler(reaction, user);

    expect(guildUser.roles.add).toHaveBeenCalledWith("broker-yes-role-id");
    expect(guildUser.roles.add).toHaveBeenCalledWith("alerts-role-id");
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
