/* eslint-disable import/extensions */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import {TextChannel, MessageEmbed} from "discord.js";
import {getLogger} from "./logging";

const logger = getLogger();

export function clownboard(client, channelID) {
  const reactionThreshold = 0;
  const clownEmojiName = "🤡";
  const clownEmojiId = clownEmojiName;
  // Using custom "pepeclown"
  // const clownEmojiName = "pepeclown";
  // const clownEmojiId = client.emojis.cache.find(emoji => emoji.name === clownEmojiName);

  client.on("messageReactionAdd", async (reaction, user) => {
    const handleClownboard = async () => {
      const clownboard = client.channels.cache.get(channelID);
      const messages = await clownboard.messages.fetch({limit: 100});
      const existingMessages = messages.find(message =>
        message.embeds.length === 1 ? (Boolean(message.embeds[0].footer.text.startsWith(reaction.message.id))) : false);
      if (existingMessages) {
        existingMessages.edit(`${clownEmojiId} ${reaction.count}`);
      } else if (undefined === reaction.message.attachments.first()) {
        const embed = new MessageEmbed()
          .setAuthor({
            name: reaction.message.author.tag,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            iconURL: reaction.message.author.displayAvatarURL(),
          })
          .setDescription(reaction.message.content)
          .setFooter({
            text: reaction.message.id,
          })
          .addFields(
            {name: "Source", value: `[Jump!](${reaction.message.url})`, inline: true},
          );
        if (clownboard) {
          (clownboard as TextChannel).send({content: `${clownEmojiId} **${reactionThreshold + 1}** ${reaction.message.channel}`, embeds: [embed]}).catch(error => {
            console.log(
              "error",
              error,
            );
          });
        }
      } else {
        const embed = new MessageEmbed()
          .setAuthor({
            name: reaction.message.author.tag,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            iconURL: reaction.message.author.displayAvatarURL(),
          })
          .setImage(reaction.message.attachments.first().url)
          .setDescription(reaction.message.content)
          .setFooter({
            text: reaction.message.id,
          })
          .addFields(
            {name: "Source", value: `[Jump!](${reaction.message.url})`, inline: true},
          );
        if (clownboard) {
          (clownboard as TextChannel).send({content: `${clownEmojiId} **${reactionThreshold + 1}** ${reaction.message.channel}`, embeds: [embed]}).catch(error => {
            console.log(
              "error",
              error,
            );
          });
        }
      }
    };

    if (clownEmojiName === reaction.emoji.name && reactionThreshold < reaction.count) {
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

  client.on("messageReactionRemove", async (reaction, user) => {
    const handleClownboard = async () => {
      const clownboard = client.channels.cache.get(channelID);
      const messages = await clownboard.messages.fetch({limit: 100});
      const existingMessages = messages.find(message =>
        message.embeds.length === 1 ? (Boolean(message.embeds[0].footer.text.startsWith(reaction.message.id))) : false);
      if (existingMessages) {
        if (reactionThreshold === reaction.count) {
          existingMessages.delete({timeout: 2500});
        } else {
          existingMessages.edit(`${clownEmojiId} **${reaction.count}**`);
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
