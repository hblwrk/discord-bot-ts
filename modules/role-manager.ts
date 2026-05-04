import {getLogger} from "./logging.ts";
import {readSecret} from "./secrets.ts";

const logger = getLogger();

type ManagedRoleAsset = {
  emoji: string;
  id: string;
  idReference: string;
  name?: string;
  trigger: string | string[];
  triggerReference: string;
};
type RoleEmoji = {
  id: string;
  name: string | null;
};
type RoleAssignmentMessage = {
  id?: string;
  react: (emoji: string) => Promise<unknown>;
};
type RoleFetchChannel = {
  messages: {
    fetch: (messageId: string) => Promise<RoleAssignmentMessage | undefined>;
  };
};
type RoleGuildMember = {
  roles: {
    add: (roleId: string) => Promise<unknown>;
    remove: (roleId: string) => Promise<unknown>;
  };
};
type RoleGuild = {
  emojis: {
    cache: {
      find: (predicate: (emoji: RoleEmoji) => boolean) => RoleEmoji | undefined;
    };
  };
  channels: {
    cache: {
      get: (channelId: string) => unknown;
    };
    fetch: (channelId: string) => Promise<unknown>;
  };
  members: {
    fetch: (userId: string) => Promise<unknown>;
  };
};
type RoleReaction = {
  partial: boolean;
  fetch?: () => Promise<unknown>;
  message: {
    partial: boolean;
    fetch?: () => Promise<unknown>;
    id: string;
  };
  emoji: {
    id: string | null;
    name?: string | null;
  };
};
type RoleUser = {
  id: string;
  username?: string;
};
type RoleReactionHandler = (...args: unknown[]) => Promise<void>;
type RoleManagerClient = {
  guilds: {
    cache: {
      get: (guildId: string) => unknown;
    };
    fetch: (guildId: string) => Promise<unknown>;
  };
  on: (eventName: "messageReactionAdd" | "messageReactionRemove", handler: RoleReactionHandler) => unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value;
}

function isRoleGuild(value: unknown): value is RoleGuild {
  if (!isRecord(value)) {
    return false;
  }

  const emojis = value["emojis"];
  const channels = value["channels"];
  const members = value["members"];
  if (!isRecord(emojis) || !isRecord(channels) || !isRecord(members)) {
    return false;
  }

  const emojiCache = emojis["cache"];
  const channelCache = channels["cache"];
  return isRecord(emojiCache)
    && "function" === typeof emojiCache["find"]
    && isRecord(channelCache)
    && "function" === typeof channelCache["get"]
    && "function" === typeof channels["fetch"]
    && "function" === typeof members["fetch"];
}

function hasRoleMessageFetch(channel: unknown): channel is RoleFetchChannel {
  if (!isRecord(channel)) {
    return false;
  }

  const messages = channel["messages"];
  return isRecord(messages) && "function" === typeof messages["fetch"];
}

function isRoleGuildMember(value: unknown): value is RoleGuildMember {
  if (!isRecord(value)) {
    return false;
  }

  const roles = value["roles"];
  return isRecord(roles)
    && "function" === typeof roles["add"]
    && "function" === typeof roles["remove"];
}

function isRoleReaction(value: unknown): value is RoleReaction {
  if (!isRecord(value)) {
    return false;
  }

  const message = value["message"];
  const emoji = value["emoji"];
  return "boolean" === typeof value["partial"]
    && isRecord(message)
    && "boolean" === typeof message["partial"]
    && "string" === typeof message["id"]
    && isRecord(emoji)
    && (null === emoji["id"] || "string" === typeof emoji["id"])
    && (undefined === emoji["name"] || null === emoji["name"] || "string" === typeof emoji["name"]);
}

function isRoleUser(value: unknown): value is RoleUser {
  return isRecord(value)
    && "string" === typeof value["id"]
    && (undefined === value["username"] || "string" === typeof value["username"]);
}

export async function roleManager(client: RoleManagerClient, assetRoles: ManagedRoleAsset[]) {
  // Cache existing messages
  const clientId = readSecret("discord_client_ID").trim();
  const guildId = readSecret("discord_guild_ID").trim();
  const channelId = readSecret("hblwrk_role_assignment_channel_ID").trim();
  const brokerYesRole = readSecret("hblwrk_role_broker_yes_ID").trim();
  const brokerMessageId = readSecret("hblwrk_role_assignment_broker_message_ID").trim();
  const specialMessageId = readSecret("hblwrk_role_assignment_special_message_ID").trim();

  if ("" === guildId || "" === channelId || "" === brokerMessageId || "" === specialMessageId) {
    logger.log(
      "warn",
      "Skipping role manager: missing guild/channel/message IDs for role assignment.",
    );
    return;
  }

  const cachedGuild = client.guilds.cache.get(guildId);
  const fetchedGuild = isRoleGuild(cachedGuild) ? cachedGuild : await client.guilds.fetch(guildId).catch((error: unknown) => {
    logger.log(
      "error",
      `Role manager: unable to fetch guild ${guildId}: ${error}`,
    );
    return undefined;
  });
  const guild = isRoleGuild(fetchedGuild) ? fetchedGuild : undefined;
  if (!guild) {
    return;
  }
  const roleGuild = guild;

  const cachedChannel = roleGuild.channels.cache.get(channelId);
  const fetchedChannel = hasRoleMessageFetch(cachedChannel) ? cachedChannel : await roleGuild.channels.fetch(channelId).catch((error: unknown) => {
    logger.log(
      "error",
      `Role manager: unable to fetch channel ${channelId}: ${error}`,
    );
    return undefined;
  });
  if (!hasRoleMessageFetch(fetchedChannel)) {
    logger.log(
      "error",
      `Role manager: channel ${channelId} is not a message channel.`,
    );
    return;
  }

  const roleChannel = fetchedChannel;

  const brokerMessage = await roleChannel.messages.fetch(brokerMessageId).catch((error: unknown) => {
    logger.log(
      "error",
      `Role manager: unable to fetch broker message ${brokerMessageId}: ${error}`,
    );
  });
  const specialMessage = await roleChannel.messages.fetch(specialMessageId).catch((error: unknown) => {
    logger.log(
      "error",
      `Role manager: unable to fetch special message ${specialMessageId}: ${error}`,
    );
  });
  if (!brokerMessage || !specialMessage) {
    return;
  }

  // Bootstrap message with emojis if they do not already exist
  for (const role of assetRoles) {
    if ("hblwrk_role_assignment_broker_message_ID" === role.triggerReference) {
      let emoji = "";
      if (role.emoji.startsWith("custom:")) {
        const customEmoji = roleGuild.emojis.cache.find((emoji: RoleEmoji) => emoji.name === role.emoji.replace("custom:", ""));
        if (!customEmoji) {
          logger.log(
            "warn",
            `Role manager: custom emoji ${role.emoji} not found.`,
          );
          continue;
        }

        emoji = customEmoji.id;
      } else {
        emoji = role.emoji;
      }

      await brokerMessage.react(emoji).catch((error: unknown) => {
        logger.log(
          "error",
          `Role manager: unable to add reaction ${emoji} on broker message: ${error}`,
        );
      });
    } else if ("hblwrk_role_assignment_special_message_ID" === role.triggerReference) {
      let emoji = "";
      if (role.emoji.startsWith("custom:")) {
        const customEmoji = roleGuild.emojis.cache.find((emoji: RoleEmoji) => emoji.name === role.emoji.replace("custom:", ""));
        if (!customEmoji) {
          logger.log(
            "warn",
            `Role manager: custom emoji ${role.emoji} not found.`,
          );
          continue;
        }

        emoji = customEmoji.id;
      } else {
        emoji = role.emoji;
      }
      await specialMessage.react(emoji).catch((error: unknown) => {
        logger.log(
          "error",
          `Role manager: unable to add reaction ${emoji} on special message: ${error}`,
        );
      });
    }
  }

  // Assign user-role based on emoji selection
  client.on("messageReactionAdd", async (reaction, user) => {
    if (!isRoleReaction(reaction) || !isRoleUser(user)) {
      return;
    }

    await addRemoveRole(reaction, user, "add");
  });

  // Remove user-role based on emoji selection
  client.on("messageReactionRemove", async (reaction, user) => {
    if (!isRoleReaction(reaction) || !isRoleUser(user)) {
      return;
    }

    await addRemoveRole(reaction, user, "remove");
  });

  async function addRemoveRole(reaction: RoleReaction, user: RoleUser, action: "add" | "remove") {
    if (reaction.partial) {
      if (!reaction.fetch) {
        return;
      }

      const fetchedReaction = await reaction.fetch().catch((error: unknown) => {
        logger.log(
          "error",
          `Role manager: unable to fetch partial reaction: ${error}`,
        );
      });
      if (!fetchedReaction) {
        return;
      }
    }

    if (reaction.message.partial) {
      if (!reaction.message.fetch) {
        return;
      }

      const fetchedMessage = await reaction.message.fetch().catch((error: unknown) => {
        logger.log(
          "error",
          `Role manager: unable to fetch partial message: ${error}`,
        );
      });
      if (!fetchedMessage) {
        return;
      }
    }

    for (const role of assetRoles) {
      const emoji = role.emoji.startsWith("custom:")
        ? roleGuild.emojis.cache.find((customEmoji: RoleEmoji) => customEmoji.name === role.emoji.replace("custom:", ""))?.id
        : role.emoji;
      if (!emoji) {
        continue;
      }

      const reactionEmoji = reaction.emoji.id ?? reaction.emoji.name ?? "";

      const roleTriggers = Array.isArray(role.trigger) ? role.trigger : [role.trigger];
      if (roleTriggers.includes(reaction.message.id) && emoji === reactionEmoji && clientId !== user.id) {
        const fetchedGuildUser = await roleGuild.members.fetch(user.id).catch((error: unknown) => {
          logger.log(
            "error",
            `Role manager: unable to fetch guild user ${user.id}: ${error}`,
          );
          return undefined;
        });
        if (!isRoleGuildMember(fetchedGuildUser)) {
          continue;
        }

        if ("remove" === action) {
          await fetchedGuildUser.roles.remove(role.id).catch((error: unknown) => {
            logger.log(
              "error",
              `Role manager: unable to remove role ${role.id} from ${user.id}: ${error}`,
            );
          });
          logger.log(
            "debug",
            `Removing role ${role.id} (${role.idReference}) from user ${user.id} (${user.username})`,
          );
        } else if ("add" === action) {
          await fetchedGuildUser.roles.add(brokerYesRole).catch((error: unknown) => {
            logger.log(
              "error",
              `Role manager: unable to add broker role ${brokerYesRole} for ${user.id}: ${error}`,
            );
          });
          await fetchedGuildUser.roles.add(role.id).catch((error: unknown) => {
            logger.log(
              "error",
              `Role manager: unable to add role ${role.id} for ${user.id}: ${error}`,
            );
          });
          logger.log(
            "debug",
            `Assigning role ${role.id} (${role.idReference}) to user ${user.id} (${user.username})`,
          );
        }
      }
    }
  }
}
