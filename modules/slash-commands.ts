/* eslint-disable yoda */
/* eslint-disable complexity */
import {AttachmentBuilder, EmbedBuilder, PermissionFlagsBits, REST, Routes, SlashCommandBuilder} from "discord.js";
import validator from "validator";
import {getAssetByName, ImageAsset, TextAsset} from "./assets.js";
import {cryptodice} from "./crypto-dice.js";
import {google, lmgtfy} from "./lmgtfy.js";
import {getDiscordLogger, getLogger} from "./logging.js";
import {getRandomQuote} from "./random-quote.js";
import {readSecret} from "./secrets.js";
import {
  EARNINGS_BLOCKED_MESSAGE,
  EARNINGS_MAX_MESSAGE_LENGTH,
  EARNINGS_MAX_MESSAGES_SLASH,
  getEarningsResult,
  getEarningsMessages,
} from "./earnings.js";
import {
  CALENDAR_MAX_MESSAGE_LENGTH,
  CALENDAR_MAX_MESSAGES_SLASH,
  getCalendarEvents,
  getCalendarMessages,
} from "./calendar.js";
import {Ticker} from "./tickers.js";

const logger = getLogger();
const noMentions = {
  parse: [],
};
const noQuoteMessage = "Keine passenden Zitate gefunden.";
const islandboiCooldownMs = 60_000;
const islandboiCooldownByUser = new Map<string, number>();
const islandboiUnmuteTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function defineSlashCommands(assets, whatIsAssets, userAssets) {
  const token = readSecret("discord_token").trim();
  const clientId = readSecret("discord_client_ID").trim();
  const guildId = readSecret("discord_guild_ID").trim();
  const whatIsAssetsChoices = [];
  for (const asset of whatIsAssets) {
    whatIsAssetsChoices.push({name: asset.title, value: asset.name});
  }

  const userAssetsChoices = [];
  for (const asset of userAssets) {
    userAssetsChoices.push({name: asset.name, value: asset.name});
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
        .addChoices(...whatIsAssetsChoices));
  slashCommands.push(slashWhatIs.toJSON());

  const slashUserquotequote = new SlashCommandBuilder()
    .setName("quote")
    .setDescription("Quote...")
    .addStringOption(option =>
      option.setName("who")
        .setDescription("Define user")
        .setRequired(false)
        .addChoices(...userAssetsChoices));
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
    .setDescription("Earnings")
    .addStringOption(option =>
      option.setName("when")
        .setDescription("Alle, nur vor open, während der Handlszeiten oder nach close?")
        .setRequired(false)
        .addChoices(
          {name: "Alle", value: "all"},
          {name: "Vor open", value: "before_open"},
          {name: "Zu Handelszeiten", value: "during_session"},
          {name: "Nach close", value: "after_close"},
        ))
    .addStringOption(option =>
      option.setName("filter")
        .setDescription("Welche earnings?")
        .setRequired(false)
        .addChoices(
          {name: "Alle", value: "all"},
          {name: "Most anticipated", value: "5666c5fa-80dc-4e16-8bcc-12a8314d0b07"},
        ))
    .addNumberOption(option =>
      option.setName("days")
        .setDescription("Tage in der Zukunft")
        .setRequired(false))
    .addStringOption(option =>
      option.setName("date")
        .setDescription("Datum (YYYY-MM-DD)")
        .setRequired(false));
  slashCommands.push(slashCommandEarnings.toJSON());

  const slashCommandCalendar = new SlashCommandBuilder()
    .setName("calendar")
    .setDescription("Wichtige Ereignisse")
    .addStringOption(option =>
      option.setName("range")
        .setDescription("Zeitspanne in Tagen")
        .setRequired(false));
  slashCommands.push(slashCommandCalendar.toJSON());

  // Deploy slash-commands to Discord
  const rest = new REST({
    version: "10",
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

export function interactSlashCommands(client, assets, assetCommands, whatIsAssets, tickers: Ticker[]) {
  const guildId = readSecret("discord_guild_ID").trim();
  // Respond to slash-commands
  client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const commandName: string = validator.escape(interaction.commandName);
    if (assetCommands.some(v => commandName.includes(v))) {
      for (const asset of assets) {
        for (const trigger of asset.trigger) {
          if ("whatis" !== commandName && commandName === trigger.replaceAll(" ", "_")) {
            if (asset instanceof ImageAsset) {
              if (!asset?.fileContent || !asset.fileName) {
                logger.log(
                  "warn",
                  `Asset ${asset.name ?? asset.fileName ?? trigger} is temporarily unavailable.`,
                );
                await interaction.reply("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch(error => {
                  logger.log(
                    "error",
                    `Error replying to slashcommand: ${error}`,
                  );
                });
                continue;
              }

              const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
              if (asset instanceof ImageAsset && asset.hasText) {
                // For images with text description, currently not used.
                const embed = new EmbedBuilder();
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
                  `Error replying to slashcommand: ${error}`,
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
          `Error replying to cryptodice slashcommand: ${error}`,
        );
      });
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

      // This may show up as possible object insertion in Semgrep. However, it is safe since the content of `options` is predefined by the code and not supplied by a user.
      const randomElement = options[Math.floor(Math.random() * options.length)];
      const embed = new EmbedBuilder();
      embed.addFields(
        {name: interaction.options.getString("frage", true), value: randomElement},
      );
      await interaction.reply({embeds: [embed]}).catch(error => {
        logger.log(
          "error",
          `Error replying to 8ball slashcommand: ${error}`,
        );
      });
    }

    if (commandName.startsWith("lmgtfy")) {
      const search = validator.escape(interaction.options.getString("search", true));
      await interaction.reply(`Let me google that for you... ${lmgtfy(search)}.`).catch(error => {
        logger.log(
          "error",
          `Error replying to lmgtfy slashcommand: ${error}`,
        );
      });
    }

    if (commandName.startsWith("google")) {
      const search = validator.escape(interaction.options.getString("search", true));
      await interaction.reply(`Here you go: ${google(search)}.`).catch(error => {
        logger.log(
          "error",
          `Error replying to google slashcommand: ${error}`,
        );
      });
    }

    if ("whatis" === commandName) {
      const search = validator.escape(interaction.options.getString("search", true));

      for (const asset of whatIsAssets) {
        if (asset.name === search) {
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
              await interaction.reply("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch(error => {
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
    }

    if ("quote" === commandName) {
      let who: string;

      const quoteUser = interaction.options.getString("who");
      if (null !== quoteUser) {
        who = validator.escape(quoteUser);
      } else {
        who = "any";
      }

      const randomQuote = getRandomQuote(who, assets);
      if (!randomQuote) {
        await interaction.reply(noQuoteMessage).catch(error => {
          logger.log(
            "error",
            `Error replying to quote slashcommand: ${error}`,
          );
        });
        return;
      }

      if (!randomQuote.fileContent || !randomQuote.fileName) {
        logger.log(
          "warn",
          `Quote asset for ${who} is temporarily unavailable.`,
        );
        await interaction.reply("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch(error => {
          logger.log(
            "error",
            `Error replying to quote slashcommand: ${error}`,
          );
        });
        return;
      }

      const file = new AttachmentBuilder(Buffer.from(randomQuote.fileContent), {name: randomQuote.fileName});
      await interaction.reply({files: [file]});
    }

    if ("islandboi" === commandName) {
      const now = Date.now();
      const currentCooldownUntil = islandboiCooldownByUser.get(interaction.user.id) ?? 0;
      if (currentCooldownUntil > now) {
        const remainingSeconds = Math.ceil((currentCooldownUntil - now) / 1000);
        await interaction.reply({
          content: `Please wait ${remainingSeconds} more seconds.`,
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const mutedRole = readSecret("hblwrk_role_muted_ID").trim();
      if ("" === mutedRole) {
        await interaction.reply({
          content: "Muted role is not configured.",
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(error => {
        logger.log(
          "error",
          `Error fetching guild for islandboi slashcommand: ${error}`,
        );
      });
      if (!guild) {
        await interaction.reply({
          content: "Guild is currently unavailable.",
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const botMember = guild.members.me ?? await guild.members.fetchMe().catch(error => {
        logger.log(
          "error",
          `Error fetching bot member for islandboi slashcommand: ${error}`,
        );
      });
      if (!botMember || false === botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.reply({
          content: "No permissions to manage roles.",
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const guildUser = await guild.members.fetch(interaction.user.id).catch(error => {
        logger.log(
          "error",
          `Error fetching user for islandboi slashcommand: ${error}`,
        );
      });
      if (!guildUser) {
        await interaction.reply({
          content: "Konnte Benutzer nicht laden.",
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const addRoleSuccess = await guildUser.roles.add(mutedRole).then(() => true).catch(error => {
        logger.log(
          "error",
          `Error muting user for islandboi slashcommand: ${error}`,
        );
        return false;
      });
      if (false === addRoleSuccess) {
        await interaction.reply({
          content: "Unable to assign muted role.",
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const cooldownUntil = now + islandboiCooldownMs;
      islandboiCooldownByUser.set(interaction.user.id, cooldownUntil);
      const existingTimer = islandboiUnmuteTimers.get(interaction.user.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      await interaction.reply({
        content: "You are now muted for 60 seconds.",
        ephemeral: true,
      }).catch(error => {
        logger.log(
          "error",
          `Error replying to islandboi slashcommand: ${error}`,
        );
      });

      logger.log(
        "info",
        `Muted ${interaction.user.username} for 60 seconds.`,
      );

      const timer = setTimeout(() => {
        guildUser.roles.remove(mutedRole).catch(error => {
          logger.log(
            "error",
            `Error unmuting user for islandboi slashcommand: ${error}`,
          );
        }).finally(() => {
          islandboiUnmuteTimers.delete(interaction.user.id);
          islandboiCooldownByUser.delete(interaction.user.id);
        });
        logger.log(
          "info",
          `Unmuted ${interaction.user.username} after 60 seconds.`,
        );
      }, islandboiCooldownMs);
      (timer as any).unref?.();
      islandboiUnmuteTimers.set(interaction.user.id, timer);
    }

    if ("earnings" === commandName) {
      const discordLogger = getDiscordLogger(client);

      discordLogger.log(
        "info",
        {
          username: `${interaction.user.username}`,
          message: "Using earnings slashcommand",
          channel: `${interaction.channel}`,
        },
      );

      let filter = "all";
      let earningsEvents = [];
      let earningsStatus: "ok" | "blocked" | "error" = "ok";
      let watchlistFilterDropped = false;
      let when: string;
      let date: string;
      let days: number;

      const daysOption = interaction.options.getNumber("days");
      if (null !== daysOption) {
        days = daysOption;
      } else {
        days = 0;
      }

      const dateOption = interaction.options.getString("date");
      if (null !== dateOption) {
        date = validator.escape(dateOption);
      } else {
        date = "today";
      }

      const whenOption = interaction.options.getString("when");
      if (null !== whenOption) {
        when = validator.escape(whenOption);
      } else {
        when = "all";
      }

      const filterOption = interaction.options.getString("filter");
      if (null !== filterOption) {
        filter = validator.escape(filterOption);
      }

      const earningsResult = await getEarningsResult(days, date, filter);
      earningsEvents = earningsResult.events;
      earningsStatus = earningsResult.status;
      watchlistFilterDropped = earningsResult.watchlistFilterDropped;

      const earningsBatch = getEarningsMessages(earningsEvents, when, tickers, {
        maxMessageLength: EARNINGS_MAX_MESSAGE_LENGTH,
        maxMessages: EARNINGS_MAX_MESSAGES_SLASH,
      });
      logger.log(
        "info",
        {
          source: "slash-earnings",
          chunkCount: earningsBatch.messages.length,
          truncated: earningsBatch.truncated,
          includedEvents: earningsBatch.includedEvents,
          totalEvents: earningsBatch.totalEvents,
          status: earningsStatus,
          watchlistFilterDropped,
        },
      );
      if (true === earningsBatch.truncated) {
        logger.log(
          "warn",
          {
            source: "slash-earnings",
            chunkCount: earningsBatch.messages.length,
            includedEvents: earningsBatch.includedEvents,
            totalEvents: earningsBatch.totalEvents,
            message: "Earnings output truncated because message limits were reached.",
          },
        );
      }

      if (0 === earningsBatch.messages.length) {
        if ("blocked" === earningsStatus) {
          await interaction.reply({
            content: `${EARNINGS_BLOCKED_MESSAGE}\nBitte in ein paar Minuten erneut versuchen.`,
            allowedMentions: noMentions,
          }).catch(error => {
            logger.log(
              "error",
              `Error replying to earnings slashcommand: ${error}`,
            );
          });
          return;
        }

        if ("error" === earningsStatus) {
          await interaction.reply({
            content: "Earnings konnten gerade nicht geladen werden. Bitte später erneut versuchen.",
            allowedMentions: noMentions,
          }).catch(error => {
            logger.log(
              "error",
              `Error replying to earnings slashcommand: ${error}`,
            );
          });
          return;
        }

        await interaction.reply({
          content: "Es stehen keine relevanten Quartalszahlen an.",
          allowedMentions: noMentions,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to earnings slashcommand: ${error}`,
          );
        });
        return;
      }

      await interaction.reply({
        content: earningsBatch.messages[0],
        allowedMentions: noMentions,
      }).catch(error => {
        logger.log(
          "error",
          `Error replying to earnings slashcommand: ${error}`,
        );
      });

      if (true === watchlistFilterDropped) {
        await interaction.followUp({
          content: "Hinweis: Der Stocktwits-Watchlist-Filter wurde blockiert, daher werden ungefilterte Earnings angezeigt.",
          allowedMentions: noMentions,
        }).catch(error => {
          logger.log(
            "error",
            `Error following up earnings slashcommand: ${error}`,
          );
        });
      }

      for (let chunkIndex = 1; chunkIndex < earningsBatch.messages.length; chunkIndex++) {
        await interaction.followUp({
          content: earningsBatch.messages[chunkIndex],
          allowedMentions: noMentions,
        }).catch(error => {
          logger.log(
            "error",
            `Error following up earnings slashcommand: ${error}`,
          );
        });
      }
    }

    if ("calendar" === commandName) {
      const discordLogger = getDiscordLogger(client);

      discordLogger.log(
        "info",
        {
          "username": `${interaction.user.username}`,
          "message": "Using calendar slashcommand",
          "channel": `${interaction.channel}`
        },
      );

      let calendarEvents = [];

      const rangeOption = interaction.options.getString("range");
      if (null !== rangeOption) {
        let range: number = Number.parseInt(validator.escape(rangeOption), 10);
        if (Number.isNaN(range)) {
          range = 0;
        }

        if (31 < range) {
          range = 31;
        }

        calendarEvents = await getCalendarEvents("", range - 1);
      } else {
        calendarEvents = await getCalendarEvents("", 0);
      }

      const calendarBatch = getCalendarMessages(calendarEvents, {
        maxMessageLength: CALENDAR_MAX_MESSAGE_LENGTH,
        maxMessages: CALENDAR_MAX_MESSAGES_SLASH,
        keepDayTogether: true,
      });
      logger.log(
        "info",
        {
          source: "slash-calendar",
          chunkCount: calendarBatch.messages.length,
          truncated: calendarBatch.truncated,
          includedEvents: calendarBatch.includedEvents,
          totalEvents: calendarBatch.totalEvents,
        },
      );
      if (true === calendarBatch.truncated) {
        logger.log(
          "warn",
          {
            source: "slash-calendar",
            chunkCount: calendarBatch.messages.length,
            includedEvents: calendarBatch.includedEvents,
            totalEvents: calendarBatch.totalEvents,
            message: "Calendar output truncated because message limits were reached.",
          },
        );
      }

      if (0 === calendarBatch.messages.length) {
        await interaction.reply({
          content: "Heute passiert nichts wichtiges 😴.",
          allowedMentions: noMentions,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to calendar slashcommand: ${error}`,
          );
        });
        return;
      }

      await interaction.reply({
        content: calendarBatch.messages[0],
        allowedMentions: noMentions,
      }).catch(error => {
        logger.log(
          "error",
          `Error replying to calendar slashcommand: ${error}`,
        );
      });

      for (let chunkIndex = 1; chunkIndex < calendarBatch.messages.length; chunkIndex++) {
        await interaction.followUp({
          content: calendarBatch.messages[chunkIndex],
          allowedMentions: noMentions,
        }).catch(error => {
          logger.log(
            "error",
            `Error following up calendar slashcommand: ${error}`,
          );
        });
      }
    }

    async function saraDoesNotWant() {
      await interaction.reply("Sara möchte das nicht.").catch(error => {
        logger.log(
          "error",
          `Error replying to sara slashcommand: ${error}`,
        );
      });
    }

    if ("sara" === commandName) {
      let what: string;
      const whatOption = interaction.options.getString("what");
      if (null !== whatOption) {
        what = validator.escape(whatOption);

        if ("yes" === what.toLowerCase()) {
          const asset = getAssetByName("sara-yes", assets);
          if (!asset?.fileContent || !asset.fileName) {
            await saraDoesNotWant();
            return;
          }

          const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
          await interaction.reply({files: [file]});
        } else if ("shrug" === what.toLowerCase()) {
          const asset = getAssetByName("sara-shrug", assets);
          if (!asset?.fileContent || !asset.fileName) {
            await saraDoesNotWant();
            return;
          }

          const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
          await interaction.reply({files: [file]});
        } else {
          await saraDoesNotWant();
        }
      } else {
        await saraDoesNotWant();
      }
    }
  });
}
