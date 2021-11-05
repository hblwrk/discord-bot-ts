import {Client, Intents, MessageAttachment, MessageEmbed} from "discord.js";
import {REST} from "@discordjs/rest";
import {SlashCommandBuilder, SlashCommandStringOption} from "@discordjs/builders";
import {Routes} from "discord-api-types/v9";
import {UserQuoteAsset, User, EmojiAsset, ImageAsset, TextAsset, getAllAssets, getAssets} from "./modules/assets";
import {readSecret} from "./modules/secrets";
import {getFromDracoon} from "./modules/dracoon-downloader";
import {runHealthCheck} from "./modules/healthcheck";
import {startNyseTimers, startMncTimers, startOtherTimers} from "./modules/timers";
import {cryptodice} from "./modules/cryptodice";
import {lmgtfy} from "./modules/lmgtfy";
import {getRandomQuote} from "./modules/randomquote";

const token = readSecret("discord_token");
const clientId = readSecret("discord_clientID");
const guildId = readSecret("discord_guildID");

runHealthCheck();

const assets = getAllAssets();

const assetCommands = [];
const assetCommandsWithPrefix = [];
for (const asset of assets) {
  for (const trigger of asset.getTrigger()) {
    assetCommands.push(trigger.replaceAll(" ", "_"));
    assetCommandsWithPrefix.push(`!${trigger}`);
  }
}

console.log(`Successfully loaded ${assets.length} assets.`);

// Create a new client instance
const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
  ],
});

// Some samples
// Message response to a message including with a trigger word
client.on("messageCreate", message => {
  // Triggers without prefix
  if (assetCommands.some(v => message.content.toLowerCase().includes(v))) {
    for (const asset of assets) {
      for (const trigger of asset.getTrigger()) {
        const triggerRex = new RegExp(`\\b${trigger}\\b`);
        if (triggerRex.test(message.content.toLowerCase())) {
          if (asset instanceof EmojiAsset) {
            // Emoji reaction to a message
            for (const response of asset.getResponse()) {
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
  }

  // Triggers with prefix (!command)
  if (assetCommandsWithPrefix.some(v => message.content.includes(v))) {
    for (const asset of assets) {
      for (const trigger of asset.getTrigger()) {
        if (`!${trigger}` === message.content) {
          if (asset instanceof ImageAsset || asset instanceof UserQuoteAsset) {
            // Response with an image
            getFromDracoon(readSecret("dracoon_password"), asset.getLocationId(), buffer => {
              const file = new MessageAttachment(buffer, asset.getFileName());
              if (asset instanceof ImageAsset && asset.hasText()) {
                const embed = new MessageEmbed();
                embed.setImage(`attachment://${asset.getFileName()}`);
                embed.addFields(
                  {name: asset.getTitle(), value: asset.getText()},
                );
                message.channel.send({embeds: [embed], files: [file]}).catch(console.error);
              } else {
                message.channel.send({files: [file]}).catch(console.error);
              }
            });
          } else if (asset instanceof TextAsset) {
            // Simple response to a message
            message.channel.send(asset.getResponse()).catch(console.error);
          } else if (asset instanceof User) {
            const randomQuote = getRandomQuote(asset);
            getFromDracoon(readSecret("dracoon_password"), randomQuote.getLocationId(), async buffer => {
              const file = new MessageAttachment(buffer, randomQuote.getFileName());
              message.channel.send({files: [file]});
            });
          }
        }
      }
    }
  }

  if ("!cryptodice" === message.content) {
    message.channel.send(`Rolling the crypto dice... ${cryptodice()}.`).catch(console.error);
  }

  if (message.content.startsWith("!lmgtfy")) {
    const search = message.content.split("!lmgtfy ")[1];
    message.channel.send(`Let me google that for you... ${lmgtfy(search)}.`).catch(console.error);
  }

  if (message.content.startsWith("!whatis")) {
    const search = message.content.split("!whatis ")[1];
    for (const asset of whatIsAssets) {
      if (asset.getName() === `whatis_${search}`) {
        const embed = new MessageEmbed();
        embed.addFields(
          {name: asset.getTitle(), value: asset.getText()},
        );

        if (true === asset.hasOwnProperty("fileName")) {
          getFromDracoon(readSecret("dracoon_password"), asset.getLocationId(), async buffer => {
            const file = new MessageAttachment(buffer, asset.getFileName());
            embed.setImage(`attachment://${asset.getFileName()}`);
            message.channel.send({embeds: [embed], files: [file]}).catch(console.error);
          });
        } else {
          message.channel.send({embeds: [embed]}).catch(console.error);
        }
      }
    }
  }
});

// Slash Commands
// Define slash-command
const slashCommands = [];
for (const asset of assets) {
  if (asset instanceof ImageAsset || asset instanceof TextAsset || asset instanceof User) {
    for (const trigger of asset.getTrigger()) {
      const slashCommand = new SlashCommandBuilder()
        .setName(trigger.replaceAll(" ", "_"))
        .setDescription(asset.getTitle());
      slashCommands.push(slashCommand.toJSON());
    }
  }
}

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

const whatIsAssets = getAssets("whatis");

const whatIsAssetsChoices = [];
for (const asset of whatIsAssets) {
  whatIsAssetsChoices.push([asset.getTitle(), asset.getName()]);
}

const slashWhatIs = new SlashCommandBuilder()
  .setName("whatis")
  .setDescription("What is...")
  .addStringOption(option =>
    option.setName("search")
      .setDescription("The search term")
      .setRequired(true)
      .addChoices(whatIsAssetsChoices));

slashCommands.push(slashWhatIs.toJSON());

// Deploy slash-command to server
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
  } catch (error: unknown) {
    console.error(error);
  }
})();

// Set timers, e.g. for stock exchange open/close notifications
startNyseTimers(client, readSecret("hblwrk_NYSEAnnouncement_ChannelID"));
startMncTimers(client, readSecret("hblwrk_MNCAnnouncement_ChannelID"));
startOtherTimers(client, readSecret("hblwrk_OtherAnnouncement_ChannelID"));
console.log("Successfully set timers.");

// Respond to slash-command
client.on("interactionCreate", async interaction => {
  if (!interaction.isCommand()) {
    return;
  }

  if (assetCommands.some(v => interaction.commandName.includes(v))) {
    for (const asset of assets) {
      for (const trigger of asset.getTrigger()) {
        if ("whatis" !== interaction.commandName && interaction.commandName.includes(trigger.replaceAll(" ", "_"))) {
          if (asset instanceof ImageAsset) {
            getFromDracoon(readSecret("dracoon_password"), asset.getLocationId(), async buffer => {
              const file = new MessageAttachment(buffer, asset.getFileName());
              if (asset instanceof ImageAsset && asset.hasText()) {
                const embed = new MessageEmbed();
                embed.setImage(`attachment://${asset.getFileName()}`);
                embed.addFields(
                  {name: asset.getTitle(), value: asset.getText()},
                );
                await interaction.reply({embeds: [embed], files: [file]});
              } else {
                await interaction.reply({files: [file]});
              }

              console.log(`${interaction.user.tag} in #${interaction.channel.id} triggered a slashcommand.`);
            });
          } else if (asset instanceof TextAsset) {
            interaction.reply(asset.getResponse()).catch(console.error);
            console.log(`${interaction.user.tag} in #${interaction.channel.id} triggered a slashcommand.`);
          } else if (asset instanceof User) {
            const randomQuote = getRandomQuote(asset);
            getFromDracoon(readSecret("dracoon_password"), randomQuote.getLocationId(), async buffer => {
              const file = new MessageAttachment(buffer, randomQuote.getFileName());
              await interaction.reply({files: [file]});
              console.log(`${interaction.user.tag} in #${interaction.channel.id} triggered a slashcommand.`);
            });
          }
        }
      }
    }
  }

  if ("cryptodice" === interaction.commandName) {
    interaction.reply(`Rolling the crypto dice... ${cryptodice()}.`).catch(console.error);
    console.log(`${interaction.user.tag} in #${interaction.channel.id} triggered a slashcommand.`);
  }

  if (interaction.commandName.startsWith("lmgtfy")) {
    const search = interaction.options.get("search").value.toString();
    interaction.reply(`Let me google that for you... ${lmgtfy(search)}.`).catch(console.error);
    console.log(`${interaction.user.tag} in #${interaction.channel.id} triggered a slashcommand.`);
  }

  if ("whatis" === interaction.commandName) {
    const search = interaction.options.get("search").value.toString();

    for (const asset of whatIsAssets) {
      if (asset.getName() === search) {
        const embed = new MessageEmbed();
        embed.addFields(
          {name: asset.getTitle(), value: asset.getText()},
        );

        if (true === asset.hasOwnProperty("fileName")) {
          getFromDracoon(readSecret("dracoon_password"), asset.getLocationId(), async buffer => {
            const file = new MessageAttachment(buffer, asset.getFileName());
            embed.setImage(`attachment://${asset.getFileName()}`);
            await interaction.reply({embeds: [embed], files: [file]});
          });
        } else {
          await interaction.reply({embeds: [embed]});
        }

        console.log(`${interaction.user.tag} in #${interaction.channel.id} triggered a slashcommand.`);
      }
    }
  }
});

// One-time events, e.g. log-in
const eventReady = {
  name: "ready",
  once: true,
  execute() {
    console.log("Ready and logged in.");
  },
};

client.once(eventReady.name, (...args) => {
  eventReady.execute.apply(null, ...args);
});

// Login to Discord
client.login(token).catch(console.error);
