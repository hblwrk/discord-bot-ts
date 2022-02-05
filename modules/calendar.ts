import axios from "axios";
import moment from "moment";
import "moment-timezone";

export async function getCalendar(range: string) {
  const usEasternTime = moment.tz("US/Eastern").set({
    /*
    // testing
    "year": 2022,
    "month": 1,
    "day": 6,
    */
    "hour": 9,
    "minute": 30,
    "second": 0,
  });
  let startDate: string
  let endDate: string

  if ("" !== range) {
    startDate = usEasternTime.format("YYYY-MM-DD");
    endDate = usEasternTime.add(range, 'days').format("YYYY-MM-DD");
  } else {
    startDate = usEasternTime.format("YYYY-MM-DD");
    endDate = usEasternTime.add(7, 'days').format("YYYY-MM-DD");
  }
  
  const calendarResponse = await axios.post("https://www.mql5.com/en/economic-calendar/content", `date_mode=1&from=${startDate}T00%3A00%3A00&to=${endDate}T23%3A59%3A59&importance=8&currencies=11`, {
    headers: {
      "X-Requested-With": "XMLHttpRequest"
    }
  });
  if (1 < calendarResponse.data.length) {
    let calendarEvents = new Array;
    calendarResponse.data.forEach(element => {
      let calendarEvent = new Array;
      let country: string;
      calendarEvent.push(moment(element.ReleaseDate).format("YYYY-MM-DD HH:mm"));
      calendarEvent.push(element.EventName);
      if ("999" == element.Country) {
        country = "🇺🇸"
      } else if ("840" == element.Country) {
        country = "🇪🇺"
      } else if ("826" == element.Country) {
        country = "🇬🇧"
      } else if ("276" == element.Country) {
        country = "🇩🇪"
      } else if ("250" == element.Country) {
        country = "🇫🇷"
      }  
      calendarEvent.push(country); 
      calendarEvents.push(calendarEvent);
    });
    return calendarEvents;
  } else {
    return false;
  }
}
