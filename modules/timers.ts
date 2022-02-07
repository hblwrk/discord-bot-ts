import {MessageAttachment} from "discord.js";
import moment from "moment";
import "moment-timezone";
import Schedule from "node-schedule";
import {isHoliday} from "nyse-holidays";
import {getAssetByName} from "./assets";
import {getCalendarEvents, getCalendarText} from "./calendar";
import {getEarnings, getEarningsText} from "./earnings";
import {getLogger} from "./logging";
import {getMnc} from "./mnc-downloader";

const logger = getLogger();

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

  Schedule.scheduleJob(ruleNysePremarketOpen, () => {
    if (26 === Number(moment().format("DD")) && 11 === Number(moment().format("MM"))) {
      // At the day after Thanksgiving the market closes at 13:00 local time.
      const usEasternDate = moment.tz("US/Eastern").set({
        "hour": 13,
        "minute": 0,
        "second": 0,
      });
      const deDate = usEasternDate.clone().tz("Europe/Berlin");
      client.channels.cache.get(channelID).send(`🦃🍗🎉 Guten Morgen liebe Hebelhelden! Der Pre-market hat geöffnet und heute ist der Tag nach dem Truthahn-Tag, also beeilt euch - die Börse macht schon um ${deDate.format("HH")}:${deDate.format("mm")} zu! 🎉🍗🦃`).catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    } else if (true === isHoliday(new Date())) {
      client.channels.cache.get(channelID).send("🛍️🏝️🛥️ Guten Morgen liebe Hebelhelden! Heute bleibt die Börse geschlossen. Genießt den Tag und gebt eure Gewinne für tolle Sachen aus! 🛥️🏝️🛍️").catch(error => {
        logger.log(
          "error",
          error,
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
          error,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseClose, () => {
    if (false === isHoliday(new Date()) && false === (26 === Number(moment().format("DD")) && 11 === Number(moment().format("MM")))) {
      client.channels.cache.get(channelID).send("🔔🔔🔔 Es ist wieder so weit, die Börsen sind zu! Teilt eure Ergebnisse in \"Heutige Gains&Losses\" 🔔🔔🔔").catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseCloseEarly, () => {
    if (26 === Number(moment().format("DD")) && 11 === Number(moment().format("MM"))) {
      // At the day after Thanksgiving the market closes at 13:00 local time.
      client.channels.cache.get(channelID).send("🔔🔔🔔 Es ist wieder so weit, die Börsen sind zu! Teilt eure Ergebnisse in \"Heutige Gains&Losses\" 🔔🔔🔔").catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseAftermarketClose, () => {
    if (false === isHoliday(new Date()) && false === (26 === Number(moment().format("DD")) && 11 === Number(moment().format("MM")))) {
      client.channels.cache.get(channelID).send("🛏️🔔🔔 Und jetzt ist auch der aftermarket für euch Nachteulen geschlossen, Zeit fürs Bettchen! 🔔🔔🛏️").catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseAftermarketCloseEarly, () => {
    if (26 === Number(moment().format("DD")) && 11 === Number(moment().format("MM"))) {
      // At the day after Thanksgiving the aftermarket closes at 17:00 local time.
      client.channels.cache.get(channelID).send("🍻🔔🔔 Und jetzt ist auch der aftermarket geschlossen, schönen Feierabend zusammen! 🔔🔔🍻").catch(error => {
        logger.log(
          "error",
          error,
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
      const mncFile = new MessageAttachment(await buffer, fileName);
      client.channels.cache.get(channelID).send({content: `Morning News Call (${date})`, files: [mncFile]});
    });
  });
}

export function startOtherTimers(client, channelID: string, assets: any) {
  const ruleFriday = new Schedule.RecurrenceRule();
  ruleFriday.hour = 8;
  ruleFriday.minute = 0;
  ruleFriday.dayOfWeek = [5];
  ruleFriday.tz = "Europe/Berlin";

  Schedule.scheduleJob(ruleFriday, async () => {
    const fridayAsset = getAssetByName("freitag", assets);
    const fridayFile = new MessageAttachment(Buffer.from(fridayAsset.fileContent), fridayAsset.fileName);
    client.channels.cache.get(channelID).send({files: [fridayFile]}).catch(error => {
      logger.log(
        "error",
        error,
      );
    });
  });

  const ruleEarnings = new Schedule.RecurrenceRule();
  ruleEarnings.hour = 8;
  ruleEarnings.minute = 30;
  ruleEarnings.dayOfWeek = [new Schedule.Range(1, 5)];
  ruleEarnings.tz = "Europe/Berlin";

  Schedule.scheduleJob(ruleEarnings, async () => {
    const filter :string = "all"; //"5666c5fa-80dc-4e16-8bcc-12a8314d0b07" "anticipated" watchlist
    const date :string = "today";
    let when: string = "all";
    let earningsEvents = new Array();

    earningsEvents = await getEarnings(date, filter);

    let earningsText: string = getEarningsText(earningsEvents, when);

    if ("none" !== earningsText) {
      client.channels.cache.get(channelID).send(earningsText).catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }
  });

  const ruleEvents = new Schedule.RecurrenceRule();
  ruleEvents.hour = 8;
  ruleEvents.minute = 30;
  ruleEvents.dayOfWeek = [new Schedule.Range(1, 5)];
  ruleEvents.tz = "Europe/Berlin";

  Schedule.scheduleJob(ruleEvents, async () => {
    let calendarText: string;
    let calendarEvents: any;
    calendarEvents = await getCalendarEvents("", 0);

    calendarText = getCalendarText(calendarEvents);

    if ("none" !== calendarText) {
      client.channels.cache.get(channelID).send(calendarText).catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }
  });

  const ruleEventsWeekly = new Schedule.RecurrenceRule();
  ruleEventsWeekly.hour = 0;
  ruleEventsWeekly.minute = 0;
  ruleEventsWeekly.dayOfWeek = [6];
  ruleEventsWeekly.tz = "Europe/Berlin";

  Schedule.scheduleJob(ruleEventsWeekly, async () => {
    let calendarText1: string;
    let calendarText2: string;
    let calendarEvents1: any;
    let calendarEvents2: any;

    // Splitting weekly announcement to two messages to avoid API limit
    let offsetDays :string = moment().tz("Europe/Berlin").add(5, 'days').format("YYYY-MM-DD");

    calendarEvents1 = await getCalendarEvents("", 2);
    calendarEvents2 = await getCalendarEvents(offsetDays, 1);

    calendarText1 = getCalendarText(calendarEvents1);
    calendarText2 = getCalendarText(calendarEvents2);

    if ("none" !== calendarText1) {
      client.channels.cache.get(channelID).send(calendarText1).catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }

    if ("none" !== calendarText2) {
      client.channels.cache.get(channelID).send(calendarText2).catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }
  });
}
