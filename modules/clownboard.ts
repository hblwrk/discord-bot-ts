
import {EmbedBuilder} from "discord.js";
import type {Client, TextChannel} from "discord.js";
import {getLogger} from "./logging.ts";

const logger = getLogger();

export function clownboard(client: Client, channelID: string) {
  const reactionThreshold = 9;
  const clownEmojiName = "🤡";
  const clownEmojiId = clownEmojiName;
  // Using custom "pepeclown"
  // const clownEmojiName = "pepeclown";
  // const clownEmojiId = client.emojis.cache.find(emoji => emoji.name === clownEmojiName);

  function getClownboardChannel() {
    const channel = client.channels.cache.get(channelID);
    if (!channel || !("messages" in channel)) {
      return null;
    }

    return channel as TextChannel;
  }

  client.on("messageReactionAdd", async (reaction, _user) => {
    const handleClownboard = async () => {
      const clownboard = getClownboardChannel();
      if (!clownboard) {
        logger.log(
          "error",
          `Clownboard channel ${channelID} not found or not text based.`,
        );
        return;
      }

      const reactionCount = reaction.count ?? 0;
      const messages = await clownboard.messages.fetch({limit: 100});
      const existingMessages = messages.find(message =>
        message.embeds.length === 1 ? (Boolean(message.embeds[0]?.footer?.text.startsWith(reaction.message.id))) : false);
      if (existingMessages) {
        await existingMessages.edit(`${clownEmojiId} **${reactionCount}** ${reaction.message.channel}`).catch(error => {
          logger.log(
            "error",
            `Error updating clownboard message: ${error}`,
          );
        });
      } else {
        const attachment = reaction.message.attachments.first();
        const author = reaction.message.author;
        if (!author) {
          return;
        }

        if (undefined === attachment) {
          const embed = new EmbedBuilder()
            .setAuthor({
              name: author.tag,
              iconURL: author.displayAvatarURL(),
            })
            .setDescription(reaction.message.content)
            .setFooter({
              text: reaction.message.id,
            })
            .addFields(
              {name: "Source", value: `[Jump!](${reaction.message.url})`, inline: true},
            );
          clownboard.send({content: `${clownEmojiId} **${reactionThreshold + 1}** ${reaction.message.channel}`, embeds: [embed]}).catch(error => {
            logger.log(
              "error",
              `Error posting to clownboard: ${error}`,
            );
          });
        } else {
          const embed = new EmbedBuilder()
            .setAuthor({
              name: author.tag,
              iconURL: author.displayAvatarURL(),
            })
            .setImage(attachment.url)
            .setDescription(reaction.message.content)
            .setFooter({
              text: reaction.message.id,
            })
            .addFields(
              {name: "Source", value: `[Jump!](${reaction.message.url})`, inline: true},
            );
          clownboard.send({content: `${clownEmojiId} **${reactionThreshold + 1}** ${reaction.message.channel}`, embeds: [embed]}).catch(error => {
            logger.log(
              "error",
              `Error posting to clownboard: ${error}`,
            );
          });
        }
      }
    };

    if (clownEmojiName === reaction.emoji.name && reactionThreshold < (reaction.count ?? 0)) {
      if (channelID === reaction.message.channel.id) {
        return;
      }

      if (reaction.message.partial) {
        await reaction.fetch();
        await reaction.message.fetch();
        await handleClownboard();
      } else {
        await handleClownboard();
      }
    }
  });

  client.on("messageReactionRemove", async (reaction, _user) => {
    const handleClownboard = async () => {
      const clownboard = getClownboardChannel();
      if (!clownboard) {
        logger.log(
          "error",
          `Clownboard channel ${channelID} not found or not text based.`,
        );
        return;
      }

      const reactionCount = reaction.count ?? 0;
      const messages = await clownboard.messages.fetch({limit: 100});
      const existingMessages = messages.find(message =>
        message.embeds.length === 1 ? (Boolean(message.embeds[0]?.footer?.text.startsWith(reaction.message.id))) : false);
      if (existingMessages) {
        if (reactionThreshold === reactionCount) {
          setTimeout(() => {
            existingMessages.delete().catch(error => {
              logger.log(
                "error",
                `Error removing clownboard message: ${error}`,
              );
            });
          }, 2500);
        } else {
          await existingMessages.edit(`${clownEmojiId} **${reactionCount}** ${reaction.message.channel}`).catch(error => {
            logger.log(
              "error",
              `Error updating clownboard message: ${error}`,
            );
          });
        }
      }
    };

    if (clownEmojiName === reaction.emoji.name) {
      if (channelID === reaction.message.channel.id) {
        return;
      }

      if (reaction.message.partial) {
        await reaction.fetch();
        await reaction.message.fetch();
        await handleClownboard();
      } else {
        await handleClownboard();
      }
    }
  });
}
