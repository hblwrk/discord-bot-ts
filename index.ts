// Dependencies
import {Client, Intents, MessageAttachment, MessageEmbed} from "discord.js";
import {REST} from "@discordjs/rest";
import {SlashCommandBuilder} from "@discordjs/builders";
import {Routes} from "discord-api-types/v9";
import {getAssets} from "./modules/assets";
import {readSecret} from "./modules/secrets";
import {getFromDracoon} from "./modules/dracoon-downloader";
import {runHealthCheck} from "./modules/healthcheck";

const token = readSecret("discord_token");
const clientId = readSecret("discord_clientId");
const guildId = readSecret("discord_guildId");

runHealthCheck();
const assets = getAssets();
const assetNames = [];
for (const asset of assets) {
  assetNames.push(asset.getName());
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
// Messages
client.on("messageCreate", message => {
  // Simple response to a message
  if (message.content.startsWith("ping")) {
    message.channel.send("pong!").catch(console.error);
  }

  // Image response to a message
  if (assetNames.some(v => message.content.includes(v))) {
    for (const asset of assets) {
      if (message.content.includes(asset.getName())) {
        getFromDracoon(readSecret("dracoon_password"), asset.getlocationId(), buffer => {
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

  if (message.content.startsWith("!ausdemweg")) {
    getFromDracoon(readSecret("dracoon_password"), "rIZidSLQLYSCwJC7BzxOWEAQZnzNEmOx", buffer => {
      const file = new MessageAttachment(buffer, "ausdemweg.png");
      const embed = new MessageEmbed();
      embed.setTitle("Aus dem Weg, Geringverdiener!");
      embed.setAuthor(client.user.username);
      embed.setImage("attachment://ausdemweg.png");
      message.channel.send({embeds: [embed], files: [file]}).catch(console.error);
    });
  }

  // Reaction response
  if (message.content.startsWith("flash")) {
    const reactionEmoji = message.guild.emojis.cache.find(emoji => emoji.name === "flash");
    message.react(reactionEmoji).catch(console.error);
  }
});

// Slash Commands
// Define slash-command
const commands = [];
const slashCommandPing = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Replies with Pong!");

commands.push(slashCommandPing.toJSON());

// Deploy slash-command to server
const rest = new REST({
  version: "9",
}).setToken(token);

(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      {
        body: commands,
      },
    );
    console.log("Successfully registered application commands.");
  } catch (error: unknown) {
    console.error(error);
  }
})();

// Respond to slash-command
client.on("interactionCreate", async interaction => {
  if (!interaction.isCommand()) {
    return;
  }

  if (interaction.commandName === "ping") {
    await interaction.reply("Pong!");
    console.log(`${interaction.user.tag} in #${interaction.channel.id} triggered an interaction.`);
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
