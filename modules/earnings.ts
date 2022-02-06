import axios from "axios";
import moment from "moment";
import "moment-timezone";

export async function getEarnings(date: string, when: string, filter: string) {
  let dateStamp: string;

  const usEasternTime = moment.tz("US/Eastern").set({
    
    // testing
    "year": 2022,
    "month": 1,
    "date": 3,
    "hour": 9,
    "minute": 30,
    "second": 0,
  
  });

  // Don't check on weekends
  if (usEasternTime.day() === 6 || usEasternTime.day() === 0) {
    return "weekend";
  }

  if (null === date || "today" === date) {
    dateStamp = usEasternTime.format("YYYY-MM-DD");
  }

  // If no before/after is defined, return whatever event is next
  if ("" === when) {
    const deTime = usEasternTime.clone().tz("Europe/Berlin");

    if (moment().isBefore(deTime)) {
      when = "before"
    } else {
      when = "after"
    }
  }

  dateStamp = usEasternTime.format("YYYY-MM-DD");
  const earningsResponse = await axios.get(`https://app.fincredible.ai/api/v1/events/?date=${dateStamp}&watchlist=${filter}`);

  if (1 < earningsResponse.data.length) {
    let earningsBeforeOpen = new Array;
    let earningsAfterClose = new Array;

    for (const element of earningsResponse.data) {
      if (true === moment(element.start_date).isBefore(usEasternTime)) {
        earningsBeforeOpen.push(element.text);
      } else {
        earningsAfterClose.push(element.text);
      }
    };

    if ("all" == when) {
      return earningsBeforeOpen.concat(earningsAfterClose);
    } else if ("before" == when) {
      return earningsBeforeOpen
    } else if ("after" == when) {
      return earningsAfterClose
    }
  } else {
    return false;
  }
}
