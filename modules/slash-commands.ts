import {SlashCommandBuilder} from "@discordjs/builders";
import {REST} from "@discordjs/rest";
import {Routes} from "discord-api-types/rest/v9";
import {MessageAttachment, MessageEmbed} from "discord.js";
import validator from "validator";
import {getAssetByName, ImageAsset, TextAsset} from "./assets";
import {cryptodice} from "./crypto-dice";
import {google, lmgtfy} from "./lmgtfy";
import {getLogger} from "./logging";
import {getRandomQuote} from "./random-quote";
import {readSecret} from "./secrets";
import {getEarnings} from "./earnings";
import { getCalendar } from "./calendar";

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
    if ((asset instanceof ImageAsset || asset instanceof TextAsset) && 0 <= asset.trigger.length) {
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

  const slashCommandGoogle = new SlashCommandBuilder()
    .setName("google")
    .setDescription("Search...")
    .addStringOption(option =>
      option.setName("search")
        .setDescription("The search term")
        .setRequired(true));
  slashCommands.push(slashCommandGoogle.toJSON());

  const slashCommand8ball = new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Weiser als das Interwebs...")
    .addStringOption(option =>
      option.setName("frage")
        .setDescription("Stelle die Frage, sterblicher!")
        .setRequired(true));
  slashCommands.push(slashCommand8ball.toJSON());

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

  const slashCommandIslandboi = new SlashCommandBuilder()
    .setName("islandboi")
    .setDescription("Island bwoi!");
  slashCommands.push(slashCommandIslandboi.toJSON());

  const slashSara = new SlashCommandBuilder()
    .setName("sara")
    .setDescription("Sara...")
    .addStringOption(option =>
      option.setName("what")
        .setDescription("Was soll Sara tun?")
        .setRequired(false),
    );
  slashCommands.push(slashSara.toJSON());

  const slashCommandEarnings = new SlashCommandBuilder()
    .setName("earnings")
    .setDescription("Heutige earnings")
    .addStringOption(option =>
      option.setName("when")
        .setDescription("Alle, nur vor open oder nach close?")
        .setRequired(false)
        .addChoices([["Alle", "all"], ["Vor open", "before"], ["Nach close", "after"]]));
  slashCommands.push(slashCommandEarnings.toJSON());

  const slashCommandCalendar = new SlashCommandBuilder()
  .setName("calendar")
  .setDescription("Wichtige Ereignisse")
  .addStringOption(option =>
    option.setName("range")
      .setDescription("Zeitspanne in die Zukunft in Tagen")
      .setRequired(false));
  slashCommands.push(slashCommandCalendar.toJSON());

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

    if ("8ball" === commandName) {
      let options: string[] = [
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
      const embed = new MessageEmbed();
      embed.addFields(
        {name: interaction.options.get("frage").value.toString(), value: randomElement},
      );
      await interaction.reply({embeds: [embed]}).catch(error => {
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

    if (commandName.startsWith("google")) {
      const search = validator.escape(interaction.options.get("search").value.toString());
      await interaction.reply(`Here you go: ${google(search)}.`).catch(error => {
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

    if ("islandboi" === commandName) {
      //const asset = getAssetByName("islandboi", assets);
      //const file = new MessageAttachment(Buffer.from(asset.fileContent), asset.fileName);

      const guildUser = await client.guilds.cache.get(guildId).members.fetch(interaction.user.id);
      const mutedRole = readSecret("hblwrk_role_muted_ID");
      guildUser.roles.add(mutedRole);
      logger.log(
        "info",
        `Muted ${interaction.user.username} for 60 seconds.`,
      );

      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        guildUser.roles.remove(mutedRole);
        logger.log(
          "info",
          `Unmuted ${interaction.user.username} after 60 seconds.`,
        );
      }, 300000);

      //await interaction.reply({files: [file]});
    }

    if ("earnings" === commandName) {
      const filter = "5666c5fa-80dc-4e16-8bcc-12a8314d0b07" // "anticipated" watchlist
      const date = "today";
      let earnings;
      let when: string;

      if (null !== interaction.options.get("when")) {
        when = validator.escape(interaction.options.get("when").value.toString());
        if ("before" === when.toLowerCase() || "after" === when.toLowerCase() || "all" === when.toLowerCase()) {
          earnings = getEarnings(date, when, filter);
        }
      } else {
        const when = ""
        earnings = getEarnings(date, when, filter);
      }

      let returnText: string;

      if (false === await earnings) {
        returnText = "Heute gibt es keine relevanten Quartalszahlen."
      } else if ("weekend" === await earnings) {
        returnText = "Digger es ist Wochenende, nerv mich nicht."
      } else {
        returnText = `Earnings: ${await earnings}`;
      }

      await interaction.reply(returnText).catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }

    if ("calendar" === commandName) {
      let calendarText = "";
      let calendarEvents: any;
      if (null !== interaction.options.get("range")) {
        let range = validator.escape(interaction.options.get("range").value.toString());
        if (32 < range) {
          range = 31;
        }
        calendarEvents = await getCalendar(range);       
      } else {
        calendarEvents = await getCalendar("7");
      }
      if (false !== calendarEvents) {
        calendarEvents.forEach(event => {
          calendarText += `${event[2]} ${event[0]} - ${event[1]}\n`;
        });
      }

      await interaction.reply(`Wichtige Termine:\n${calendarText}`).catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }

    async function saraDoesNotWant() {
      await interaction.reply("Sara möchte das nicht.").catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }

    if ("sara" === commandName) {
      let what: string;
      if (null !== interaction.options.get("what")) {
        what = validator.escape(interaction.options.get("what").value.toString());

        if ("yes" === what.toLowerCase()) {
          const asset = getAssetByName("sara-yes", assets);
          const file = new MessageAttachment(Buffer.from(asset.fileContent), asset.fileName);
          await interaction.reply({files: [file]});
        } else if ("shrug" === what.toLowerCase()) {
          const asset = getAssetByName("sara-shrug", assets);
          const file = new MessageAttachment(Buffer.from(asset.fileContent), asset.fileName);
          await interaction.reply({files: [file]});
        } else {
          saraDoesNotWant();
        }
      } else {
        saraDoesNotWant();
      }
    }
  });
}
function user(user: any): () => void {
  throw new Error("Function not implemented.");
}

