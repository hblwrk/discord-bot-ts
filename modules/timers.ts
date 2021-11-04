import {MessageAttachment, MessageEmbed} from "discord.js";
import moment from "moment";
import Schedule from "node-schedule";
import {isHoliday} from "nyse-holidays";
import {getAssetByName} from "./assets";
import {getFromDracoon} from "./dracoon-downloader";
import {getFromReuters} from "./mnc-downloader";
import {readSecret} from "./secrets";

export function startNyseTimers(client, channelID: string) {
  const ruleNYSEPremarketOpen = new Schedule.RecurrenceRule();
  ruleNYSEPremarketOpen.hour = 4;
  ruleNYSEPremarketOpen.minute = 0;
  ruleNYSEPremarketOpen.dayOfWeek = [0, new Schedule.Range(1, 5)];
  ruleNYSEPremarketOpen.tz = "US/Eastern";

  const ruleNYSEOpen = new Schedule.RecurrenceRule();
  ruleNYSEOpen.hour = 9;
  ruleNYSEOpen.minute = 30;
  ruleNYSEOpen.dayOfWeek = [0, new Schedule.Range(1, 5)];
  ruleNYSEOpen.tz = "US/Eastern";

  const ruleNYSEClose = new Schedule.RecurrenceRule();
  ruleNYSEClose.hour = 16;
  ruleNYSEClose.minute = 0;
  ruleNYSEOpen.dayOfWeek = [0, new Schedule.Range(1, 5)];
  ruleNYSEClose.tz = "US/Eastern";

  const ruleNYSEAftermarketClose = new Schedule.RecurrenceRule();
  ruleNYSEAftermarketClose.hour = 20;
  ruleNYSEAftermarketClose.minute = 0;
  ruleNYSEAftermarketClose.dayOfWeek = [0, new Schedule.Range(1, 5)];
  ruleNYSEAftermarketClose.tz = "US/Eastern";

  const jobNYSEPremarketOpen = Schedule.scheduleJob(ruleNYSEPremarketOpen, () => {
    if (false === isHoliday(new Date())) {
      client.channels.cache.get(channelID).send(`😴🏦💰 Guten Morgen liebe Hebelden! Der premarket hat geöffnet, das Spiel beginnt! 💰🏦🥱😴`);
    } else {
      client.channels.cache.get(channelID).send(`🛍️🏝️🛥️🥺 Guten Morgen liebe Hebelden! Heute bleibt die Börse geschlossen. Genießt den Tag und gebt eure Gewinne für tolle Sachen aus! 🥺🛥️🏝️🛍️`).catch(console.error);
    }
  });

  const jobNYSEOpen = Schedule.scheduleJob(ruleNYSEOpen, () => {
    if (false === isHoliday(new Date())) {
      client.channels.cache.get(channelID).send(`🔔🔔🔔 Ich bin ready. Ihr seid ready?! Na dann loooos! Huuuiiii! 🚀 Der Börsenritt beginnt, meine Freunde. Seid dabei, ihr dürft nichts verpassen! 🥳 🎠 🔔🔔🔔`).catch(console.error);
    }
  });

  const jobNYSEClose = Schedule.scheduleJob(ruleNYSEClose, () => {
    if (false === isHoliday(new Date())) {
      client.channels.cache.get(channelID).send(`🔔🔔🔔 Es ist wieder so weit, die Börsen sind zu! 🔔🔔🔔`).catch(console.error);
    }
  });

  const jobNYSEAftermarketClose = Schedule.scheduleJob(ruleNYSEAftermarketClose, () => {
    if (false === isHoliday(new Date())) {
      client.channels.cache.get(channelID).send(`🛏️🔔🔔 Und jetzt ist auch der aftermarket für euch Nachteulen geschlossen, Zeit fürs Bettchen! 🔔🔔🛏️`).catch(console.error);
    }
  });
}

export function startMncTimers(client, channelID: string) {
  const ruleMNC = new Schedule.RecurrenceRule();
  ruleMNC.hour = 9;
  ruleMNC.minute = 0;
  ruleMNC.dayOfWeek = [0, new Schedule.Range(1, 5)];
  ruleMNC.tz = "Europe/Berlin";

  const jobMNC = Schedule.scheduleJob(ruleMNC, () => {
    getFromReuters(buffer => {
      moment.locale("de");
      const date = moment().format("dddd, Do MMMM YYYY");
      const shortDate = moment().format("YYYY-MM-DD");
      const fileName = `MNC-${shortDate}.pdf`;
      const mncFile = new MessageAttachment(buffer, fileName);
      client.channels.cache.get(channelID).send({content: `Morning News Call (${date})`, files: [mncFile]});
    });
  });
}

export function startOtherTimers(client, channelID: string) {
  const ruleFriday = new Schedule.RecurrenceRule();
  ruleFriday.hour = 9;
  ruleFriday.minute = 0;
  ruleFriday.dayOfWeek = [5];
  ruleFriday.tz = "Europe/Berlin";

  const jobFriday = Schedule.scheduleJob(ruleFriday, () => {
    getFromDracoon(readSecret("dracoon_password"), getAssetByName("freitag").getLocationId(), buffer => {
      const fridayFile = new MessageAttachment(buffer, getAssetByName("freitag").getFileName());
      const fridayEmbed = new MessageEmbed();
      fridayEmbed.setImage(`attachment://${getAssetByName("freitag").getFileName()}`);
      client.channels.cache.get(channelID).send({embeds: [fridayEmbed], files: [fridayFile]}).catch(console.error);
    });
  });
}
