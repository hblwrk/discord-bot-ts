import type {Mock, MockedFunction} from "vitest";
import {roleManager} from "./role-manager.ts";
import {readSecret} from "./secrets.ts";
import {beforeEach, describe, expect, test, vi} from "vitest";

const mockLogger = vi.hoisted(() => ({
  log: vi.fn(),
}));

vi.mock("./logging.ts", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("./secrets.ts", () => ({
  readSecret: vi.fn(),
}));

const mockedReadSecret = readSecret as MockedFunction<typeof readSecret>;

type EventHandler = (...args: unknown[]) => Promise<void>;
type RoleManagerTestClient = {
  guilds: {
    cache: {
      get: Mock;
    };
    fetch: Mock;
  };
  on: MockedFunction<(eventName: string, handler: EventHandler) => RoleManagerTestClient>;
};

type TestEmoji = {
  id: string;
  name: string;
};

function createRoleManagerClient(customEmoji: TestEmoji | null = {id: "emoji-id", name: "broker"}) {
  const handlers = new Map<string, EventHandler>();

  const guildUser = {
    roles: {
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };

  const brokerMessage = {
    id: "broker-message-id",
    react: vi.fn().mockResolvedValue(undefined),
  };

  const specialMessage = {
    id: "special-message-id",
    react: vi.fn().mockResolvedValue(undefined),
  };

  const roleChannel = {
    messages: {
      fetch: vi.fn(async (messageId: string): Promise<typeof brokerMessage | typeof specialMessage | undefined> => {
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
        find: vi.fn((predicate: (emoji: TestEmoji) => boolean) => {
          if (!customEmoji) {
            return undefined;
          }

          return predicate(customEmoji) ? customEmoji : undefined;
        }),
      },
    },
    channels: {
      cache: {
        get: vi.fn((_channelId: string): typeof roleChannel | undefined => roleChannel),
      },
      fetch: vi.fn().mockResolvedValue(roleChannel),
    },
    members: {
      fetch: vi.fn().mockResolvedValue(guildUser),
    },
  };

  const client = {} as RoleManagerTestClient;
  client.guilds = {
      cache: {
        get: vi.fn(() => guild),
      },
      fetch: vi.fn().mockResolvedValue(guild),
  };
  client.on = vi.fn((eventName: string, handler: EventHandler) => {
    handlers.set(eventName, handler);
    return client;
  });

  return {
    client,
    guild,
    guildUser,
    brokerMessage,
    roleChannel,
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
    vi.clearAllMocks();
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

    expect(mockLogger.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("custom emoji custom:missing not found"),
    );

    const addHandler = missingEmojiClient.getHandler("messageReactionAdd");
    await addHandler({
      partial: false,
      message: {
        partial: false,
        id: "broker-message-id",
      },
      emoji: {
        id: "emoji-id",
        name: null,
      },
    }, {
      id: "member-id",
      username: "member-name",
    });

    expect(missingEmojiClient.guild.members.fetch).not.toHaveBeenCalled();
  });

  test("skips setup when role-assignment configuration is incomplete", async () => {
    mockedReadSecret.mockImplementation(secretName => {
      if ("discord_guild_ID" === secretName) {
        return "";
      }

      return "configured";
    });
    const {client} = createRoleManagerClient();

    await roleManager(client, []);

    expect(client.on).not.toHaveBeenCalled();
    expect(mockLogger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping role manager: missing guild/channel/message IDs for role assignment.",
    );
  });

  test("uses Discord fetch fallbacks and assigns custom-emoji roles after resolving partials", async () => {
    const {client, guild, guildUser, brokerMessage, getHandler} = createRoleManagerClient({
      id: "emoji-id",
      name: "broker",
    });
    client.guilds.cache.get.mockReturnValue(undefined);
    guild.channels.cache.get.mockReturnValue(undefined);
    const assetRoles = [{
      triggerReference: "hblwrk_role_assignment_broker_message_ID",
      emoji: "custom:broker",
      trigger: ["broker-message-id"],
      id: "broker-role-id",
      idReference: "hblwrk_role_broker_test_ID",
    }];

    await roleManager(client, assetRoles);

    expect(client.guilds.fetch).toHaveBeenCalledWith("guild-id");
    expect(guild.channels.fetch).toHaveBeenCalledWith("channel-id");
    expect(brokerMessage.react).toHaveBeenCalledWith("emoji-id");

    const reaction = {
      partial: true,
      fetch: vi.fn().mockResolvedValue({}),
      message: {
        partial: true,
        fetch: vi.fn().mockResolvedValue({}),
        id: "broker-message-id",
      },
      emoji: {
        id: "emoji-id",
        name: null,
      },
    };
    const user = {
      id: "member-id",
      username: "member-name",
    };

    const addHandler = getHandler("messageReactionAdd");
    await addHandler(reaction, user);

    expect(reaction.fetch).toHaveBeenCalledTimes(1);
    expect(reaction.message.fetch).toHaveBeenCalledTimes(1);
    expect(guildUser.roles.add).toHaveBeenCalledWith("broker-yes-role-id");
    expect(guildUser.roles.add).toHaveBeenCalledWith("broker-role-id");
  });

  test("ignores invalid reactions and the bot user's own reactions", async () => {
    const {client, guild, getHandler} = createRoleManagerClient();
    const assetRoles = [{
      triggerReference: "hblwrk_role_assignment_broker_message_ID",
      emoji: "✅",
      trigger: "broker-message-id",
      id: "broker-role-id",
      idReference: "hblwrk_role_broker_test_ID",
    }];

    await roleManager(client, assetRoles);
    guild.members.fetch.mockClear();

    const addHandler = getHandler("messageReactionAdd");
    await addHandler({invalid: true}, {id: "member-id"});
    const removeHandler = getHandler("messageReactionRemove");
    await removeHandler({invalid: true}, {id: "member-id"});
    await addHandler({
      partial: false,
      message: {
        partial: false,
        id: "broker-message-id",
      },
      emoji: {
        id: null,
        name: "✅",
      },
    }, {
      id: "client-id",
      username: "bot-user",
    });

    expect(guild.members.fetch).not.toHaveBeenCalled();
  });
});
