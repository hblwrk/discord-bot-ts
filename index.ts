// Dependencies
import {Client, Intents, MessageAttachment, MessageEmbed} from "discord.js";
import {REST} from "@discordjs/rest";
import {SlashCommandBuilder} from "@discordjs/builders";
import {Routes} from "discord-api-types/v9";
import {getAssets} from "./modules/assets";
import {readSecret} from "./modules/secrets";
import {getFromDracoon} from "./modules/dracoon-downloader";
import {runHealthCheck} from "./modules/healthcheck";
import {startTimers} from "./modules/timers";

const token = readSecret("discord_token");
const clientID = readSecret("discord_clientID");
const guildID = readSecret("discord_guildID");

runHealthCheck();
const assets = [...getAssets("image")];
const assetSlashCommands = [];
const assetCommandsWithPrefix = [];
for (const asset of assets) {
  assetSlashCommands.push(asset.getName().replaceAll(" ", "_"));
  assetCommandsWithPrefix.push(`!${asset.getName()}`);
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

startTimers(client, readSecret("hblwrk_NYSEOpenCloseAnnouncement_ChannelID"));
console.log("Successfully set timers.");

// Some samples
// Message response to a message starting with a word
client.on("messageCreate", message => {
  // Simple response to a message
  if (message.content.startsWith("ping")) {
    message.channel.send("pong!").catch(console.error);
  }

  // Image response to a !message with an asset
  if (assetCommandsWithPrefix.some(v => message.content.includes(v))) {
    for (const asset of assets) {
      if (message.content.includes(asset.getName())) {
        if ("image" !== asset.getType()) {
          return;
        }

        getFromDracoon(readSecret("dracoon_password"), asset.getLocationId(), buffer => {
          const file = new MessageAttachment(buffer, asset.getFileName());
          const embed = new MessageEmbed();
          embed.setTitle(asset.getTitle());
          embed.setAuthor(client.user.username);
          embed.setImage(`attachment://${asset.getFileName()}`);
          message.channel.send({embeds: [embed], files: [file]}).catch(console.error);
        });
      }
    }
  }

  // Reaction response
  if (message.content.includes("flash")) {
    const reactionEmoji = message.guild.emojis.cache.find(emoji => emoji.name === "flash");
    message.react(reactionEmoji).catch(console.error);
  }
});

// Slash Commands
// Define slash-command
const slashCommands = [];
for (const asset of assets) {
  const slashCommand = new SlashCommandBuilder()
    .setName(asset.getName().replaceAll(" ", "_"))
    .setDescription(asset.getTitle());
  slashCommands.push(slashCommand.toJSON());
}

// Deploy slash-command to server
const rest = new REST({
  version: "9",
}).setToken(token);

(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(clientID, guildID),
      {
        body: slashCommands,
      },
    );
    console.log("Successfully registered slash commands.");
  } catch (error: unknown) {
    console.error(error);
  }
})();

// Respond to slash-command
client.on("interactionCreate", async interaction => {
  if (!interaction.isCommand()) {
    return;
  }

  if (assetSlashCommands.some(v => interaction.commandName.includes(v))) {
    for (const asset of assets) {
      if (interaction.commandName.includes(asset.getName().replaceAll(" ", "_"))) {
        if ("image" !== asset.getType()) {
          console.log(asset.getType())
          return;
        }

        getFromDracoon(readSecret("dracoon_password"), asset.getLocationId(), async buffer => {
          const file = new MessageAttachment(buffer, asset.getFileName());
          await interaction.reply({files: [file]});
          console.log(`${interaction.user.tag} in #${interaction.channel.id} triggered a slashcommand.`);
        });
      }
    }
  }
});

// Events
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

// Login to Discord with your client's token
client.login(token).catch(console.error);
