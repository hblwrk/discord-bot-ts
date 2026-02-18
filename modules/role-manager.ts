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

      await brokerMessage.react(emoji).catch(error => {
        logger.log(
          "error",
          `Role manager: unable to add reaction ${emoji} on broker message: ${error}`,
        );
      });
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
      await specialMessage.react(emoji).catch(error => {
        logger.log(
          "error",
          `Role manager: unable to add reaction ${emoji} on special message: ${error}`,
        );
      });
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
      const fetchedReaction = await reaction.fetch().catch(error => {
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
      const fetchedMessage = await reaction.message.fetch().catch(error => {
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
        const guildUser = await guild.members.fetch(user.id).catch(error => {
          logger.log(
            "error",
            `Role manager: unable to fetch guild user ${user.id}: ${error}`,
          );
        });
        if (!guildUser) {
          continue;
        }

        if ("remove" === action) {
          await guildUser.roles.remove(role.id).catch(error => {
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
          await guildUser.roles.add(brokerYesRole).catch(error => {
            logger.log(
              "error",
              `Role manager: unable to add broker role ${brokerYesRole} for ${user.id}: ${error}`,
            );
          });
          await guildUser.roles.add(role.id).catch(error => {
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
