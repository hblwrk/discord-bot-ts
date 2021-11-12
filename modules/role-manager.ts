import {getLogger} from "./logging";
import {readSecret} from "./secrets";

const logger = getLogger();

export async function roleManager(client, assetRoles) {
  // Cache existing messages
  const clientId = readSecret("discord_clientID");
  const guildId = readSecret("discord_guildID");
  const channelId = readSecret("hblwrk_role_assignment_channelID");
  const brokerYesRole = readSecret("hblwrk_role_broker_yes_ID");

  const brokerMessage = await client.guilds.cache.get(guildId).channels.cache.get(channelId).messages.fetch(readSecret("hblwrk_role_assignment_broker_messageID"));
  const specialMessage = await client.guilds.cache.get(guildId).channels.cache.get(channelId).messages.fetch(readSecret("hblwrk_role_assignment_special_messageID"));

  // Bootstrap message with emojis if they do not already exist
  for (const role of assetRoles) {
    if ("hblwrk_role_assignment_broker_messageID" === role.triggerReference) {
      let emoji = "";
      if (role.emoji.startsWith("custom:")) {
        emoji = client.guilds.cache.get(guildId).emojis.cache.find(emoji => emoji.name === role.emoji.replace("custom:", "")).id;
      } else {
        emoji = role.emoji;
      }

      brokerMessage.react(emoji);
    } else if ("hblwrk_role_assignment_special_messageID" === role.triggerReference) {
      let emoji = "";
      if (role.emoji.startsWith("custom:")) {
        emoji = client.guilds.cache.get(guildId).emojis.cache.find(emoji => emoji.name === role.emoji.replace("custom:", "")).id;
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
    for (const role of assetRoles) {
      let emoji = "";
      let reactionEmoji = "";
      if (role.emoji.startsWith("custom:")) {
        emoji = client.guilds.cache.get(guildId).emojis.cache.find(emoji => emoji.name === role.emoji.replace("custom:", "")).id;
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
        const guildUser = await client.guilds.cache.get(guildId).members.fetch(user.id);
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
