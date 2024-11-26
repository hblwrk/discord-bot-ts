import Transport from "winston-transport";
import {Client, TextChannel, MessageEmbed} from "discord.js";
import {readSecret} from "./secrets.js";

export default class DiscordTransport extends Transport {
  public client: Client;
  public channelId: string;

  constructor(options) {
    super(options);
    this.client = options.client;
    this.channelId = readSecret("hblwrk_channel_logging_ID");
  }

  log(info, callback) {
    setImmediate(() => {
      this.emit("logged", info);

      const loggingEmbed = new MessageEmbed()
        .setColor("#0099ff")
        .setTitle("Leopold logging")
        .setDescription(info.message)
        .addFields(
          {name: "Timestamp", value: info.timestamp, inline: true},
          {name: "User", value: info.username, inline: true},
          {name: "Channel", value: info.channel, inline: true},
        );
      const channel = this.client.channels.cache.get(this.channelId);
      (channel as TextChannel).send({embeds: [loggingEmbed]}).catch(error => {
        console.log(
          "error",
          `Error posting to logging channel: ${error}`,
        );
      });
    });

    callback();
  }
}
