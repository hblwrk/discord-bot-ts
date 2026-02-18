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
  getEarnings,
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

export function startNyseTimers(client, channelID: string) {
  const ruleNysePremarketOpen = new Schedule.RecurrenceRule();
  ruleNysePremarketOpen.hour = 4;
  ruleNysePremarketOpen.minute = 0;
  ruleNysePremarketOpen.dayOfWeek = [new Schedule.Range(1, 5)];
  ruleNysePremarketOpen.tz = "US/Eastern";

  const ruleNyseOpen = new Schedule.RecurrenceRule();
  ruleNyseOpen.hour = 9;
  ruleNyseOpen.minute = 30;
  ruleNyseOpen.dayOfWeek = [new Schedule.Range(1, 5)];
  ruleNyseOpen.tz = "US/Eastern";

  const ruleNyseClose = new Schedule.RecurrenceRule();
  ruleNyseClose.hour = 16;
  ruleNyseClose.minute = 0;
  ruleNyseClose.dayOfWeek = [new Schedule.Range(1, 5)];
  ruleNyseClose.tz = "US/Eastern";

  const ruleNyseCloseEarly = new Schedule.RecurrenceRule();
  ruleNyseCloseEarly.hour = 13;
  ruleNyseCloseEarly.minute = 0;
  ruleNyseCloseEarly.dayOfWeek = [new Schedule.Range(1, 5)];
  ruleNyseCloseEarly.tz = "US/Eastern";

  const ruleNyseAftermarketClose = new Schedule.RecurrenceRule();
  ruleNyseAftermarketClose.hour = 20;
  ruleNyseAftermarketClose.minute = 0;
  ruleNyseAftermarketClose.dayOfWeek = [new Schedule.Range(1, 5)];
  ruleNyseAftermarketClose.tz = "US/Eastern";

  const ruleNyseAftermarketCloseEarly = new Schedule.RecurrenceRule();
  ruleNyseAftermarketCloseEarly.hour = 17;
  ruleNyseAftermarketCloseEarly.minute = 0;
  ruleNyseAftermarketCloseEarly.dayOfWeek = [new Schedule.Range(1, 5)];
  ruleNyseAftermarketCloseEarly.tz = "US/Eastern";

  const thanksgiving = getHolidays(moment().tz("US/Eastern").year()).find(holiday => holiday.name === "Thanksgiving Day");
  const dayAfterThanksgiving = thanksgiving ?
    moment(thanksgiving.date).tz("US/Eastern").add(1, "day").format("YYYY-MM-DD") :
    "";

  Schedule.scheduleJob(ruleNysePremarketOpen, () => {
    if (dayAfterThanksgiving === moment().tz("US/Eastern").format("YYYY-MM-DD")) {
      // At the day after Thanksgiving the market closes at 13:00 local time.
      const usEasternDate = moment.tz("US/Eastern").set({
        hour: 13,
        minute: 0,
        second: 0,
      });
      const deDate = usEasternDate.clone().tz("Europe/Berlin");
      client.channels.cache.get(channelID).send(`🦃🍗🎉 Guten Morgen liebe Hebelhelden! Der Pre-market hat geöffnet und heute ist der Tag nach dem Truthahn-Tag, also beeilt euch - die Börse macht schon um ${deDate.format("HH")}:${deDate.format("mm")} zu! 🎉🍗🦃`).catch(error => {
        logger.log(
          "error",
          `Error sending announcement: ${error}`,
        );
      });
    } else if (true === isHoliday(new Date())) {
      client.channels.cache.get(channelID).send("🛍️🏝️🛥️ Guten Morgen liebe Hebelhelden! Heute bleibt die Börse geschlossen. Genießt den Tag und gebt eure Gewinne für tolle Sachen aus! 🛥️🏝️🛍️").catch(error => {
        logger.log(
          "error",
          `Error sending announcement: ${error}`,
        );
      });
    } else {
      client.channels.cache.get(channelID).send("😴🏦💰 Guten Morgen liebe Hebelhelden! Der Pre-market hat geöffnet, das Spiel beginnt! 💰🏦😴");
    }
  });

  Schedule.scheduleJob(ruleNyseOpen, () => {
    if (false === isHoliday(new Date())) {
      client.channels.cache.get(channelID).send("🔔🔔🔔 Ich bin ready. Ihr seid ready?! Na dann loooos! Huuuiiii! 🚀 Der Börsenritt beginnt, meine Freunde. Seid dabei, ihr dürft nichts verpassen! 🥳 🎠 🔔🔔🔔").catch(error => {
        logger.log(
          "error",
          `Error sending announcement: ${error}`,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseClose, () => {
    if (false === isHoliday(new Date()) &&
        false === (dayAfterThanksgiving === moment().tz("US/Eastern").format("YYYY-MM-DD"))) {
      client.channels.cache.get(channelID).send("🔔🔔🔔 Es ist wieder so weit, die Börsen sind zu! Teilt eure Ergebnisse in \"Heutige Gains&Losses\" 🔔🔔🔔").catch(error => {
        logger.log(
          "error",
          `Error sending announcement: ${error}`,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseCloseEarly, () => {
    if (dayAfterThanksgiving === moment().tz("US/Eastern").format("YYYY-MM-DD")) {
      // At the day after Thanksgiving the market closes at 13:00 local time.
      client.channels.cache.get(channelID).send("🔔🔔🔔 Es ist wieder so weit, die Börsen sind zu! Teilt eure Ergebnisse in \"Heutige Gains&Losses\" 🔔🔔🔔").catch(error => {
        logger.log(
          "error",
          `Error sending announcement: ${error}`,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseAftermarketClose, () => {
    if (false === isHoliday(new Date()) &&
        false === (dayAfterThanksgiving === moment().tz("US/Eastern").format("YYYY-MM-DD"))) {
      client.channels.cache.get(channelID).send("🛏️🔔🔔 Und jetzt ist auch der aftermarket für euch Nachteulen geschlossen, Zeit fürs Bettchen! 🔔🔔🛏️").catch(error => {
        logger.log(
          "error",
          `Error sending announcement: ${error}`,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseAftermarketCloseEarly, () => {
    if (dayAfterThanksgiving === moment().tz("US/Eastern").format("YYYY-MM-DD")) {
      // At the day after Thanksgiving the aftermarket closes at 17:00 local time.
      client.channels.cache.get(channelID).send("🍻🔔🔔 Und jetzt ist auch der aftermarket geschlossen, schönen Feierabend zusammen! 🔔🔔🍻").catch(error => {
        logger.log(
          "error",
          `Error sending announcement: ${error}`,
        );
      });
    }
  });
}

export function startMncTimers(client, channelID: string) {
  const ruleMnc = new Schedule.RecurrenceRule();
  ruleMnc.hour = 9;
  ruleMnc.minute = 0;
  ruleMnc.dayOfWeek = [new Schedule.Range(1, 5)];
  ruleMnc.tz = "US/Eastern";

  Schedule.scheduleJob(ruleMnc, async () => {
    const buffer = getMnc();
    buffer.then(async buffer => {
      moment.locale("de");
      const date = moment().format("dddd, Do MMMM YYYY");
      const shortDate = moment().format("YYYY-MM-DD");
      const fileName = `MNC-${shortDate}.pdf`;
      const mncFile = new AttachmentBuilder(await buffer, {name: fileName});
      client.channels.cache.get(channelID).send({content: `Morning News Call (${date})`, files: [mncFile]});
    });
  });
}

export function startOtherTimers(client, channelID: string, assets: any, tickers: Ticker[]) {
  const ruleFriday = new Schedule.RecurrenceRule();
  ruleFriday.hour = 8;
  ruleFriday.minute = 0;
  ruleFriday.dayOfWeek = [5];
  ruleFriday.tz = "Europe/Berlin";

  Schedule.scheduleJob(ruleFriday, async () => {
    const fridayAsset = getAssetByName("freitag", assets);
    const fridayFile = new AttachmentBuilder(Buffer.from(fridayAsset.fileContent), {name: fridayAsset.fileName});
    client.channels.cache.get(channelID).send({files: [fridayFile]}).catch(error => {
      logger.log(
        "error",
        `Error sending friday announcement: ${error}`,
      );
    });
  });

  const ruleEarnings = new Schedule.RecurrenceRule();
  ruleEarnings.hour = 19;
  ruleEarnings.minute = 30;
  ruleEarnings.dayOfWeek = [new Schedule.Range(1, 5)];
  ruleEarnings.tz = "Europe/Berlin";

  Schedule.scheduleJob(ruleEarnings, async () => {
    const filter = "all"; // "5666c5fa-80dc-4e16-8bcc-12a8314d0b07" "anticipated" watchlist
    const days = 0;
    const date = "tomorrow";
    const when = "all";
    let earningsEvents = [];

    earningsEvents = await getEarnings(days, date, filter);

    const earningsBatch = getEarningsMessages(earningsEvents, when, tickers, {
      maxMessageLength: EARNINGS_MAX_MESSAGE_LENGTH,
      maxMessages: EARNINGS_MAX_MESSAGES_TIMER,
    });
    logEarningsBatch("timer-earnings", earningsBatch);

    if (0 < earningsBatch.messages.length) {
      const channel = client.channels.cache.get(channelID);
      await sendChunkedMessages(channel, earningsBatch.messages, "earnings");
    }
  });

  const ruleEvents = new Schedule.RecurrenceRule();
  ruleEvents.hour = 8;
  ruleEvents.minute = 30;
  ruleEvents.dayOfWeek = [new Schedule.Range(1, 5)];
  ruleEvents.tz = "Europe/Berlin";

  Schedule.scheduleJob(ruleEvents, async () => {
    const calendarEvents = await getCalendarEvents("", 0);

    const calendarBatch = getCalendarMessages(calendarEvents, {
      maxMessageLength: CALENDAR_MAX_MESSAGE_LENGTH,
      maxMessages: CALENDAR_MAX_MESSAGES_TIMER,
      keepDayTogether: true,
    });
    logCalendarBatch("timer-daily", calendarBatch);

    if (0 < calendarBatch.messages.length) {
      const channel = client.channels.cache.get(channelID);
      await sendChunkedMessages(channel, calendarBatch.messages, "calendar");
    }
  });

  const ruleEventsWeekly = new Schedule.RecurrenceRule();
  ruleEventsWeekly.hour = 0;
  ruleEventsWeekly.minute = 0;
  ruleEventsWeekly.dayOfWeek = [6];
  ruleEventsWeekly.tz = "Europe/Berlin";

  Schedule.scheduleJob(ruleEventsWeekly, async () => {
    const offsetDays: string = moment().tz("Europe/Berlin").add(5, "days").format("YYYY-MM-DD");

    const calendarEvents1: CalendarEvent[] = await getCalendarEvents("", 2);
    const calendarEvents2: CalendarEvent[] = await getCalendarEvents(offsetDays, 1);

    const calendarEvents: CalendarEvent[] = dedupeCalendarEvents([...calendarEvents1, ...calendarEvents2]);
    const calendarBatch = getCalendarMessages(calendarEvents, {
      maxMessageLength: CALENDAR_MAX_MESSAGE_LENGTH,
      maxMessages: CALENDAR_MAX_MESSAGES_TIMER,
      keepDayTogether: true,
    });
    logCalendarBatch("timer-weekly", calendarBatch);

    if (0 < calendarBatch.messages.length) {
      const channel = client.channels.cache.get(channelID);
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

async function sendChunkedMessages(channel: any, messages: string[], source: "calendar" | "earnings") {
  if (!channel) {
    logger.log(
      "error",
      `Error sending ${source} announcement: channel not found`,
    );
    return;
  }

  for (let index = 0; index < messages.length; index++) {
    await channel.send({
      content: messages[index],
      allowedMentions: noMentions,
    }).catch(error => {
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
