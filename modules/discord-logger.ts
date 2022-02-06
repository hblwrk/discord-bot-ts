import Transport from "winston-transport";
import {Client, TextChannel, MessageEmbed} from "discord.js";
import {readSecret} from "./secrets";

export default class DiscordTransport extends Transport {
  public client: Client;
  public channelID: string;

  constructor(opts) {
    super(opts);
    this.client = opts.client;
    this.channelID = readSecret("hblwrk_channel_logging_ID");
  }

  log(info, callback) {
    setImmediate(() => {
      this.emit('logged', info);

      const loggingEmbed = new MessageEmbed()
        .setColor('#0099ff')
        .setTitle('Leopold logging')
        .setDescription(info.message)
        .addFields(
          { name: 'Timestamp', value: info.timestamp, inline: true },
          { name: 'User', value: info.username, inline: true }, 
          { name: 'Channel', value: info.channel, inline: true },
        );
      const channel = this.client.channels.cache.get(this.channelID);
      (<TextChannel> channel).send({ embeds: [loggingEmbed] }).catch(error => {
        console.log(
          "error",
          error,
        );
      });
    });

    callback();
  }
};