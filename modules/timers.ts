import {MessageAttachment, MessageEmbed} from "discord.js";
import moment from "moment";
import "moment-timezone";
import Schedule from "node-schedule";
import {isHoliday} from "nyse-holidays";
import {getAssetByName} from "./assets";
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
    if (false === isHoliday(new Date())) {
      client.channels.cache.get(channelID).send("😴🏦💰 Guten Morgen liebe Hebelhelden! Der Pre-market hat geöffnet, das Spiel beginnt! 💰🏦😴");
    } else if (true === isHoliday(new Date()) && 11 === Number(moment().format("MM"))) {
      // Thanksgiving is the only NYSE holiday in November and the market closes at 13:00 local time.
      const usEasternDate = moment.tz("US/Eastern").set({
        "hour": 13,
        "minute": 0,
        "second": 0,
      });
      const deDate = usEasternDate.clone().tz("Europe/Berlin");
      client.channels.cache.get(channelID).send(`🦃🍗🎉 Guten Morgen liebe Hebelhelden! Der Pre-market hat geöffnet und heute ist Truthahn-Tag, also beeilt euch - die Börse macht schon um ${deDate.format("HH")}:${deDate.format("mm")} zu! 🎉🍗🦃`).catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    } else {
      client.channels.cache.get(channelID).send("🛍️🏝️🛥️ Guten Morgen liebe Hebelhelden! Heute bleibt die Börse geschlossen. Genießt den Tag und gebt eure Gewinne für tolle Sachen aus! 🛥️🏝️🛍️").catch(error => {
        logger.log(
          "error",
          error,
        );
      });
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
    } else if (true === isHoliday(new Date()) && 11 === Number(moment().format("MM"))) {
      // Thanksgiving is the only NYSE holiday in November and the market closes at 13:00 local time.
      client.channels.cache.get(channelID).send("🔔🔔🔔 Ich bin ready. Ihr seid ready?! Na dann loooos! Huuuiiii! 🚀 Der Börsenritt beginnt, meine Freunde. Seid dabei, ihr dürft nichts verpassen! 🥳 🎠 🔔🔔🔔").catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseClose, () => {
    if (false === isHoliday(new Date())) {
      client.channels.cache.get(channelID).send("🔔🔔🔔 Es ist wieder so weit, die Börsen sind zu! Teilt eure Ergebnisse in \"Heutige Gains&Losses\" 🔔🔔🔔").catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseCloseEarly, () => {
    if (true === isHoliday(new Date()) && 11 === Number(moment().format("MM"))) {
      // Thanksgiving is the only NYSE holiday in November and the market closes at 13:00 local time.
      client.channels.cache.get(channelID).send("🔔🔔🔔 Es ist wieder so weit, die Börsen sind zu! Teilt eure Ergebnisse in \"Heutige Gains&Losses\" 🔔🔔🔔").catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseAftermarketClose, () => {
    if (false === isHoliday(new Date())) {
      client.channels.cache.get(channelID).send("🛏️🔔🔔 Und jetzt ist auch der aftermarket für euch Nachteulen geschlossen, Zeit fürs Bettchen! 🔔🔔🛏️").catch(error => {
        logger.log(
          "error",
          error,
        );
      });
    }
  });

  Schedule.scheduleJob(ruleNyseAftermarketCloseEarly, () => {
    if (true === isHoliday(new Date()) && 11 === Number(moment().format("MM"))) {
      // Thanksgiving is the only NYSE holiday in November and the aftermarket closes at 17:00 local time.
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
  ruleFriday.minute = 30;
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
}
