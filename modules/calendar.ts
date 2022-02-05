import axios from "axios";
import moment from "moment";
import "moment-timezone";

export async function getCalendar(range: string) {
  let deDate = moment.tz("Europe/Berlin").set({

    // testing
    /*
    "year": 2022,
    "month": 1,
    "day": 6,
    */
  });
  let startDate: string
  let endDate: string

  if ((deDate.day() === 6) || (deDate.day()  === 0)) {
    // Weekend, get next monday
    deDate = moment(deDate).day(1+7)
  }
  if ("" !== range) {
    startDate = deDate.format("YYYY-MM-DD");
    endDate = deDate.add(range, 'days').format("YYYY-MM-DD");
  } else {
    startDate = deDate.format("YYYY-MM-DD");
    endDate = deDate.add(0, 'days').format("YYYY-MM-DD");
  }
  const calendarResponse = await axios.post("https://www.mql5.com/en/economic-calendar/content", `date_mode=1&from=${startDate}T00%3A00%3A00&to=${endDate}T23%3A59%3A59&importance=12&currencies=15`, {
    headers: {
      "X-Requested-With": "XMLHttpRequest"
    }
  });
  if (1 < calendarResponse.data.length) {
    let calendarEvents = new Array;
    calendarResponse.data.forEach(element => {
      let calendarEvent = new Array;
      let country: string;
      // Source data does not contain timezone info, guess its UTC...
      let eventDate = moment.utc(element.FullDate).tz("Europe/Berlin").format("YYYY-MM-DD");
      if (startDate === eventDate) {
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
        calendarEvent.push(country); 
        calendarEvent.push(eventDETime);
        calendarEvent.push(element.EventName);

        calendarEvents.push(calendarEvent);
      }
    });
    return calendarEvents;
  } else {
    return false;
  }
}
