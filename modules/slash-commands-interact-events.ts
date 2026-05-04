import {type ChatInputCommandInteraction} from "discord.js";
import validator from "validator";
import {CALENDAR_MAX_MESSAGE_LENGTH, CALENDAR_MAX_MESSAGES_SLASH, getCalendarEvents, getCalendarMessages} from "./calendar.ts";
import {EARNINGS_MAX_MESSAGE_LENGTH, EARNINGS_MAX_MESSAGES_SLASH, getEarningsMessages, getEarningsResult} from "./earnings.ts";
import {getDiscordLogger, getLogger} from "./logging.ts";
import {getDiscordLoggerClient, noMentions, type SlashCommandClient} from "./slash-commands-interact-shared.ts";
import {type Ticker} from "./tickers.ts";

const logger = getLogger();

export async function handleEarningsSlashCommand(
  client: SlashCommandClient,
  interaction: ChatInputCommandInteraction,
  commandName: string,
  tickers: Ticker[],
): Promise<boolean> {
  if ("earnings" !== commandName) {
    return false;
  }

  const discordLogger = getDiscordLogger(getDiscordLoggerClient(client));

  discordLogger.log(
    "info",
    {
      username: `${interaction.user.username}`,
      message: "Using earnings slashcommand",
      channel: `${interaction.channel}`,
    },
  );

  const daysOption = interaction.options.getNumber("days");
  const days = null !== daysOption ? daysOption : 0;

  const dateOption = interaction.options.getString("date");
  const date = null !== dateOption ? validator.escape(dateOption) : "today";

  const whenOption = interaction.options.getString("when");
  const when = null !== whenOption ? validator.escape(whenOption) : "all";

  const filterOption = interaction.options.getString("filter");
  const filter = null !== filterOption ? validator.escape(filterOption) : "bluechips";

  const deferred = await interaction.deferReply().then(() => true).catch((error: unknown) => {
    logger.log(
      "error",
      `Error deferring earnings slashcommand: ${error}`,
    );
    return false;
  });
  if (false === deferred) {
    return true;
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
      return true;
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
    return true;
  }

  const firstEarningsMessage = earningsBatch.messages[0];
  if (undefined === firstEarningsMessage) {
    return true;
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

  return true;
}

export async function handleCalendarSlashCommand(
  client: SlashCommandClient,
  interaction: ChatInputCommandInteraction,
  commandName: string,
): Promise<boolean> {
  if ("calendar" !== commandName) {
    return false;
  }

  const discordLogger = getDiscordLogger(getDiscordLoggerClient(client));

  discordLogger.log(
    "info",
    {
      "username": `${interaction.user.username}`,
      "message": "Using calendar slashcommand",
      "channel": `${interaction.channel}`
    },
  );

  const rangeOption = interaction.options.getString("range");
  let calendarRangeDays = 0;
  if (null !== rangeOption) {
    let range: number = Number.parseInt(validator.escape(rangeOption), 10);
    if (Number.isNaN(range)) {
      range = 0;
    }

    if (31 < range) {
      range = 31;
    }

    calendarRangeDays = range - 1;
  }

  const calendarEvents = await getCalendarEvents("", calendarRangeDays);
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
    return true;
  }

  const firstCalendarMessage = calendarBatch.messages[0];
  if (undefined === firstCalendarMessage) {
    return true;
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

  return true;
}
