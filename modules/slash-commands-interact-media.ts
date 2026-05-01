import {AttachmentBuilder, type ChatInputCommandInteraction, EmbedBuilder} from "discord.js";
import validator from "validator";
import {type GenericAsset, getAssetByName, ImageAsset, TextAsset} from "./assets.ts";
import {getLogger} from "./logging.ts";
import {getRandomAsset} from "./random-asset.ts";
import {getRandomQuote} from "./random-quote.ts";
import {
  getGroupedAssetCommands,
  replyWithSlashAsset,
  toSlashCommandName,
} from "./slash-commands-assets.ts";
import {fixedSlashCommandNames} from "./slash-commands-payload.ts";

const logger = getLogger();
const noQuoteMessage = "Keine passenden Zitate gefunden.";

export async function handleMediaSlashCommand(
  interaction: ChatInputCommandInteraction,
  commandName: string,
  assets: GenericAsset[],
  whatIsAssets: ImageAsset[],
): Promise<boolean> {
  if (true === await handleExactAssetCommand(interaction, commandName, assets)) {
    return true;
  }

  if (true === await handleGroupedAssetCommand(interaction, commandName, assets)) {
    return true;
  }

  if (true === await handleWhatisCommand(interaction, commandName, whatIsAssets)) {
    return true;
  }

  if (true === await handleQuoteCommand(interaction, commandName, assets)) {
    return true;
  }

  if (true === await handleSaraCommand(interaction, commandName, assets)) {
    return true;
  }

  return false;
}

async function handleExactAssetCommand(
  interaction: ChatInputCommandInteraction,
  commandName: string,
  assets: GenericAsset[],
): Promise<boolean> {
  for (const asset of assets) {
    if (!(asset instanceof ImageAsset) && !(asset instanceof TextAsset)) {
      continue;
    }

    if (false === Array.isArray(asset.trigger)) {
      continue;
    }

    for (const trigger of asset.trigger) {
      if ("whatis" !== commandName && commandName === toSlashCommandName(trigger)) {
        if (true === await replyWithSlashAsset(interaction, asset, trigger)) {
          return true;
        }
      }
    }
  }

  return false;
}

async function handleGroupedAssetCommand(
  interaction: ChatInputCommandInteraction,
  commandName: string,
  assets: GenericAsset[],
): Promise<boolean> {
  const groupedAssetCommand = getGroupedAssetCommands(assets, fixedSlashCommandNames)
    .find(candidate => candidate.commandName === commandName);
  if (!groupedAssetCommand) {
    return false;
  }

  const requestedVariant = interaction.options.getInteger?.("variant") ?? null;
  const selectedVariant = null !== requestedVariant
    ? groupedAssetCommand.variants.find(groupedAssetVariant => groupedAssetVariant.variant === requestedVariant)
    : getRandomAsset(groupedAssetCommand.variants);
  if (!selectedVariant) {
    await interaction.reply("Keine passende Variante gefunden.").catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to slashcommand: ${error}`,
      );
    });
    return true;
  }

  if (true === await replyWithSlashAsset(interaction, selectedVariant.asset, groupedAssetCommand.baseTrigger)) {
    return true;
  }

  return true;
}

async function handleWhatisCommand(
  interaction: ChatInputCommandInteraction,
  commandName: string,
  whatIsAssets: ImageAsset[],
): Promise<boolean> {
  if ("whatis" !== commandName) {
    return false;
  }

  const search = validator.escape(interaction.options.getString("search", true));
  let handled = false;

  for (const asset of whatIsAssets) {
    if (asset.name === search) {
      handled = true;
      const embed = new EmbedBuilder();
      embed.addFields(
        {name: asset.title, value: asset.text},
      );

      if (true === Object.prototype.hasOwnProperty.call(asset, "_fileName")) {
        if (!asset?.fileContent || !asset.fileName) {
          logger.log(
            "warn",
            `Whatis asset ${asset.name} is temporarily unavailable.`,
          );
          await interaction.reply("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch((error: unknown) => {
            logger.log(
              "error",
              `Error replying to whatis slashcommand: ${error}`,
            );
          });
          continue;
        }

        const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
        embed.setImage(`attachment://${asset.fileName}`);
        await interaction.reply({embeds: [embed], files: [file]});
      } else {
        await interaction.reply({embeds: [embed]});
      }
    }
  }

  return handled;
}

async function handleQuoteCommand(
  interaction: ChatInputCommandInteraction,
  commandName: string,
  assets: GenericAsset[],
): Promise<boolean> {
  if ("quote" !== commandName) {
    return false;
  }

  const quoteUser = interaction.options.getString("who");
  const who = null !== quoteUser ? validator.escape(quoteUser) : "any";
  const randomQuote = getRandomQuote(who, assets);
  if (!randomQuote) {
    await interaction.reply(noQuoteMessage).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to quote slashcommand: ${error}`,
      );
    });
    return true;
  }

  if (!randomQuote.fileContent || !randomQuote.fileName) {
    logger.log(
      "warn",
      `Quote asset for ${who} is temporarily unavailable.`,
    );
    await interaction.reply("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to quote slashcommand: ${error}`,
      );
    });
    return true;
  }

  const file = new AttachmentBuilder(Buffer.from(randomQuote.fileContent), {name: randomQuote.fileName});
  await interaction.reply({files: [file]});
  return true;
}

async function saraDoesNotWant(interaction: ChatInputCommandInteraction) {
  await interaction.reply("Sara möchte das nicht.").catch((error: unknown) => {
    logger.log(
      "error",
      `Error replying to sara slashcommand: ${error}`,
    );
  });
}

async function handleSaraCommand(
  interaction: ChatInputCommandInteraction,
  commandName: string,
  assets: GenericAsset[],
): Promise<boolean> {
  if ("sara" !== commandName) {
    return false;
  }

  const whatOption = interaction.options.getString("what");
  if (null === whatOption) {
    await saraDoesNotWant(interaction);
    return true;
  }

  const what = validator.escape(whatOption);
  if ("yes" === what.toLowerCase()) {
    const asset = getAssetByName("sara-yes", assets);
    if (!(asset instanceof ImageAsset) || !asset.fileContent || !asset.fileName) {
      await saraDoesNotWant(interaction);
      return true;
    }

    const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
    await interaction.reply({files: [file]});
    return true;
  }

  if ("shrug" === what.toLowerCase()) {
    const asset = getAssetByName("sara-shrug", assets);
    if (!(asset instanceof ImageAsset) || !asset.fileContent || !asset.fileName) {
      await saraDoesNotWant(interaction);
      return true;
    }

    const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
    await interaction.reply({files: [file]});
    return true;
  }

  await saraDoesNotWant(interaction);
  return true;
}
