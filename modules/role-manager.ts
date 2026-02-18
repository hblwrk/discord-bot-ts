import {getLogger} from "./logging.js";
import {readSecret} from "./secrets.js";

const logger = getLogger();

export async function roleManager(client, assetRoles) {
  // Cache existing messages
  const clientId = readSecret("discord_clientID").trim();
  const guildId = readSecret("discord_guildID").trim();
  const channelId = readSecret("hblwrk_role_assignment_channelID").trim();
  const brokerYesRole = readSecret("hblwrk_role_broker_yes_ID").trim();
  const brokerMessageId = readSecret("hblwrk_role_assignment_broker_messageID").trim();
  const specialMessageId = readSecret("hblwrk_role_assignment_special_messageID").trim();

  if ("" === guildId || "" === channelId || "" === brokerMessageId || "" === specialMessageId) {
    logger.log(
      "warn",
      "Skipping role manager: missing guild/channel/message IDs for role assignment.",
    );
    return;
  }

  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(error => {
    logger.log(
      "error",
      `Role manager: unable to fetch guild ${guildId}: ${error}`,
    );
  });
  if (!guild) {
    return;
  }

  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(error => {
    logger.log(
      "error",
      `Role manager: unable to fetch channel ${channelId}: ${error}`,
    );
  });
  if (!channel) {
    return;
  }

  if (!(channel as any).messages?.fetch) {
    logger.log(
      "error",
      `Role manager: channel ${channelId} is not a message channel.`,
    );
    return;
  }

  const roleChannel = channel as any;

  const brokerMessage = await roleChannel.messages.fetch(brokerMessageId).catch(error => {
    logger.log(
      "error",
      `Role manager: unable to fetch broker message ${brokerMessageId}: ${error}`,
    );
  });
  const specialMessage = await roleChannel.messages.fetch(specialMessageId).catch(error => {
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
    if ("hblwrk_role_assignment_broker_messageID" === role.triggerReference) {
      let emoji = "";
      if (role.emoji.startsWith("custom:")) {
        const customEmoji = guild.emojis.cache.find(emoji => emoji.name === role.emoji.replace("custom:", ""));
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

      brokerMessage.react(emoji);
    } else if ("hblwrk_role_assignment_special_messageID" === role.triggerReference) {
      let emoji = "";
      if (role.emoji.startsWith("custom:")) {
        const customEmoji = guild.emojis.cache.find(emoji => emoji.name === role.emoji.replace("custom:", ""));
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
      specialMessage.react(emoji);
    }
  }

  // Assign user-role based on emoji selection
  client.on("messageReactionAdd", async (reaction, user) => {
    await addRemoveRole(reaction, user, "add");
  });

  // Remove user-role based on emoji selection
  client.on("messageReactionRemove", async (reaction, user) => {
    await addRemoveRole(reaction, user, "remove");
  });

  async function addRemoveRole(reaction, user, action) {
    if (reaction.partial) {
      await reaction.fetch().catch(error => {
        logger.log(
          "error",
          `Role manager: unable to fetch partial reaction: ${error}`,
        );
      });
    }

    if (reaction.message.partial) {
      await reaction.message.fetch().catch(error => {
        logger.log(
          "error",
          `Role manager: unable to fetch partial message: ${error}`,
        );
      });
    }

    for (const role of assetRoles) {
      let emoji = "";
      let reactionEmoji = "";
      if (role.emoji.startsWith("custom:")) {
        const customEmoji = guild.emojis.cache.find(emoji => emoji.name === role.emoji.replace("custom:", ""));
        if (!customEmoji) {
          continue;
        }

        emoji = customEmoji.id;
      } else {
        emoji = role.emoji;
      }

      if (null === reaction.emoji.id) {
        // Native emoji
        reactionEmoji = reaction.emoji.name;
      } else {
        // Custom emoji
        reactionEmoji = reaction.emoji.id;
      }

      if (role.trigger === reaction.message.id && emoji === reactionEmoji && clientId !== user.id) {
        const guildUser = await guild.members.fetch(user.id);
        if ("remove" === action) {
          guildUser.roles.remove(role.id);
          logger.log(
            "debug",
            `Removing role ${role.id} (${role.idReference}) from user ${user.id} (${user.username})`,
          );
        } else if ("add" === action) {
          guildUser.roles.add(brokerYesRole);
          guildUser.roles.add(role.id);
          logger.log(
            "debug",
            `Assigning role ${role.id} (${role.idReference}) to user ${user.id} (${user.username})`,
          );
        }
      }
    }
  }
}
