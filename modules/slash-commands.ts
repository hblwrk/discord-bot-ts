import {SlashCommandBuilder} from "@discordjs/builders";
import {REST} from "@discordjs/rest";
import {Routes} from "discord-api-types/rest/v9";
import {MessageAttachment, MessageEmbed} from "discord.js";
import validator from "validator";
import {ImageAsset, TextAsset} from "./assets";
import {cryptodice} from "./crypto-dice";
import {lmgtfy} from "./lmgtfy";
import {getLogger} from "./logging";
import {getRandomQuote} from "./random-quote";
import {readSecret} from "./secrets";

const logger = getLogger();
const token = readSecret("discord_token");
const clientId = readSecret("discord_clientID");
const guildId = readSecret("discord_guildID");

export function defineSlashCommands(assets, whatIsAssets, userAssets) {
  const whatIsAssetsChoices = [];
  for (const asset of whatIsAssets) {
    whatIsAssetsChoices.push([asset.title, asset.name]);
  }

  const userAssetsChoices = [];
  for (const asset of userAssets) {
    userAssetsChoices.push([asset.name, asset.name]);
  }

  const slashCommands = [];
  for (const asset of assets) {
    if (asset instanceof ImageAsset || asset instanceof TextAsset) {
      for (const trigger of asset.trigger) {
        const slashCommand = new SlashCommandBuilder()
          .setName(trigger.replaceAll(" ", "_"))
          .setDescription(asset.title);
        slashCommands.push(slashCommand.toJSON());
      }
    }
  }

  // Define non-asset related slash-commands
  const slashCommandCryptodice = new SlashCommandBuilder()
    .setName("cryptodice")
    .setDescription("Roll the dice...");
  slashCommands.push(slashCommandCryptodice.toJSON());

  const slashCommandLmgtfy = new SlashCommandBuilder()
    .setName("lmgtfy")
    .setDescription("Let me google that for you...")
    .addStringOption(option =>
      option.setName("search")
        .setDescription("The search term")
        .setRequired(true));
  slashCommands.push(slashCommandLmgtfy.toJSON());

  const slashWhatIs = new SlashCommandBuilder()
    .setName("whatis")
    .setDescription("What is...")
    .addStringOption(option =>
      option.setName("search")
        .setDescription("The search term")
        .setRequired(true)
        .addChoices(whatIsAssetsChoices));
  slashCommands.push(slashWhatIs.toJSON());

  const slashUserquotequote = new SlashCommandBuilder()
    .setName("quote")
    .setDescription("Quote...")
    .addStringOption(option =>
      option.setName("who")
        .setDescription("Define user")
        .setRequired(false)
        .addChoices(userAssetsChoices));
  slashCommands.push(slashUserquotequote.toJSON());

  // Deploy slash-commands to Discord
  const rest = new REST({
    version: "9",
  }).setToken(token);

  (async () => {
    try {
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        {
          body: slashCommands,
        },
      );
      logger.log(
        "info",
        `Successfully registered ${slashCommands.length} slash commands.`,
      );
    } catch (error: unknown) {
      logger.log(
        "error",
        error,
      );
    }
  })();
}

export function interactSlashCommands(client, assets, assetCommands, whatIsAssets) {
  // Respond to slash-commands
  client.on("interactionCreate", async interaction => {
    if (!interaction.isCommand()) {
      return;
    }

    const commandName: string = validator.escape(interaction.commandName);
    if (assetCommands.some(v => commandName.includes(v))) {
      for (const asset of assets) {
        for (const trigger of asset.trigger) {
          if ("whatis" !== commandName && commandName === trigger.replaceAll(" ", "_")) {
            if (asset instanceof ImageAsset) {
              const file = new MessageAttachment(Buffer.from(asset.fileContent), asset.fileName);
              if (asset instanceof ImageAsset && asset.hasText) {
                // For images with text description, currently not used.
                const embed = new MessageEmbed();
                embed.setImage(`attachment://${asset.fileName}`);
                embed.addFields(
                  {name: asset.title, value: asset.text},
                );
                await interaction.reply({embeds: [embed], files: [file]});
              } else {
                await interaction.reply({files: [file]});
              }
            } else if (asset instanceof TextAsset) {
              await interaction.reply(asset.response).catch(error => {
                logger.log(
                  "error",
                  error,
                );
              });
            }
          }
        }
      }
    }

    if ("cryptodice" === commandName) {
      await interaction.reply(`Rolling the crypto dice... ${cryptodice()}.`).catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }

    if (commandName.startsWith("lmgtfy")) {
      const search = validator.escape(interaction.options.get("search").value.toString());
      await interaction.reply(`Let me google that for you... ${lmgtfy(search)}.`).catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }

    if ("whatis" === commandName) {
      const search = validator.escape(interaction.options.get("search").value.toString());

      for (const asset of whatIsAssets) {
        if (asset.name === search) {
          const embed = new MessageEmbed();
          embed.addFields(
            {name: asset.title, value: asset.text},
          );

          if (true === Object.prototype.hasOwnProperty.call(asset, "_fileName")) {
            const file = new MessageAttachment(Buffer.from(asset.fileContent), asset.fileName);
            embed.setImage(`attachment://${asset.fileName}`);
            await interaction.reply({embeds: [embed], files: [file]});
          } else {
            await interaction.reply({embeds: [embed]});
          }
        }
      }
    }

    if ("quote" === commandName) {
      let who: string;

      if (null !== interaction.options.get("who")) {
        who = validator.escape(interaction.options.get("who").value.toString());
      } else {
        who = "any";
      }

      const randomQuote = getRandomQuote(who, assets);
      const file = new MessageAttachment(Buffer.from(randomQuote.fileContent), randomQuote.fileName);
      await interaction.reply({files: [file]});
    }
  });
}
