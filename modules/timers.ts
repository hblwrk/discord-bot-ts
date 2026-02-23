/* eslint-disable import/extensions */
import {AttachmentBuilder} from "discord.js";
import moment from "moment-timezone";
import Schedule from "node-schedule";
import {getHolidays, isHoliday} from "nyse-holidays";
import {getAssetByName} from "./assets.js";
import {
  CALENDAR_MAX_MESSAGE_LENGTH,
  CALENDAR_MAX_MESSAGES_TIMER,
  getCalendarEvents,
  getCalendarMessages,
  type CalendarEvent,
  type CalendarMessageBatch,
} from "./calendar.js";
import {
  EARNINGS_MAX_MESSAGE_LENGTH,
  EARNINGS_MAX_MESSAGES_TIMER,
  getEarningsResult,
  getEarningsMessages,
  type EarningsMessageBatch,
} from "./earnings.js";
import {getLogger} from "./logging.js";
import {getMnc} from "./mnc-downloader.js";
import {type Ticker} from "./tickers.js";

const logger = getLogger();
const noMentions = {
  parse: [],
};
const calendarMessageDelayMs = 500;
const usEasternTimezone = "US/Eastern";
const weeklyEarningsHeadline = "📅 **Earnings der nächsten Handelswoche:**";
const weeklyCalendarHeadline = "📅 **Wichtige Termine der nächsten Handelswoche:**";
const europeBerlinTimezone = "Europe/Berlin";
const usEasternWeekdays = [new Schedule.Range(1, 5)];
const gainsAndLossesThreadName = "Heutige Gains&Losses";
type SendableChannel = {
  send: (payload: unknown) => Promise<unknown> | unknown;
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

function getSendableChannel(client, channelID: string, source: string): SendableChannel | null {
  const channel = client?.channels?.cache?.get(channelID);
  if (!channel || "function" !== typeof channel.send) {
    logger.log(
      "error",
      `Skipping ${source} announcement: channel ${channelID} not found or not send-capable.`,
    );
    return null;
  }

  return channel as SendableChannel;
}

async function sendAnnouncement(client, channelID: string, payload: unknown, source: string) {
  const channel = getSendableChannel(client, channelID, source);
  if (!channel) {
    return;
  }

  await Promise.resolve(channel.send(payload)).catch(error => {
    logger.log(
      "error",
      `Error sending ${source} announcement: ${error}`,
    );
  });
}

async function runEarningsAnnouncement(
  client,
  channelID: string,
  tickers: Ticker[],
  config: EarningsAnnouncementConfig,
) {
  const earningsResult = await getEarningsResult(config.days, config.date);
  const earningsBatch = getEarningsMessages(earningsResult.events, config.when, tickers, {
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

  const channel = getSendableChannel(client, channelID, "earnings");
  const messages = config.headline
    ? prependHeadlineToFirstMessage(earningsBatch.messages, config.headline, EARNINGS_MAX_MESSAGE_LENGTH)
    : earningsBatch.messages;
  await sendChunkedMessages(channel, messages, "earnings");
}

export function startNyseTimers(client, channelID: string, gainsLossesThreadID?: string) {
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
      void sendAnnouncement(
        client,
        channelID,
        "🔔🔔🔔 Ich bin ready. Ihr seid ready?! Na dann loooos! Huuuiiii! 🚀 Der Börsenritt beginnt, meine Freunde. Seid dabei, ihr dürft nichts verpassen! 🥳 🎠 🔔🔔🔔",
        "NYSE",
      );
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

export function startMncTimers(client, channelID: string) {
  const ruleMnc = createRecurrenceRule({
    hour: 9,
    minute: 0,
    dayOfWeek: usEasternWeekdays,
    tz: usEasternTimezone,
  });

  Schedule.scheduleJob(ruleMnc, async () => {
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

export function startOtherTimers(client, channelID: string, assets: any, tickers: Ticker[]) {
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
    });
  });

  const ruleEarningsWeekly = createRecurrenceRule({
    hour: 23,
    minute: 30,
    dayOfWeek: [5],
    tz: europeBerlinTimezone,
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
    });
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

  const firstMessageWithHeadline = `${headline}\n\n${messages[0]}`;
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
    await Promise.resolve(channel.send({
      content: messages[index],
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
  if ("test" === process.env.NODE_ENV) {
    return;
  }

  await new Promise(resolve => {
    setTimeout(resolve, calendarMessageDelayMs);
  });
}
