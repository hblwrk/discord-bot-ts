import axios, { AxiosResponse } from "axios";
import moment from "moment";
import "moment-timezone";

export async function getCalendarEvents(range: number) :Promise<string[]> {
  let startDate :moment.Moment = moment.tz("Europe/Berlin").set({
    // testing
    /*
    "year": 2022,
    "month": 1,
    "day": 6,
    */
    "hour": 0,
    "minute": 0,
    "second": 0
  });

  // During the weekend, use next monday as startDate
  if ((startDate.day() === 6)) {
    startDate = moment(startDate).day(8)
  } else if ((startDate.day() === 0)) {
    startDate = moment(startDate).day(1)
  }

  let endDate :moment.Moment = startDate.set({
    "hour": 23,
    "minute": 59,
    "second": 59
  });

  if (0 !== range) {
    endDate = moment(startDate).add(range, 'days');
  }

  const calendarResponse :AxiosResponse = await axios.post(
    "https://www.mql5.com/en/economic-calendar/content",
    `date_mode=1&from=${moment(startDate).format("YYYY-MM-DD")}T00%3A00%3A00&to=${moment(endDate).format("YYYY-MM-DD")}T23%3A59%3A59&importance=12&currencies=15`,
    {
      headers: {
        "X-Requested-With": "XMLHttpRequest"
      }
    }
  );

  let calendarEvents = new Array;

  if (1 < calendarResponse.data.length) {
    for (const element of calendarResponse.data) {
      const calendarEvent = new Array;

      // Discord character limit
      if (2300 <= calendarEvents.toString().length) {
        calendarEvent.push("API Limit");
        calendarEvent.push("13:37");
        calendarEvent.push("🤖");
        calendarEvent.push("Es konnten nicht alle Termine ausgegeben werden.");
        calendarEvents.push(calendarEvent);
        break;
      } else {
        // Source data does not contain timezone info, guess its UTC...
        const eventDate :moment.Moment = moment.utc(element.FullDate).tz("Europe/Berlin");

        if (true === moment(eventDate).isSameOrBefore(endDate)) {
          let country: string;
          const eventDEDate :string = moment.utc(element.FullDate).clone().tz("Europe/Berlin").format("YYYY-MM-DD");
          const eventDETime :string = moment.utc(element.FullDate).clone().tz("Europe/Berlin").format("HH:mm");

          switch (element.Country) {
            case 999:
              country = "🇪🇺"
              break;
            case 840:
              country = "🇺🇸"
              break;
            case 826:
              country = "🇬🇧"
              break;
            case 724:
              country = "🇪🇸"
              break;
            case 392:
              country = "🇯🇵"
              break;
            case 380:
              country = "🇮🇹"
              break;
            case 276:
              country = "🇩🇪"
              break;
            case 250:
              country = "🇫🇷"
              break;
            case 0:
              country = "🌍"
              break;
          }

          calendarEvent.push(eventDEDate);
          calendarEvent.push(eventDETime);
          calendarEvent.push(country);
          calendarEvent.push(element.EventName);
          calendarEvents.push(calendarEvent);
        }
      }
    }      
  }

  return calendarEvents;
}

export function getCalendarText(calendarEvents: Array<string>) :string {
  let calendarText: string = "none";

  if (1 < calendarEvents.length) {
    let lastDate: string;

    calendarText = `Wichtige Termine:`;
    for (const event of calendarEvents) {
      if (event[0] !== lastDate) {
        calendarText += `\n**${event[0]}**\n`;
      }
      calendarText += `\`${event[1]}\` ${event[2]} ${event[3]}\n`;
      lastDate = event[0];
    };
  }

  return calendarText;
}
