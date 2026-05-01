import {AttachmentBuilder, type ChatInputCommandInteraction, EmbedBuilder, type Interaction, PermissionFlagsBits} from "discord.js";
import validator from "validator";
import {type GenericAsset, getAssetByName, ImageAsset, type PaywallAsset, TextAsset} from "./assets.ts";
import {type DiscordTransportClient} from "./discord-logger.ts";
import {CALENDAR_MAX_MESSAGE_LENGTH, CALENDAR_MAX_MESSAGES_SLASH, getCalendarEvents, getCalendarMessages} from "./calendar.ts";
import {cryptodice} from "./crypto-dice.ts";
import {EARNINGS_MAX_MESSAGE_LENGTH, EARNINGS_MAX_MESSAGES_SLASH, getEarningsMessages, getEarningsResult} from "./earnings.ts";
import {google, lmgtfy} from "./lmgtfy.ts";
import {getDiscordLogger, getLogger} from "./logging.ts";
import {
  getPaywallLinks,
  PaywallLookupCapacityError,
  paywallLookupBusyMessage,
  type PaywallResult,
} from "./paywall.ts";
import {getRandomAsset} from "./random-asset.ts";
import {getRandomQuote} from "./random-quote.ts";
import {assertSafeRequestUrl, UnsafeUrlError} from "./safe-http.ts";
import {readSecret} from "./secrets.ts";
import {
  getGroupedAssetCommands,
  replyWithSlashAsset,
  toSlashCommandName,
} from "./slash-commands-assets.ts";
import {fixedSlashCommandNames} from "./slash-commands-payload.ts";
import {type Ticker} from "./tickers.ts";

const logger = getLogger();
const noMentions = {
  parse: [],
};
const noQuoteMessage = "Keine passenden Zitate gefunden.";
const islandboiCooldownMs = 60_000;
const islandboiCooldownByUser = new Map<string, number>();
const islandboiUnmuteTimers = new Map<string, ReturnType<typeof setTimeout>>();

type SlashCommandMember = {
  permissions?: {
    has: (permission: bigint) => boolean;
  };
  roles: {
    add: (roleId: string) => Promise<unknown>;
    remove: (roleId: string) => Promise<unknown>;
  };
};

type SlashCommandGuild = {
  members: {
    fetch: (userId: string) => Promise<SlashCommandMember | undefined>;
    fetchMe: () => Promise<SlashCommandMember | undefined>;
    me?: SlashCommandMember | null;
  };
};

type SlashCommandClient = {
  channels?: DiscordTransportClient["channels"];
  guilds?: {
    cache: {
      get: (guildId: string) => SlashCommandGuild | undefined;
    };
    fetch: (guildId: string) => Promise<SlashCommandGuild | undefined>;
  };
  on: (eventName: "interactionCreate", handler: (interaction: Interaction) => unknown) => unknown;
};

function getDiscordLoggerClient(client: SlashCommandClient): DiscordTransportClient {
  return {
    channels: client.channels ?? {
      cache: {
        get: () => undefined,
      },
    },
  };
}

export function interactSlashCommands(
  client: SlashCommandClient,
  assets: GenericAsset[],
  _assetCommands: string[],
  whatIsAssets: ImageAsset[],
  tickers: Ticker[],
  paywallAssets?: PaywallAsset[],
) {
  const guildId = readSecret("discord_guild_ID").trim();
  // Respond to slash-commands
  client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const chatInputInteraction: ChatInputCommandInteraction = interaction;
    const commandName: string = validator.escape(chatInputInteraction.commandName);
    for (const asset of assets) {
      if (!(asset instanceof ImageAsset) && !(asset instanceof TextAsset)) {
        continue;
      }

      if (false === Array.isArray(asset.trigger)) {
        continue;
      }

      for (const trigger of asset.trigger) {
        if ("whatis" !== commandName && commandName === toSlashCommandName(trigger)) {
          if (true === await replyWithSlashAsset(chatInputInteraction, asset, trigger)) {
            return;
          }
        }
      }
    }

    const groupedAssetCommand = getGroupedAssetCommands(assets, fixedSlashCommandNames)
      .find(candidate => candidate.commandName === commandName);
    if (groupedAssetCommand) {
      const requestedVariant = chatInputInteraction.options.getInteger?.("variant") ?? null;
      const selectedVariant = null !== requestedVariant
        ? groupedAssetCommand.variants.find(groupedAssetVariant => groupedAssetVariant.variant === requestedVariant)
        : getRandomAsset(groupedAssetCommand.variants);
      if (!selectedVariant) {
        await chatInputInteraction.reply("Keine passende Variante gefunden.").catch((error: unknown) => {
          logger.log(
            "error",
            `Error replying to slashcommand: ${error}`,
          );
        });
        return;
      }

      if (true === await replyWithSlashAsset(chatInputInteraction, selectedVariant.asset, groupedAssetCommand.baseTrigger)) {
        return;
      }
    }

    if ("cryptodice" === commandName) {
      await interaction.reply(`Rolling the crypto dice... ${cryptodice()}.`).catch((error: unknown) => {
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
        {name: interaction.options.getString("frage", true), value: randomElement ?? "Antwort unklar."},
      );
      await interaction.reply({embeds: [embed]}).catch((error: unknown) => {
        logger.log(
          "error",
          `Error replying to 8ball slashcommand: ${error}`,
        );
      });
    }

    if (commandName.startsWith("lmgtfy")) {
      const search = validator.escape(interaction.options.getString("search", true));
      await interaction.reply(`Let me google that for you... ${lmgtfy(search)}.`).catch((error: unknown) => {
        logger.log(
          "error",
          `Error replying to lmgtfy slashcommand: ${error}`,
        );
      });
    }

    if (commandName.startsWith("google")) {
      const search = validator.escape(interaction.options.getString("search", true));
      await interaction.reply(`Here you go: ${google(search)}.`).catch((error: unknown) => {
        logger.log(
          "error",
          `Error replying to google slashcommand: ${error}`,
        );
      });
    }

    if ("paywall" === commandName) {
      const rawUrl = interaction.options.getString("url", true).trim();

      if (false === validator.isURL(rawUrl)) {
        await interaction.reply({
          content: "Ungültige URL. Bitte eine vollständige URL angeben (z.B. https://www.example.com/article).",
          ephemeral: true,
        }).catch((error: unknown) => {
          logger.log(
            "error",
            `Error replying to paywall slashcommand (invalid URL): ${error}`,
          );
        });
        return;
      }

      const candidateUrl = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
      let url: string;
      try {
        url = assertSafeRequestUrl(candidateUrl).toString();
      } catch (error: unknown) {
        if (error instanceof UnsafeUrlError) {
          await interaction.reply({
            content: "Ungültige URL. Bitte eine öffentliche http(s)-URL angeben.",
            ephemeral: true,
          }).catch((replyError: unknown) => {
            logger.log(
              "error",
              `Error replying to paywall slashcommand (unsafe URL): ${replyError}`,
            );
          });
          return;
        }

        throw error;
      }

      const deferred = await interaction.deferReply().then(() => true).catch((error: unknown) => {
        logger.log(
          "error",
          `Error deferring paywall slashcommand reply: ${error}`,
        );
        return false;
      });
      if (false === deferred) {
        return;
      }

      await interaction.editReply({
        content: `Suche nach Paywall-Bypass für <${url}>... Das kann bis zu 60 Sekunden dauern.`,
      }).catch((error: unknown) => {
        logger.log(
          "error",
          `Error sending paywall working message: ${error}`,
        );
      });

      try {
        const result: PaywallResult = await getPaywallLinks(url, paywallAssets ?? [], {
          requesterId: interaction.user.id,
        });
        const embed = new EmbedBuilder();

        if (true === result.nofix) {
          embed.setTitle("Paywall Bypass");
          embed.setDescription(
            `Für diese Seite ist leider kein Paywall-Bypass bekannt.`,
          );
          embed.addFields({name: "URL", value: `<${url}>`});
        } else {
          const title = true === result.isDefault
            ? "Paywall Bypass (unbekannte Seite)"
            : "Paywall Bypass";
          embed.setTitle(title);

          if (true === result.isDefault) {
            embed.setDescription("Unbekannte Seite — versuche allgemeine Services:");
          }

          const lines: string[] = [];
          for (const service of result.services) {
            if (true === service.available) {
              lines.push(`✅ **${service.name}**: <${service.url}>`);
            } else {
              lines.push(`❓ **${service.name}**: <${service.url}>`);
            }
          }

          embed.addFields(
            {name: "Original", value: `<${url}>`},
            {name: "Ergebnisse", value: lines.join("\n")},
          );
        }

        await interaction.editReply({content: "", embeds: [embed]}).catch((error: unknown) => {
          logger.log(
            "error",
            `Error replying to paywall slashcommand: ${error}`,
          );
        });
      } catch (error: unknown) {
        if (error instanceof PaywallLookupCapacityError) {
          await interaction.editReply({
            content: paywallLookupBusyMessage,
          }).catch((editError: unknown) => {
            logger.log(
              "error",
              `Error sending paywall busy message: ${editError}`,
            );
          });
          return;
        }

        logger.log(
          "error",
          `Error processing paywall slashcommand: ${error}`,
        );
        await interaction.editReply({
          content: "Fehler beim Verarbeiten der Anfrage. Bitte später erneut versuchen.",
        }).catch((editError: unknown) => {
          logger.log(
            "error",
            `Error sending paywall error message: ${editError}`,
          );
        });
      }
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
        await interaction.reply(noQuoteMessage).catch((error: unknown) => {
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
        await interaction.reply("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch((error: unknown) => {
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
        }).catch((error: unknown) => {
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
        }).catch((error: unknown) => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const guild = client.guilds?.cache.get(guildId) ?? await client.guilds?.fetch(guildId).catch((error: unknown) => {
        logger.log(
          "error",
          `Error fetching guild for islandboi slashcommand: ${error}`,
        );
      });
      if (!guild) {
        await interaction.reply({
          content: "Guild is currently unavailable.",
          ephemeral: true,
        }).catch((error: unknown) => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const botMember = guild.members.me ?? await guild.members.fetchMe().catch((error: unknown) => {
        logger.log(
          "error",
          `Error fetching bot member for islandboi slashcommand: ${error}`,
        );
      });
      if (!botMember || true !== botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.reply({
          content: "No permissions to manage roles.",
          ephemeral: true,
        }).catch((error: unknown) => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const guildUser = await guild.members.fetch(interaction.user.id).catch((error: unknown) => {
        logger.log(
          "error",
          `Error fetching user for islandboi slashcommand: ${error}`,
        );
      });
      if (!guildUser) {
        await interaction.reply({
          content: "Konnte Benutzer nicht laden.",
          ephemeral: true,
        }).catch((error: unknown) => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const addRoleSuccess = await guildUser.roles.add(mutedRole).then(() => true).catch((error: unknown) => {
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
        }).catch((error: unknown) => {
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
      }).catch((error: unknown) => {
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
        guildUser.roles.remove(mutedRole).catch((error: unknown) => {
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
      timer.unref();
      islandboiUnmuteTimers.set(interaction.user.id, timer);
    }

    if ("earnings" === commandName) {
      const discordLogger = getDiscordLogger(getDiscordLoggerClient(client));

      discordLogger.log(
        "info",
        {
          username: `${interaction.user.username}`,
          message: "Using earnings slashcommand",
          channel: `${interaction.channel}`,
        },
      );

      let when: string;
      let filter: string;
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
      } else {
        filter = "bluechips";
      }

      const deferred = await interaction.deferReply().then(() => true).catch((error: unknown) => {
        logger.log(
          "error",
          `Error deferring earnings slashcommand: ${error}`,
        );
        return false;
      });
      if (false === deferred) {
        return;
      }

      const earningsResult = await getEarningsResult(days, date);
      const earningsEvents = earningsResult.events;
      const earningsStatus = earningsResult.status;

      const earningsBatch = getEarningsMessages(earningsEvents, when, tickers, {
        maxMessageLength: EARNINGS_MAX_MESSAGE_LENGTH,
        maxMessages: EARNINGS_MAX_MESSAGES_SLASH,
        marketCapFilter: filter,
      });
      logger.log(
        "info",
        {
          source: "slash-earnings",
          filter,
          chunkCount: earningsBatch.messages.length,
          truncated: earningsBatch.truncated,
          includedEvents: earningsBatch.includedEvents,
          totalEvents: earningsBatch.totalEvents,
          status: earningsStatus,
        },
      );
      if (true === earningsBatch.truncated) {
        logger.log(
          "warn",
          {
            source: "slash-earnings",
            filter,
            chunkCount: earningsBatch.messages.length,
            includedEvents: earningsBatch.includedEvents,
            totalEvents: earningsBatch.totalEvents,
            message: "Earnings output truncated because message limits were reached.",
          },
        );
      }

      if (0 === earningsBatch.messages.length) {
        if ("error" === earningsStatus) {
          await interaction.editReply({
            content: "Earnings konnten gerade nicht geladen werden. Bitte später erneut versuchen.",
            allowedMentions: noMentions,
          }).catch((error: unknown) => {
            logger.log(
              "error",
              `Error replying to earnings slashcommand: ${error}`,
            );
          });
          return;
        }

        await interaction.editReply({
          content: "Es stehen keine relevanten Quartalszahlen an.",
          allowedMentions: noMentions,
        }).catch((error: unknown) => {
          logger.log(
            "error",
            `Error replying to earnings slashcommand: ${error}`,
          );
        });
        return;
      }

      const firstEarningsMessage = earningsBatch.messages[0];
      if (undefined === firstEarningsMessage) {
        return;
      }

      await interaction.editReply({
        content: firstEarningsMessage,
        allowedMentions: noMentions,
      }).catch((error: unknown) => {
        logger.log(
          "error",
          `Error replying to earnings slashcommand: ${error}`,
        );
      });

      for (let chunkIndex = 1; chunkIndex < earningsBatch.messages.length; chunkIndex++) {
        const followUpMessage = earningsBatch.messages[chunkIndex];
        if (undefined === followUpMessage) {
          continue;
        }

        await interaction.followUp({
          content: followUpMessage,
          allowedMentions: noMentions,
        }).catch((error: unknown) => {
          logger.log(
            "error",
            `Error following up earnings slashcommand: ${error}`,
          );
        });
      }
    }

    if ("calendar" === commandName) {
      const discordLogger = getDiscordLogger(getDiscordLoggerClient(client));

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
        }).catch((error: unknown) => {
          logger.log(
            "error",
            `Error replying to calendar slashcommand: ${error}`,
          );
        });
        return;
      }

      const firstCalendarMessage = calendarBatch.messages[0];
      if (undefined === firstCalendarMessage) {
        return;
      }

      await interaction.reply({
        content: firstCalendarMessage,
        allowedMentions: noMentions,
      }).catch((error: unknown) => {
        logger.log(
          "error",
          `Error replying to calendar slashcommand: ${error}`,
        );
      });

      for (let chunkIndex = 1; chunkIndex < calendarBatch.messages.length; chunkIndex++) {
        const followUpMessage = calendarBatch.messages[chunkIndex];
        if (undefined === followUpMessage) {
          continue;
        }

        await interaction.followUp({
          content: followUpMessage,
          allowedMentions: noMentions,
        }).catch((error: unknown) => {
          logger.log(
            "error",
            `Error following up calendar slashcommand: ${error}`,
          );
        });
      }
    }

    async function saraDoesNotWant() {
      await chatInputInteraction.reply("Sara möchte das nicht.").catch((error: unknown) => {
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
          if (!(asset instanceof ImageAsset) || !asset.fileContent || !asset.fileName) {
            await saraDoesNotWant();
            return;
          }

          const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
          await interaction.reply({files: [file]});
        } else if ("shrug" === what.toLowerCase()) {
          const asset = getAssetByName("sara-shrug", assets);
          if (!(asset instanceof ImageAsset) || !asset.fileContent || !asset.fileName) {
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
