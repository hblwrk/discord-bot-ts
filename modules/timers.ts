import {AttachmentBuilder} from "discord.js";
import moment from "moment-timezone";
import Schedule from "node-schedule";
import {getHolidays, isHoliday} from "nyse-holidays";
import {
  getAssetByName,
  type CalendarReminderAsset,
  type EarningsReminderAsset,
} from "./assets.ts";
import {
  CALENDAR_MAX_MESSAGE_LENGTH,
  CALENDAR_MAX_MESSAGES_TIMER,
  getCalendarEvents,
  getCalendarMessages,
  type CalendarEvent,
  type CalendarMessageBatch,
} from "./calendar.ts";
import {
  EARNINGS_MAX_MESSAGE_LENGTH,
  EARNINGS_MAX_MESSAGES_TIMER,
  getEarningsResult,
  getEarningsMessages,
  type EarningsMessageBatch,
} from "./earnings.ts";
import {addExpectedMovesToEarningsEvents, warmExpectedMoveCacheForEarningsEvents} from "./earnings-expected-move.ts";
import {getLogger} from "./logging.ts";
import {getMnc} from "./mnc-downloader.ts";
import {type Ticker} from "./tickers.ts";
import {
  getAllowedRoleMentions,
  getCalendarReminderMessage,
  getEarningsReminderMessage,
  getMatchedCalendarReminderEventGroups,
  getMatchedEarningsReminderEvents,
  getNormalizedRoleId,
} from "./timer-reminders.ts";

const logger = getLogger();
const noMentions = {
  parse: [],
};
type FileAnnouncementAsset = {
  fileContent?: Buffer | undefined;
  fileName?: string | undefined;
  name: string;
};
const calendarReminderAnnouncementSource = "calendar-reminder";
const earningsReminderSource = "earnings-reminder";
const calendarMessageDelayMs = 500;
const usEasternTimezone = "US/Eastern";
const weeklyEarningsHeadline = "📅 **Earnings der nächsten Handelswoche:**";
const weeklyCalendarHeadline = "📅 **Wichtige Termine der nächsten Handelswoche:**";
const europeBerlinTimezone = "Europe/Berlin";
const usEasternWeekdays = [new Schedule.Range(1, 5)];
const gainsAndLossesThreadName = "Heutige Gains&Losses";
const berlinWeekdays = [new Schedule.Range(1, 5)];
const nyseOpenAnnouncement = "🔔🔔🔔 Ich bin ready. Ihr seid ready?! Na dann loooos! Huuuiiii! 🚀 Der Börsenritt beginnt, meine Freunde. Seid dabei, ihr dürft nichts verpassen! 🥳 🎠 🔔🔔🔔";
const nyseSentimentPollQuestion = "Opening Sentiment: Wie geht ihr in den Handel?";
const nyseRegularSentimentPollFallbackHours = 5;
const nyseEarlyCloseSentimentPollFallbackHours = 2;
type SendableChannel = {
  send: (payload: unknown) => Promise<unknown> | unknown;
};
type TimerClient = {
  channels?: {
    cache?: {
      get?: (channelId: string) => unknown;
    };
    fetch?: (channelId: string) => Promise<unknown> | unknown;
  };
};
type NyseSentimentPollMessage = {
  channel?: {
    messages?: {
      endPoll?: (messageId: string) => Promise<unknown> | unknown;
    };
  };
  id?: string;
  poll?: {
    end?: () => Promise<unknown> | unknown;
  };
};
type NyseSentimentPollState = {
  ended: boolean;
  message?: NyseSentimentPollMessage | undefined;
};
type RecurrenceRuleConfig = {
  hour: number;
  minute: number;
  dayOfWeek: (number | Schedule.Range)[];
  tz: string;
};
type EarningsAnnouncementConfig = {
  date: "today" | "tomorrow" | string;
  days: number;
  errorMessage: string;
  filter: "all" | "bluechips" | string;
  headline?: string;
  source: string;
  when: "all" | "before_open" | "during_session" | "after_close" | string;
};
const nyseSentimentPollAnswers = [
  {emoji: "🟢", text: "Risk-on"},
  {emoji: "🔴", text: "Risk-off"},
  {emoji: "💵", text: "Cash"},
  {emoji: "🎢", text: "Chaos"},
];

function createRecurrenceRule(config: RecurrenceRuleConfig): Schedule.RecurrenceRule {
  const recurrenceRule = new Schedule.RecurrenceRule();
  recurrenceRule.hour = config.hour;
  recurrenceRule.minute = config.minute;
  recurrenceRule.dayOfWeek = config.dayOfWeek;
  recurrenceRule.tz = config.tz;
  return recurrenceRule;
}

function getCurrentNyseDate(): Date {
  return moment.tz(usEasternTimezone).startOf("day").toDate();
}

function getThreadMention(threadID: string | undefined): string {
  const normalizedThreadID = threadID?.trim();
  if (normalizedThreadID) {
    return `<#${normalizedThreadID}>`;
  }

  return `"${gainsAndLossesThreadName}"`;
}

function getNyseCloseAnnouncement(gainsLossesThreadID: string | undefined): string {
  const gainsAndLossesTarget = getThreadMention(gainsLossesThreadID);
  return `🔔🔔🔔 Es ist wieder so weit, die Börsen sind zu! Teilt eure Ergebnisse in ${gainsAndLossesTarget} 🔔🔔🔔`;
}

function getNextUsEasternDate(): moment.Moment {
  return moment.tz(usEasternTimezone).add(1, "day").startOf("day");
}

function isUsEasternWeekend(date: moment.Moment): boolean {
  const day = date.day();
  return 0 === day || 6 === day;
}

function isNyseTradingDay(date: moment.Moment): boolean {
  if (true === isUsEasternWeekend(date)) {
    return false;
  }

  return false === isHoliday(date.toDate());
}

function isNyseHolidayToday(): boolean {
  return isHoliday(getCurrentNyseDate());
}

function isDayAfterThanksgiving(): boolean {
  const nowUsEastern = moment.tz(usEasternTimezone);
  const thanksgiving = getHolidays(nowUsEastern.year()).find(holiday => holiday.name === "Thanksgiving Day");
  if (!thanksgiving) {
    return false;
  }

  const dayAfterThanksgiving = moment(thanksgiving.date).tz(usEasternTimezone).add(1, "day").format("YYYY-MM-DD");
  return nowUsEastern.format("YYYY-MM-DD") === dayAfterThanksgiving;
}

function getNyseSentimentPollDurationHours(): number {
  if (true === isDayAfterThanksgiving()) {
    return nyseEarlyCloseSentimentPollFallbackHours;
  }

  return nyseRegularSentimentPollFallbackHours;
}

function getNyseOpenAnnouncementPayload() {
  return {
    content: nyseOpenAnnouncement,
    poll: {
      question: {
        text: nyseSentimentPollQuestion,
      },
      answers: nyseSentimentPollAnswers,
      duration: getNyseSentimentPollDurationHours(),
      allowMultiselect: false,
    },
  };
}

async function sendNyseOpenAnnouncement(
  client: TimerClient,
  channelID: string,
  sentimentPollState: NyseSentimentPollState,
) {
  sentimentPollState.ended = false;
  sentimentPollState.message = undefined;
  const message = await sendAnnouncement(client, channelID, getNyseOpenAnnouncementPayload(), "NYSE");
  if (message && "object" === typeof message) {
    sentimentPollState.message = message;
  }
}

async function endNyseSentimentPoll(sentimentPollState: NyseSentimentPollState, source: string) {
  if (true === sentimentPollState.ended) {
    return;
  }

  const pollMessage = sentimentPollState.message;
  if (!pollMessage) {
    return;
  }

  if ("function" === typeof pollMessage.poll?.end) {
    await Promise.resolve(pollMessage.poll.end()).then(() => {
      sentimentPollState.ended = true;
    }).catch(error => {
      logger.log(
        "error",
        `Error ending ${source} poll: ${error}`,
      );
    });
    return;
  }

  if (pollMessage.id && "function" === typeof pollMessage.channel?.messages?.endPoll) {
    await Promise.resolve(pollMessage.channel.messages.endPoll(pollMessage.id)).then(() => {
      sentimentPollState.ended = true;
    }).catch(error => {
      logger.log(
        "error",
        `Error ending ${source} poll: ${error}`,
      );
    });
  }
}

function isSendableChannel(channel: unknown): channel is SendableChannel {
  return "object" === typeof channel
    && null !== channel
    && "send" in channel
    && "function" === typeof channel.send;
}

function getSendableChannel(client: TimerClient, channelID: string, source: string): SendableChannel | null {
  const channel = client.channels?.cache?.get?.(channelID);
  if (false === isSendableChannel(channel)) {
    logger.log(
      "error",
      `Skipping ${source} announcement: channel ${channelID} not found or not send-capable.`,
    );
    return null;
  }

  return channel;
}

function getOptionalChannelID(channelID: string | undefined): string | undefined {
  const normalizedChannelID = channelID?.trim();
  return normalizedChannelID ? normalizedChannelID : undefined;
}

async function fetchChannel(client: TimerClient, channelID: string, source: string): Promise<unknown> {
  const cachedChannel = client.channels?.cache?.get?.(channelID);
  if (undefined !== cachedChannel) {
    return cachedChannel;
  }

  const fetchChannelFn = client.channels?.fetch;
  if ("function" !== typeof fetchChannelFn) {
    return undefined;
  }

  return Promise.resolve(fetchChannelFn(channelID)).catch(error => {
    logger.log(
      "warn",
      `Could not fetch ${source} channel ${channelID}: ${error}`,
    );
    return undefined;
  });
}

async function getFetchableSendableChannel(client: TimerClient, channelID: string, source: string): Promise<SendableChannel | null> {
  const channel = await fetchChannel(client, channelID, source);
  if (false === isSendableChannel(channel)) {
    logger.log(
      "error",
      `Skipping ${source} announcement: channel ${channelID} not found or not send-capable.`,
    );
    return null;
  }

  return channel;
}

async function getOptionalThreadTargetChannel(
  client: TimerClient,
  channelID: string,
  threadID: string | undefined,
  source: string,
): Promise<SendableChannel | null> {
  const normalizedThreadID = getOptionalChannelID(threadID);
  if (undefined !== normalizedThreadID) {
    const thread = await getFetchableSendableChannel(client, normalizedThreadID, `${source} thread`);
    if (null !== thread) {
      return thread;
    }

    logger.log(
      "warn",
      `Configured ${source} thread ${normalizedThreadID} is unavailable; falling back to channel ${channelID}.`,
    );
  }

  return getSendableChannel(client, channelID, source);
}

async function sendAnnouncement(client: TimerClient, channelID: string, payload: unknown, source: string) {
  const channel = getSendableChannel(client, channelID, source);
  return sendToChannel(channel, payload, source);
}

async function sendToChannel(channel: SendableChannel | null, payload: unknown, source: string) {
  if (!channel) {
    return undefined;
  }

  return Promise.resolve(channel.send(payload)).catch(error => {
    logger.log(
      "error",
      `Error sending ${source} announcement: ${error}`,
    );
    return undefined;
  });
}

async function runEarningsAnnouncement(
  client: TimerClient,
  channelID: string,
  tickers: Ticker[],
  config: EarningsAnnouncementConfig,
  earningsExpectationsThreadID?: string,
) {
  const earningsResult = await getEarningsResult(config.days, config.date, {
    source: config.source,
  });
  const earningsEvents = await addExpectedMovesToEarningsEvents(earningsResult.events, {
    marketCapFilter: config.filter,
    when: config.when,
  });
  const earningsBatch = getEarningsMessages(earningsEvents, config.when, tickers, {
    maxMessageLength: EARNINGS_MAX_MESSAGE_LENGTH,
    maxMessages: EARNINGS_MAX_MESSAGES_TIMER,
    marketCapFilter: config.filter,
  });
  logEarningsBatch(config.source, earningsBatch);

  if ("error" === earningsResult.status) {
    logger.log(
      "warn",
      {
        source: config.source,
        status: earningsResult.status,
        message: config.errorMessage,
      },
    );
  }

  if (0 === earningsBatch.messages.length) {
    return;
  }

  const channel = await getOptionalThreadTargetChannel(client, channelID, earningsExpectationsThreadID, "earnings");
  const messages = config.headline
    ? prependHeadlineToFirstMessage(earningsBatch.messages, config.headline, EARNINGS_MAX_MESSAGE_LENGTH)
    : earningsBatch.messages;
  await sendChunkedMessages(channel, messages, "earnings");
}

async function warmExpectedMovesForAnnouncement(config: EarningsAnnouncementConfig) {
  const earningsResult = await getEarningsResult(config.days, config.date, {
    source: `${config.source}-expected-move-warmup`,
  });
  if ("error" === earningsResult.status) {
    logger.log(
      "warn",
      {
        source: `${config.source}-expected-move-warmup`,
        status: earningsResult.status,
        message: config.errorMessage,
      },
    );
    return;
  }

  await warmExpectedMoveCacheForEarningsEvents(earningsResult.events, {
    marketCapFilter: config.filter,
    when: config.when,
  });
}

export function startNyseTimers(client: TimerClient, channelID: string, gainsLossesThreadID?: string) {
  const sentimentPollState: NyseSentimentPollState = {
    ended: true,
  };

  const ruleNysePremarketOpen = createRecurrenceRule({
    hour: 4,
    minute: 0,
    dayOfWeek: usEasternWeekdays,
    tz: usEasternTimezone,
  });

  const ruleNyseOpen = createRecurrenceRule({
    hour: 9,
    minute: 30,
    dayOfWeek: usEasternWeekdays,
    tz: usEasternTimezone,
  });

  const ruleNyseSentimentPollClose = createRecurrenceRule({
    hour: 14,
    minute: 0,
    dayOfWeek: usEasternWeekdays,
    tz: usEasternTimezone,
  });

  const ruleNyseSentimentPollCloseEarly = createRecurrenceRule({
    hour: 11,
    minute: 0,
    dayOfWeek: usEasternWeekdays,
    tz: usEasternTimezone,
  });

  const ruleNyseClose = createRecurrenceRule({
    hour: 16,
    minute: 0,
    dayOfWeek: usEasternWeekdays,
    tz: usEasternTimezone,
  });

  const ruleNyseCloseEarly = createRecurrenceRule({
    hour: 13,
    minute: 0,
    dayOfWeek: usEasternWeekdays,
    tz: usEasternTimezone,
  });

  const ruleNyseAftermarketClose = createRecurrenceRule({
    hour: 20,
    minute: 0,
    dayOfWeek: usEasternWeekdays,
    tz: usEasternTimezone,
  });

  const ruleNyseAftermarketCloseEarly = createRecurrenceRule({
    hour: 17,
    minute: 0,
    dayOfWeek: usEasternWeekdays,
    tz: usEasternTimezone,
  });

  Schedule.scheduleJob(ruleNysePremarketOpen, () => {
    const thanksgivingEarlyClose = isDayAfterThanksgiving();
    if (true === thanksgivingEarlyClose) {
      // At the day after Thanksgiving the market closes at 13:00 local time.
      const usEasternDate = moment.tz(usEasternTimezone).set({
        hour: 13,
        minute: 0,
        second: 0,
      });
      const deDate = usEasternDate.clone().tz(europeBerlinTimezone);
      void sendAnnouncement(
        client,
        channelID,
        `🦃🍗🎉 Guten Morgen liebe Hebelhelden! Der Pre-market hat geöffnet und heute ist der Tag nach dem Truthahn-Tag, also beeilt euch - die Börse macht schon um ${deDate.format("HH")}:${deDate.format("mm")} zu! 🎉🍗🦃`,
        "NYSE",
      );
    } else if (true === isNyseHolidayToday()) {
      void sendAnnouncement(
        client,
        channelID,
        "🛍️🏝️🛥️ Guten Morgen liebe Hebelhelden! Heute bleibt die Börse geschlossen. Genießt den Tag und gebt eure Gewinne für tolle Sachen aus! 🛥️🏝️🛍️",
        "NYSE",
      );
    } else {
      void sendAnnouncement(
        client,
        channelID,
        "😴🏦💰 Guten Morgen liebe Hebelhelden! Der Pre-market hat geöffnet, das Spiel beginnt! 💰🏦😴",
        "NYSE",
      );
    }
  });

  Schedule.scheduleJob(ruleNyseOpen, () => {
    if (false === isNyseHolidayToday()) {
      void sendNyseOpenAnnouncement(
        client,
        channelID,
        sentimentPollState,
      );
    }
  });

  Schedule.scheduleJob(ruleNyseSentimentPollClose, () => {
    const thanksgivingEarlyClose = isDayAfterThanksgiving();
    if (false === isNyseHolidayToday() &&
        false === thanksgivingEarlyClose) {
      void endNyseSentimentPoll(sentimentPollState, "NYSE sentiment");
    }
  });

  Schedule.scheduleJob(ruleNyseSentimentPollCloseEarly, () => {
    if (true === isDayAfterThanksgiving()) {
      void endNyseSentimentPoll(sentimentPollState, "NYSE sentiment");
    }
  });

  Schedule.scheduleJob(ruleNyseClose, () => {
    const thanksgivingEarlyClose = isDayAfterThanksgiving();
    if (false === isNyseHolidayToday() &&
        false === thanksgivingEarlyClose) {
      void sendAnnouncement(
        client,
        channelID,
        getNyseCloseAnnouncement(gainsLossesThreadID),
        "NYSE",
      );
    }
  });

  Schedule.scheduleJob(ruleNyseCloseEarly, () => {
    if (true === isDayAfterThanksgiving()) {
      // At the day after Thanksgiving the market closes at 13:00 local time.
      void sendAnnouncement(
        client,
        channelID,
        getNyseCloseAnnouncement(gainsLossesThreadID),
        "NYSE",
      );
    }
  });

  Schedule.scheduleJob(ruleNyseAftermarketClose, () => {
    const thanksgivingEarlyClose = isDayAfterThanksgiving();
    if (false === isNyseHolidayToday() &&
        false === thanksgivingEarlyClose) {
      void sendAnnouncement(
        client,
        channelID,
        "🛏️🔔🔔 Und jetzt ist auch der aftermarket für euch Nachteulen geschlossen, Zeit fürs Bettchen! 🔔🔔🛏️",
        "NYSE",
      );
    }
  });

  Schedule.scheduleJob(ruleNyseAftermarketCloseEarly, () => {
    if (true === isDayAfterThanksgiving()) {
      // At the day after Thanksgiving the aftermarket closes at 17:00 local time.
      void sendAnnouncement(
        client,
        channelID,
        "🍻🔔🔔 Und jetzt ist auch der aftermarket geschlossen, schönen Feierabend zusammen! 🔔🔔🍻",
        "NYSE",
      );
    }
  });
}

export function startMncTimers(client: TimerClient, channelID: string) {
  const ruleMnc = createRecurrenceRule({
    hour: 9,
    minute: 0,
    dayOfWeek: usEasternWeekdays,
    tz: usEasternTimezone,
  });

  Schedule.scheduleJob(ruleMnc, async () => {
    if (true === isNyseHolidayToday()) {
      logger.log(
        "info",
        "Skipping MNC announcement: market holiday.",
      );
      return;
    }

    const buffer = await getMnc();
    if (!buffer) {
      logger.log(
        "warn",
        "Skipping MNC announcement: no file downloaded.",
      );
      return;
    }

    moment.locale("de");
    const date = moment().format("dddd, Do MMMM YYYY");
    const shortDate = moment().format("YYYY-MM-DD");
    const fileName = `MNC-${shortDate}.pdf`;
    const mncFile = new AttachmentBuilder(buffer, {name: fileName});
    await sendAnnouncement(
      client,
      channelID,
      {content: `Morning News Call (${date})`, files: [mncFile]},
      "MNC",
    );
  });
}

export function startOtherTimers(
  client: TimerClient,
  channelID: string,
  assets: FileAnnouncementAsset[],
  tickers: Ticker[],
  calendarReminderAssets: CalendarReminderAsset[] = [],
  earningsReminderAssets: EarningsReminderAsset[] = [],
  earningsExpectationsThreadID?: string,
) {
  const ruleFriday = createRecurrenceRule({
    hour: 8,
    minute: 0,
    dayOfWeek: [5],
    tz: europeBerlinTimezone,
  });

  Schedule.scheduleJob(ruleFriday, async () => {
    const fridayAsset = getAssetByName("freitag", assets);
    if (!fridayAsset?.fileContent || !fridayAsset.fileName) {
      logger.log(
        "warn",
        "Skipping friday announcement: asset missing or incomplete.",
      );
      return;
    }

    const fridayFile = new AttachmentBuilder(Buffer.from(fridayAsset.fileContent), {name: fridayAsset.fileName});
    await sendAnnouncement(client, channelID, {files: [fridayFile]}, "friday");
  });

  const ruleEarnings = createRecurrenceRule({
    hour: 19,
    minute: 30,
    dayOfWeek: [new Schedule.Range(0, 6)],
    tz: europeBerlinTimezone,
  });
  const ruleEarningsExpectedMoveWarmup = createRecurrenceRule({
    hour: 19,
    minute: 28,
    dayOfWeek: [new Schedule.Range(0, 6)],
    tz: europeBerlinTimezone,
  });

  Schedule.scheduleJob(ruleEarningsExpectedMoveWarmup, async () => {
    const nextUsEasternDate = getNextUsEasternDate();
    if (false === isNyseTradingDay(nextUsEasternDate)) {
      return;
    }

    await warmExpectedMovesForAnnouncement({
      date: "tomorrow",
      days: 0,
      errorMessage: "Earnings konnten nicht geladen werden.",
      filter: "bluechips",
      source: "timer-earnings",
      when: "all",
    });
  });

  Schedule.scheduleJob(ruleEarnings, async () => {
    const nextUsEasternDate = getNextUsEasternDate();
    if (false === isNyseTradingDay(nextUsEasternDate)) {
      logger.log(
        "info",
        {
          source: "timer-earnings",
          message: `Skipping earnings timer: next US/Eastern day ${nextUsEasternDate.format("YYYY-MM-DD")} is not a trading day.`,
        },
      );
      return;
    }

    await runEarningsAnnouncement(client, channelID, tickers, {
      date: "tomorrow",
      days: 0,
      errorMessage: "Earnings konnten nicht geladen werden.",
      filter: "bluechips",
      source: "timer-earnings",
      when: "all",
    }, earningsExpectationsThreadID);
  });

  const ruleEarningsWeekly = createRecurrenceRule({
    hour: 23,
    minute: 30,
    dayOfWeek: [5],
    tz: europeBerlinTimezone,
  });
  const ruleEarningsWeeklyExpectedMoveWarmup = createRecurrenceRule({
    hour: 23,
    minute: 28,
    dayOfWeek: [5],
    tz: europeBerlinTimezone,
  });

  Schedule.scheduleJob(ruleEarningsWeeklyExpectedMoveWarmup, async () => {
    await warmExpectedMovesForAnnouncement({
      date: "tomorrow",
      days: 5,
      errorMessage: "Wöchentliche Earnings konnten nicht geladen werden.",
      filter: "bluechips",
      headline: weeklyEarningsHeadline,
      source: "timer-earnings-weekly",
      when: "all",
    });
  });

  Schedule.scheduleJob(ruleEarningsWeekly, async () => {
    await runEarningsAnnouncement(client, channelID, tickers, {
      date: "tomorrow",
      days: 5,
      errorMessage: "Wöchentliche Earnings konnten nicht geladen werden.",
      filter: "bluechips",
      headline: weeklyEarningsHeadline,
      source: "timer-earnings-weekly",
      when: "all",
    }, earningsExpectationsThreadID);
  });

  const ruleEarningsReminder = createRecurrenceRule({
    hour: 8,
    minute: 0,
    dayOfWeek: berlinWeekdays,
    tz: europeBerlinTimezone,
  });

  Schedule.scheduleJob(ruleEarningsReminder, async () => {
    if (0 === earningsReminderAssets.length) {
      return;
    }

    const earningsResult = await getEarningsResult(0, "today", {
      source: earningsReminderSource,
    });
    if ("error" === earningsResult.status) {
      logger.log(
        "warn",
        {
          source: earningsReminderSource,
          status: earningsResult.status,
          message: "Earnings-Erinnerungen konnten nicht geladen werden.",
        },
      );
      return;
    }

    for (const earningsReminderAsset of earningsReminderAssets) {
      const roleId = getNormalizedRoleId(earningsReminderAsset.roleId);
      if (!roleId) {
        continue;
      }

      const matchedEvents = getMatchedEarningsReminderEvents(earningsReminderAsset, earningsResult.events);
      if (0 === matchedEvents.length) {
        continue;
      }

      const channel = await getOptionalThreadTargetChannel(client, channelID, earningsExpectationsThreadID, earningsReminderSource);
      await sendToChannel(
        channel,
        {
          content: getEarningsReminderMessage(roleId, matchedEvents),
          allowedMentions: getAllowedRoleMentions(roleId),
        },
        earningsReminderSource,
      );
    }
  });

  const ruleEvents = createRecurrenceRule({
    hour: 8,
    minute: 30,
    dayOfWeek: [new Schedule.Range(1, 5)],
    tz: europeBerlinTimezone,
  });

  Schedule.scheduleJob(ruleEvents, async () => {
    const calendarEvents = await getCalendarEvents("", 0);

    const calendarBatch = getCalendarMessages(calendarEvents, {
      maxMessageLength: CALENDAR_MAX_MESSAGE_LENGTH,
      maxMessages: CALENDAR_MAX_MESSAGES_TIMER,
      keepDayTogether: true,
    });
    logCalendarBatch("timer-daily", calendarBatch);

    if (0 < calendarBatch.messages.length) {
      const channel = getSendableChannel(client, channelID, "calendar");
      await sendChunkedMessages(channel, calendarBatch.messages, "calendar");
    }

    const matchedReminderGroups = getMatchedCalendarReminderEventGroups(calendarReminderAssets, calendarEvents);
    for (const matchedReminderGroup of matchedReminderGroups) {
      const roleId = getNormalizedRoleId(matchedReminderGroup.asset.roleId);
      if (!roleId) {
        continue;
      }

      await sendAnnouncement(
        client,
        channelID,
        {
          content: getCalendarReminderMessage(roleId, matchedReminderGroup.events),
          allowedMentions: getAllowedRoleMentions(roleId),
        },
        calendarReminderAnnouncementSource,
      );
    }
  });

  const ruleEventsWeekly = createRecurrenceRule({
    hour: 23,
    minute: 45,
    dayOfWeek: [5],
    tz: europeBerlinTimezone,
  });

  Schedule.scheduleJob(ruleEventsWeekly, async () => {
    const nextWeekMonday = moment()
      .tz(europeBerlinTimezone)
      .startOf("isoWeek")
      .add(1, "week");
    const nextWeekThursday = nextWeekMonday.clone().add(3, "days");

    const calendarEvents1: CalendarEvent[] = await getCalendarEvents(nextWeekMonday.format("YYYY-MM-DD"), 2);
    const calendarEvents2: CalendarEvent[] = await getCalendarEvents(nextWeekThursday.format("YYYY-MM-DD"), 1);

    const calendarEvents: CalendarEvent[] = dedupeCalendarEvents([...calendarEvents1, ...calendarEvents2]);
    const calendarBatch = getCalendarMessages(calendarEvents, {
      maxMessageLength: CALENDAR_MAX_MESSAGE_LENGTH,
      maxMessages: CALENDAR_MAX_MESSAGES_TIMER,
      keepDayTogether: true,
      title: weeklyCalendarHeadline,
    });
    logCalendarBatch("timer-weekly", calendarBatch);

    if (0 < calendarBatch.messages.length) {
      const channel = getSendableChannel(client, channelID, "calendar");
      await sendChunkedMessages(channel, calendarBatch.messages, "calendar");
    }
  });
}

function dedupeCalendarEvents(calendarEvents: CalendarEvent[]): CalendarEvent[] {
  const dedupedEvents: CalendarEvent[] = [];
  const seenEventKeys = new Set<string>();

  for (const calendarEvent of calendarEvents) {
    const eventKey = `${calendarEvent.date}|${calendarEvent.time}|${calendarEvent.name}`;
    if (false === seenEventKeys.has(eventKey)) {
      dedupedEvents.push(calendarEvent);
      seenEventKeys.add(eventKey);
    }
  }

  return dedupedEvents;
}

function prependHeadlineToFirstMessage(
  messages: string[],
  headline: string,
  maxMessageLength: number,
): string[] {
  if (0 === messages.length) {
    return messages;
  }

  const firstMessage = messages[0];
  if (undefined === firstMessage) {
    return [headline];
  }

  const firstMessageWithHeadline = `${headline}\n\n${firstMessage}`;
  if (firstMessageWithHeadline.length <= maxMessageLength) {
    return [firstMessageWithHeadline, ...messages.slice(1)];
  }

  return [headline, ...messages];
}

async function sendChunkedMessages(channel: SendableChannel | null, messages: string[], source: "calendar" | "earnings") {
  if (!channel) {
    return;
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (undefined === message) {
      continue;
    }

    await Promise.resolve(channel.send({
      content: message,
      allowedMentions: noMentions,
    })).catch(error => {
      logger.log(
        "error",
        `Error sending ${source} announcement: ${error}`,
      );
    });

    if (index < messages.length - 1) {
      await waitBeforeNextChunkedMessage();
    }
  }
}

function logCalendarBatch(source: string, calendarBatch: CalendarMessageBatch) {
  logger.log(
    "info",
    {
      source,
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
        source,
        chunkCount: calendarBatch.messages.length,
        includedEvents: calendarBatch.includedEvents,
        totalEvents: calendarBatch.totalEvents,
        message: "Calendar output truncated because message limits were reached.",
      },
    );
  }
}

function logEarningsBatch(source: string, earningsBatch: EarningsMessageBatch) {
  logger.log(
    "info",
    {
      source,
      chunkCount: earningsBatch.messages.length,
      truncated: earningsBatch.truncated,
      includedEvents: earningsBatch.includedEvents,
      totalEvents: earningsBatch.totalEvents,
    },
  );

  if (true === earningsBatch.truncated) {
    logger.log(
      "warn",
      {
        source,
        chunkCount: earningsBatch.messages.length,
        includedEvents: earningsBatch.includedEvents,
        totalEvents: earningsBatch.totalEvents,
        message: "Earnings output truncated because message limits were reached.",
      },
    );
  }
}

async function waitBeforeNextChunkedMessage() {
  if ("test" === process.env["NODE_ENV"]) {
    return;
  }

  await new Promise(resolve => {
    setTimeout(resolve, calendarMessageDelayMs);
  });
}
