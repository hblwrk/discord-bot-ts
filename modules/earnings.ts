import axios, {AxiosResponse} from "axios";
import moment from "moment";
import "moment-timezone";

export async function getEarnings(date: string, filter: string) :Promise<EarningsEvent[]> {
  let dateStamp: string;

  let usEasternTime :moment.Moment = moment.tz("US/Eastern").set({
    // testing
    /*
    "year": 2022,
    "month": 1,
    "date": 3,
    "hour": 9,
    "minute": 30,
    "second": 0,
    */
  });

  let nyseOpenTime :moment.Moment = moment.tz("US/Eastern").set({
    // testing
    /*
    "year": 2022,
    "month": 1,
    "date": 3,
    */
    "hour": 9,
    "minute": 30,
    "second": 0,
  });

  let nyseCloseTime :moment.Moment = moment.tz("US/Eastern").set({
    // testing
    /*
    "year": 2022,
    "month": 1,
    "date": 3,
    */
    "hour": 16,
    "minute": 0,
    "second": 0,
  });

  // During the weekend, use next Monday
  if ((usEasternTime.day() === 6)) {
    usEasternTime = moment(usEasternTime).day(8)
    nyseOpenTime = moment(nyseOpenTime).day(8)
    nyseCloseTime = moment(nyseCloseTime).day(8)
  } else if ((usEasternTime.day() === 0)) {
    usEasternTime = moment(usEasternTime).day(1)
    nyseOpenTime = moment(nyseOpenTime).day(1)
    nyseCloseTime = moment(nyseCloseTime).day(1)
  }

  if (null === date || "today" === date) {
    dateStamp = usEasternTime.format("YYYY-MM-DD");
  }

  let watchlist :string = "";

  if ("all" !== filter) {
    watchlist = `&watchlist=${filter}`
  }

  const earningsResponse :AxiosResponse = await axios.get(`https://app.fincredible.ai/api/v1/events/?date=${dateStamp}${watchlist}`);

  let earningsEvents = new Array;

  if (1 < earningsResponse.data.length) {

    for (const element of earningsResponse.data) {
      const earningsEvent = new EarningsEvent;
      earningsEvent.ticker = element.text;
      earningsEvent.date = dateStamp;
      if (true === moment(element.start_date).isBefore(nyseOpenTime)) {
        earningsEvent.when = "before_open";
      } else if (true === moment(element.start_date).isSameOrAfter(nyseOpenTime) && true === moment(element.start_date).isBefore(nyseCloseTime)) {
        earningsEvent.when = "during_session";
      } else {
        earningsEvent.when = "after_close";
      }
      earningsEvents.push(earningsEvent);
    };
  }

  return earningsEvents;
}

export function getEarningsText(earningsEvents: Array<EarningsEvent>, when: string) :string {
  let earningsText: string = "none";

  if (1 < earningsEvents.length) {
    let earningsBeforeOpen: string = "";
    let earningsDuringSession: string = "";
    let earningsAfterClose: string = "";

    for (const earningEvent of earningsEvents) {
      if ("before_open" === earningEvent.when) {
        earningsBeforeOpen += `${earningEvent.ticker}, `;
      } else if ("during_session" === earningEvent.when) {
        earningsDuringSession += `${earningEvent.ticker}, `;
      } else if ("after_close" === earningEvent.when) {
        earningsAfterClose += `${earningEvent.ticker}, `;
      }
    };

    earningsText = `Anstehende earnings (${earningsEvents[0].date}):\n`;
    if (1 < earningsBeforeOpen.length && ("all" === when || "before_open" === when)) {
      earningsText += `**Vor open:**\n${earningsBeforeOpen.slice(0, -2)}\n\n`;
    }
    if (1 < earningsDuringSession.length && ("all" === when || "during_session" === when)) {
      earningsText += `**Während der Handelszeiten:**\n${earningsDuringSession.slice(0, -2)}\n\n`;
    }
    if (1 < earningsAfterClose.length && ("all" === when || "after_close" === when)) {
      earningsText += `**Nach close:**\n${earningsAfterClose.slice(0, -2)}`;
    }
  }

  return earningsText;
}

class EarningsEvent {
  private _ticker: string;
  private _when: string;
  private _date: string;

  public get ticker() {
    return this._ticker;
  }

  public set ticker(ticker: string) {
    this._ticker = ticker;
  }

  public get when() {
    return this._when;
  }

  public set when(when: string) {
    this._when = when;
  }

  public get date() {
    return this._date;
  }

  public set date(date: string) {
    this._date = date;
  }
}
