import axios, {AxiosResponse} from "axios";
import moment from "moment-timezone";

export async function getCalendarEvents(startDay: string, range: number): Promise<CalendarEvent[]> {
  console.log(startDay);
  console.log(range);
  if ("" === startDay) {
    startDay = moment.tz("Europe/Berlin").format("YYYY-MM-DD");
  }

  let startDate: moment.Moment = moment(startDay).tz("Europe/Berlin").set({
    // Testing
    /*
    year: 2022,
    month: 1,
    day: 6,
    */
    hour: 0,
    minute: 0,
    second: 0,
  });

  // During the weekend, use next Monday as startDate
  if ((startDate.day() === 6)) {
    startDate = moment(startDate).day(8);
  } else if ((startDate.day() === 0)) {
    startDate = moment(startDate).day(1);
  }

  let endDate = moment(startDate);
  endDate.set({
    hour: 23,
    minute: 59,
    second: 59,
  });

  if (0 !== range) {
    endDate = moment(endDate).add(range, "days");
  }

  const calendarResponse: AxiosResponse = await axios.post(
    "https://www.mql5.com/en/economic-calendar/content",
    `date_mode=0&from=${moment(startDate).format("YYYY-MM-DD")}T00%3A00%3A00&to=${moment(endDate).format("YYYY-MM-DD")}T23%3A59%3A59&importance=12&currencies=15`,
    {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.169 Safari/537.36",
      },
    },
  );

  const calendarEvents = [];

  if (1 < calendarResponse.data.length) {
    for (const element of calendarResponse.data) {
      const calendarEvent = new CalendarEvent();

      // Discord character limit
      let objectValueLength = 0;

      for (const event of calendarEvents) {
        for (const value of Object.values(event)) {
          objectValueLength += value.toString().length;
        }
      }

      if (2000 <= objectValueLength) {
        calendarEvent.date = "APILimit";
        calendarEvent.time = "13:37";
        calendarEvent.country = "🤖";
        calendarEvent.name = "Es konnten nicht alle Termine ausgegeben werden.";
        calendarEvents.push(calendarEvent);
        break;
      } else {
        // Source data does not contain timezone info, guess its UTC...
        const eventDate: moment.Moment = moment.utc(element.FullDate).tz("Europe/Berlin");

        if (true === moment(eventDate).isSameOrBefore(endDate) && true === moment(eventDate).isSameOrAfter(startDate)) {
          let country: string;
          const eventDeDate: string = moment.utc(element.FullDate).clone().tz("Europe/Berlin").format("YYYY-MM-DD");
          const eventDeTime: string = moment.utc(element.FullDate).clone().tz("Europe/Berlin").format("HH:mm");

          switch (element.Country) {
            case 999:
              country = "🇪🇺";
              break;
            case 840:
              country = "🇺🇸";
              break;
            case 826:
              country = "🇬🇧";
              break;
            case 724:
              country = "🇪🇸";
              break;
            case 392:
              country = "🇯🇵";
              break;
            case 380:
              country = "🇮🇹";
              break;
            case 276:
              country = "🇩🇪";
              break;
            case 250:
              country = "🇫🇷";
              break;
            case 0:
              country = "🌍";
              break;
            // No default
          }

          calendarEvent.date = eventDeDate;
          calendarEvent.time = eventDeTime;
          calendarEvent.country = country;
          calendarEvent.name = element.EventName;
          calendarEvents.push(calendarEvent);
        }
      }
    }
  }

  return calendarEvents;
}

export function getCalendarText(calendarEvents: CalendarEvent[]): string {
  let calendarText = "none";

  if (1 < calendarEvents.length) {
    let lastDate: string;

    calendarText = "Wichtige Termine:";
    for (const event of calendarEvents) {
      if (event.date !== lastDate) {
        moment.locale("de");
        const friendlyDate = "APILimit" === event.date ? "API Limit" : moment(event.date).format("dddd, Do MMMM YYYY");
        calendarText += `\n**${friendlyDate}**\n`;
      }

      calendarText += `\`${event.time}\` ${event.country} ${event.name}\n`;
      lastDate = event.date;
    }
  }

  return calendarText;
}

export class CalendarEvent {
  private _date: string;
  private _time: string;
  private _country: string;
  private _name: string;

  public get date() {
    return this._date;
  }

  public set date(date: string) {
    this._date = date;
  }

  public get time() {
    return this._time;
  }

  public set time(time: string) {
    this._time = time;
  }

  public get country() {
    return this._country;
  }

  public set country(country: string) {
    this._country = country;
  }

  public get name() {
    return this._name;
  }

  public set name(name: string) {
    this._name = name;
  }
}
