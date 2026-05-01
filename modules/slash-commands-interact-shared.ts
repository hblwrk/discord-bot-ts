import {type Interaction} from "discord.js";
import {type DiscordTransportClient} from "./discord-logger.ts";

export const noMentions = {
  parse: [],
};

export type SlashCommandMember = {
  permissions?: {
    has: (permission: bigint) => boolean;
  };
  roles: {
    add: (roleId: string) => Promise<unknown>;
    remove: (roleId: string) => Promise<unknown>;
  };
};

export type SlashCommandGuild = {
  members: {
    fetch: (userId: string) => Promise<SlashCommandMember | undefined>;
    fetchMe: () => Promise<SlashCommandMember | undefined>;
    me?: SlashCommandMember | null;
  };
};

export type SlashCommandClient = {
  channels?: DiscordTransportClient["channels"];
  guilds?: {
    cache: {
      get: (guildId: string) => SlashCommandGuild | undefined;
    };
    fetch: (guildId: string) => Promise<SlashCommandGuild | undefined>;
  };
  on: (eventName: "interactionCreate", handler: (interaction: Interaction) => unknown) => unknown;
};

export function getDiscordLoggerClient(client: SlashCommandClient): DiscordTransportClient {
  return {
    channels: client.channels ?? {
      cache: {
        get: () => undefined,
      },
    },
  };
}
