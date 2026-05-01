import {type ChatInputCommandInteraction, EmbedBuilder} from "discord.js";
import validator from "validator";
import type {GenericAsset, ImageAsset, PaywallAsset} from "./assets.ts";
import {cryptodice} from "./crypto-dice.ts";
import {google, lmgtfy} from "./lmgtfy.ts";
import {getLogger} from "./logging.ts";
import {readSecret} from "./secrets.ts";
import {handleCalendarSlashCommand, handleEarningsSlashCommand} from "./slash-commands-interact-events.ts";
import {handleIslandboiSlashCommand} from "./slash-commands-interact-islandboi.ts";
import {handleMediaSlashCommand} from "./slash-commands-interact-media.ts";
import {handleDeltaSlashCommand} from "./slash-commands-interact-options.ts";
import {handlePaywallSlashCommand} from "./slash-commands-interact-paywall.ts";
import {type SlashCommandClient} from "./slash-commands-interact-shared.ts";
import {type Ticker} from "./tickers.ts";

const logger = getLogger();

export function interactSlashCommands(
  client: SlashCommandClient,
  assets: GenericAsset[],
  _assetCommands: string[],
  whatIsAssets: ImageAsset[],
  tickers: Ticker[],
  paywallAssets?: PaywallAsset[],
) {
  const guildId = readSecret("discord_guild_ID").trim();

  client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const chatInputInteraction: ChatInputCommandInteraction = interaction;
    const commandName = validator.escape(chatInputInteraction.commandName);

    if (true === await handleMediaSlashCommand(chatInputInteraction, commandName, assets, whatIsAssets)) {
      return;
    }

    if ("cryptodice" === commandName) {
      await chatInputInteraction.reply(`Rolling the crypto dice... ${cryptodice()}.`).catch((error: unknown) => {
        logger.log(
          "error",
          `Error replying to cryptodice slashcommand: ${error}`,
        );
      });
      return;
    }

    if ("8ball" === commandName) {
      const options: string[] = [
        ":8ball: Ziemlich sicher.",
        ":8ball: Es ist entschieden.",
        ":8ball: Ohne Zweifel.",
        ":8ball: Ja, absolut.",
        ":8ball: Du kannst darauf zählen.",
        ":8ball: Sehr wahrscheinlich.",
        ":8ball: Sieht gut aus.",
        ":8ball: Ja.",
        ":8ball: Die Zeichen stehen auf Ja.",
        ":8ball: Antwort unklar.",
        ":8ball: Frag mich später noch mal.",
        ":8ball: Sag ich dir besser noch nicht.",
        ":8ball: Kann ich noch nicht sagen.",
        ":8ball: Konzentriere dich und frage erneut.",
        ":8ball: Zähl nicht darauf.",
        ":8ball: Meine Antwort ist nein.",
        ":8ball: Meine Quellen sagen nein.",
        ":8ball: Sieht nicht so gut aus.",
        ":8ball: Sehr unwahrscheinlich.",
      ];

      const randomElement = options[Math.floor(Math.random() * options.length)];
      const embed = new EmbedBuilder();
      embed.addFields(
        {name: chatInputInteraction.options.getString("frage", true), value: randomElement ?? "Antwort unklar."},
      );
      await chatInputInteraction.reply({embeds: [embed]}).catch((error: unknown) => {
        logger.log(
          "error",
          `Error replying to 8ball slashcommand: ${error}`,
        );
      });
      return;
    }

    if (commandName.startsWith("lmgtfy")) {
      const search = validator.escape(chatInputInteraction.options.getString("search", true));
      await chatInputInteraction.reply(`Let me google that for you... ${lmgtfy(search)}.`).catch((error: unknown) => {
        logger.log(
          "error",
          `Error replying to lmgtfy slashcommand: ${error}`,
        );
      });
      return;
    }

    if (commandName.startsWith("google")) {
      const search = validator.escape(chatInputInteraction.options.getString("search", true));
      await chatInputInteraction.reply(`Here you go: ${google(search)}.`).catch((error: unknown) => {
        logger.log(
          "error",
          `Error replying to google slashcommand: ${error}`,
        );
      });
      return;
    }

    if (true === await handlePaywallSlashCommand(chatInputInteraction, commandName, paywallAssets)) {
      return;
    }

    if (true === await handleIslandboiSlashCommand(client, chatInputInteraction, commandName, guildId)) {
      return;
    }

    if (true === await handleDeltaSlashCommand(client, chatInputInteraction, commandName)) {
      return;
    }

    if (true === await handleEarningsSlashCommand(client, chatInputInteraction, commandName, tickers)) {
      return;
    }

    await handleCalendarSlashCommand(client, chatInputInteraction, commandName);
  });
}
