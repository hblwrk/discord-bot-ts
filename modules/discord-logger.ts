import Transport from "winston-transport";
import {EmbedBuilder} from "discord.js";
import {readSecret} from "./secrets.ts";

type DiscordLogChannel = {
  isTextBased: () => boolean;
  send: (payload: {embeds: EmbedBuilder[]}) => Promise<unknown>;
};

export type DiscordTransportClient = {
  channels: {
    cache: {
      get: (channelId: string) => unknown;
    };
  };
};

type DiscordTransportOptions = Transport.TransportStreamOptions & {
  client: DiscordTransportClient;
};

type LogInfo = {
  channel?: unknown;
  message?: unknown;
  timestamp?: unknown;
  username?: unknown;
};

function getLogField(value: unknown): string {
  if ("string" === typeof value) {
    return value;
  }

  return undefined === value ? "" : String(value);
}

export default class DiscordTransport extends Transport {
  public client: DiscordTransportClient;
  public channelId: string;

  constructor(options: DiscordTransportOptions) {
    super(options);
    this.client = options.client;
    this.channelId = readSecret("hblwrk_channel_logging_ID");
  }

  public override log(info: LogInfo, callback: () => void) {
    setImmediate(() => {
      this.emit("logged", info);

      const loggingEmbed = new EmbedBuilder()
        .setColor("#0099ff")
        .setTitle("Leopold logging")
        .setDescription(getLogField(info.message))
        .addFields(
          {name: "Timestamp", value: getLogField(info.timestamp), inline: true},
          {name: "User", value: getLogField(info.username), inline: true},
          {name: "Channel", value: getLogField(info.channel), inline: true},
        );
      const channel = this.client.channels.cache.get(this.channelId);
      if (!isDiscordLogChannel(channel)) {
        return;
      }

      channel.send({embeds: [loggingEmbed]}).catch(error => {
        console.log(
          "error",
          `Error posting to logging channel: ${error}`,
        );
      });
    });

    callback();
  }
}

function isDiscordLogChannel(channel: unknown): channel is DiscordLogChannel {
  return "object" === typeof channel
    && null !== channel
    && "isTextBased" in channel
    && "function" === typeof channel.isTextBased
    && true === channel.isTextBased()
    && "send" in channel
    && "function" === typeof channel.send;
}
