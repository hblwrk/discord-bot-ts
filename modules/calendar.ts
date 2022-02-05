import axios from "axios";
import moment from "moment";
import "moment-timezone";

export async function getCalendar(range: number) {
  let deDate = moment.tz("Europe/Berlin").set({
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

  // Weekend, get next monday
  if ((deDate.day() === 6)) {
    deDate = moment(deDate).day(1+7)
  } else if ((deDate.day() === 0)) {
    deDate = moment(deDate).day(1)
  }

  let endDate = deDate.set({
    "hour": 23,
    "minute": 59,
    "second": 59
  });

  if (0 !== range) {
    endDate = moment(deDate).add(range, 'days');
  }

  const calendarResponse = await axios.post("https://www.mql5.com/en/economic-calendar/content", `date_mode=1&from=${moment(deDate).format("YYYY-MM-DD")}T00%3A00%3A00&to=${moment(endDate).format("YYYY-MM-DD")}T23%3A59%3A59&importance=12&currencies=15`, {
    headers: {
      "X-Requested-With": "XMLHttpRequest"
    }
  });
  if (1 < calendarResponse.data.length) {
    let calendarEvents = new Array;

    for (const element of calendarResponse.data) {
      let calendarEvent = new Array;
      let country: string;
      // Discord character limit
      if (2475 <= calendarEvents.toString().length) {
        calendarEvent.push("API Limit");
        calendarEvent.push("");
        calendarEvent.push("");
        calendarEvent.push("🤖 Es konnten nicht alle Termine ausgegeben werden.");
        calendarEvents.push(calendarEvent);
        break;
      } else {
        // Source data does not contain timezone info, guess its UTC...
        let eventDate = moment.utc(element.FullDate).tz("Europe/Berlin");
        if (true === moment(eventDate).isSameOrBefore(endDate)) {        
          const eventDEDate = moment.utc(element.FullDate).clone().tz("Europe/Berlin").format("YYYY-MM-DD");
          const eventDETime = moment.utc(element.FullDate).clone().tz("Europe/Berlin").format("HH:mm");
          if ("840" == element.Country) {
            country = "🇺🇸"
          } else if ("999" == element.Country) {
            country = "🇪🇺"
          } else if ("826" == element.Country) {
            country = "🇬🇧"
          } else if ("724" == element.Country) {
            country = "🇪🇸"
          } else if ("392" == element.Country) {
            country = "🇯🇵"
          }else if ("380" == element.Country) {
            country = "🇮🇹"
          } else if ("276" == element.Country) {
            country = "🇩🇪"
          } else if ("250" == element.Country) {
            country = "🇫🇷"
          } else if ("0" == element.Country) {
            country = "🌍"
          }

          calendarEvent.push(eventDEDate);
          calendarEvent.push(eventDETime);
          calendarEvent.push(country);
          calendarEvent.push(element.EventName);
          calendarEvents.push(calendarEvent);
        }
      }
    }      
    return calendarEvents;
  } else {
    return false;
  }
}
