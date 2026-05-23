import {type ChatInputCommandInteraction, EmbedBuilder} from "discord.js";
import validator from "validator";
import type {GenericAsset, ImageAsset, PaywallAsset} from "./assets.ts";
import {cryptodice} from "./crypto-dice.ts";
import {getRandomEightBallResponse} from "./eight-ball.ts";
import {lmgtfy} from "./lmgtfy.ts";
import {getLogger} from "./logging.ts";
import {handleCalendarSlashCommand, handleEarningsSlashCommand} from "./slash-commands-interact-events.ts";
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
      const embed = new EmbedBuilder();
      embed.addFields(
        {name: chatInputInteraction.options.getString("frage", true), value: getRandomEightBallResponse()},
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

    if (true === await handlePaywallSlashCommand(chatInputInteraction, commandName, paywallAssets)) {
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
