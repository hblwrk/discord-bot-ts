import {Buffer} from "node:buffer";
import {Client, Intents, MessageAttachment, MessageEmbed} from "discord.js";
import {REST} from "@discordjs/rest";
import {SlashCommandBuilder} from "@discordjs/builders";
import {Routes} from "discord-api-types/v9";
import validator from "validator";
import {UserQuoteAsset, UserAsset, EmojiAsset, ImageAsset, TextAsset, getAllAssets, getAssets} from "./modules/assets";
import {readSecret} from "./modules/secrets";
import {runHealthCheck} from "./modules/healthcheck";
import {startNyseTimers, startMncTimers, startOtherTimers} from "./modules/timers";
import {cryptodice} from "./modules/cryptodice";
import {lmgtfy} from "./modules/lmgtfy";
import {getRandomQuote} from "./modules/randomquote";
import {updateSecurityQuotes} from "./modules/securityquote";

const token = readSecret("discord_token");
const clientId = readSecret("discord_clientID");
const guildId = readSecret("discord_guildID");

// Create a new client instance
const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
  ],
});

// Updating security quotes
updateSecurityQuotes();

// Set non-asset timers, e.g. for stock exchange open/close notifications
startNyseTimers(client, readSecret("hblwrk_NYSEAnnouncement_ChannelID"));
startMncTimers(client, readSecret("hblwrk_MNCAnnouncement_ChannelID"));

console.log("Caching assets...");
const assets = getAllAssets();
assets.then(async assets => {
  console.log(`Loaded and cached ${assets.length} generic assets.`);

  // Timers related to assets
  startOtherTimers(client, readSecret("hblwrk_OtherAnnouncement_ChannelID"), assets);
  console.log("Successfully set timers.");

  const whatIsAssets = await getAssets("whatis");
  console.log(`Loaded and cached ${whatIsAssets.length} whatis assets.`);

  const whatIsAssetsChoices = [];
  for (const asset of whatIsAssets) {
    whatIsAssetsChoices.push([asset.title, asset.name]);
  }

  const userAssets = await getAssets("user");
  console.log(`Loaded and cached ${userAssets.length} user assets.`);

  const userAssetsChoices = [];
  for (const asset of userAssets) {
    userAssetsChoices.push([asset.name, asset.name]);
  }

  const assetCommands = [];
  const assetCommandsWithPrefix = [];
  for (const asset of assets) {
    for (const trigger of asset.trigger) {
      assetCommands.push(trigger.replaceAll(" ", "_"));
      assetCommandsWithPrefix.push(`!${trigger}`);
    }
  }

  // Message response to a message including with a trigger word
  client.on("messageCreate", async message => {
    const messageContent: string = validator.escape(message.content);
    // Triggers without prefix
    if (assetCommands.some(v => messageContent.toLowerCase().includes(v))) {
      for (const asset of assets) {
        for (const trigger of asset.trigger) {
          const triggerRex = new RegExp(`\\b${trigger}\\b`);
          if (asset instanceof EmojiAsset && triggerRex.test(messageContent.toLowerCase())) {
            // Emoji reaction to a message
            for (const response of asset.response) {
              if (response.startsWith("custom:")) {
                const reactionEmoji = message.guild.emojis.cache.find(emoji => emoji.name === response.replace("custom:", ""));
                message.react(reactionEmoji).catch(console.error);
              } else {
                message.react(response).catch(console.error);
              }
            }
          }
        }
      }
    }

    // Triggers with prefix (!command)
    if (assetCommandsWithPrefix.some(v => messageContent.includes(v))) {
      for (const asset of assets) {
        for (const trigger of asset.trigger) {
          if (`!${trigger}` === messageContent) {
            if (asset instanceof ImageAsset || asset instanceof UserQuoteAsset) {
              // Response with an image
              const file = new MessageAttachment(Buffer.from(asset.fileContent), asset.fileName);
              if (asset instanceof ImageAsset && asset.hasText) {
                const embed = new MessageEmbed();
                embed.setImage(`attachment://${asset.fileName}`);
                embed.addFields(
                  {name: asset.title, value: asset.text},
                );
                message.channel.send({embeds: [embed], files: [file]}).catch(console.error);
              } else {
                message.channel.send({files: [file]}).catch(console.error);
              }
            } else if (asset instanceof TextAsset) {
              // Simple response to a message
              message.channel.send(asset.response).catch(console.error);
            } else if (asset instanceof UserAsset) {
              const randomQuote = getRandomQuote(asset.name, assets);
              const file = new MessageAttachment(randomQuote.fileContent, randomQuote.fileName);
              await message.channel.send({files: [file]});
            }
          }
        }
      }
    }

    if ("!cryptodice" === messageContent) {
      message.channel.send(`Rolling the crypto dice... ${cryptodice()}.`).catch(console.error);
    }

    if (messageContent.startsWith("!lmgtfy")) {
      const search = messageContent.split("!lmgtfy ")[1];
      message.channel.send(`Let me google that for you... ${lmgtfy(search)}.`).catch(console.error);
    }

    if (messageContent.startsWith("!whatis")) {
      const search = messageContent.split("!whatis ")[1];
      for (const asset of whatIsAssets) {
        if (asset.name === `whatis_${search}`) {
          const embed = new MessageEmbed();
          embed.addFields(
            {name: asset.title, value: asset.text},
          );

          if (true === Object.prototype.hasOwnProperty.call(asset, "_fileName")) {
            const file = new MessageAttachment(Buffer.from(asset.fileContent), asset.fileName);
            embed.setImage(`attachment://${asset.fileName}`);
            message.channel.send({embeds: [embed], files: [file]}).catch(console.error);
          } else {
            message.channel.send({embeds: [embed]}).catch(console.error);
          }
        }
      }
    }
  });

  // Slash-commands
  // Define asset related slash-commands
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
      console.log(`Successfully registered ${slashCommands.length} slash commands.`);
      runHealthCheck();
      console.log("Bot ready.");
    } catch (error: unknown) {
      console.error(error);
    }
  })();

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
              await interaction.reply(asset.response).catch(console.error);
            }
          }
        }
      }
    }

    if ("cryptodice" === commandName) {
      await interaction.reply(`Rolling the crypto dice... ${cryptodice()}.`).catch(console.error);
    }

    if (commandName.startsWith("lmgtfy")) {
      const search = validator.escape(interaction.options.get("search").value.toString());
      await interaction.reply(`Let me google that for you... ${lmgtfy(search)}.`).catch(console.error);
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
}).catch((error): void => {
  console.log(`Promise error: ${error}`);
});

// Log one-time events, e.g. log-in
const eventReady = {
  name: "ready",
  once: true,
  execute() {
    console.log("Logged in.");
  },
};

client.once(eventReady.name, (...args) => {
  eventReady.execute.apply(null, ...args);
});

// Login to Discord
client.login(token).catch(console.error);
