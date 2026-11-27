import moment from "moment-timezone";
import {sessionClose} from "us-equity-market-calendar";
import {
  type MarketDataAsset,
  type MarketHoursProfile,
  type MarketPresenceData,
} from "./market-data-types.ts";

export const marketClosedPresence = "Market closed.";
const marketClosedTrend = "⬛";
const usEasternTimezone = "US/Eastern";
const europeBerlinTimezone = "Europe/Berlin";
// Minutes the us_cash profile stays "open" after the closing bell.
const usCashCloseGraceMinutes = 15;
// The 23x5 US equity session (Nasdaq, NYSE Arca) runs from Sunday 21:00 to
// Friday 20:00 US/Eastern and pauses from 20:00 to 21:00 on weekdays. Trades
// after the pause starts count toward the next trade date.
export const us23x5PauseStartHourET = 20;
export const us23x5ResumeHourET = 21;

export function buildClosedMarketPresenceData(): Omit<MarketPresenceData, "nickname"> {
  return {
    presence: marketClosedPresence,
    presenceStatus: "idle",
  };
}

export function getMarketPresenceData(
  marketDataAsset: MarketDataAsset,
  openNickname: string,
  openPresence: string,
  priceChange: number,
  referenceTime = Date.now(),
): MarketPresenceData {
  if (false === isMarketOpen(marketDataAsset, referenceTime)) {
    return {
      nickname: getClosedMarketNickname(marketDataAsset, openNickname) ?? openNickname,
      ...buildClosedMarketPresenceData(),
    };
  }

  return {
    nickname: openNickname,
    presence: openPresence,
    presenceStatus: priceChange < 0 ? "dnd" : "online",
  };
}

export function getClosedMarketNickname(marketDataAsset: MarketDataAsset, nickname?: string): string | null {
  const normalizedNickname = nickname?.trim();
  if ("string" !== typeof normalizedNickname || "" === normalizedNickname) {
    return null;
  }

  const firstSpacePosition = normalizedNickname.indexOf(" ");
  if (-1 === firstSpacePosition) {
    return `${marketDataAsset.order}${marketClosedTrend}`;
  }

  return `${marketDataAsset.order}${marketClosedTrend}${normalizedNickname.slice(firstSpacePosition)}`;
}

export function isMarketOpen(marketDataAsset: MarketDataAsset, referenceTime = Date.now()): boolean {
  const marketHours = marketDataAsset.marketHours ?? "us_futures";

  return isMarketHoursOpen(marketHours, referenceTime);
}

export function isMarketHoursOpen(marketHours: MarketHoursProfile, referenceTime = Date.now()): boolean {
  switch (marketHours) {
    case "crypto": {
      return true;
    }

    case "eu_cash": {
      return isOpenDuringLocalWeekdayWindow(referenceTime, europeBerlinTimezone, 9, 0, 17, 30);
    }

    case "forex": {
      return isForexMarketOpen(referenceTime);
    }

    case "us_23x5": {
      return isUs23x5MarketOpen(referenceTime);
    }

    case "us_cash": {
      return isUsCashMarketOpen(referenceTime);
    }

    case "us_futures":
    default: {
      return isUsFuturesMarketOpen(referenceTime);
    }
  }
}

function isForexMarketOpen(referenceTime: number): boolean {
  const easternTime = moment.tz(referenceTime, usEasternTimezone);
  const day = easternTime.day();
  const minuteOfDay = easternTime.hour() * 60 + easternTime.minute();

  if (6 === day) {
    return false;
  }

  if (5 === day) {
    return minuteOfDay < (17 * 60);
  }

  if (0 === day) {
    return minuteOfDay >= (17 * 60);
  }

  return true;
}

function isUsCashMarketOpen(referenceTime: number): boolean {
  const easternTime = moment.tz(referenceTime, usEasternTimezone);

  if (true === isWeekend(easternTime.day())) {
    return false;
  }

  // null on full closures (holidays, days of mourning); "13:00" on early-close days.
  const closeTimeET = sessionClose(easternTime.format("YYYY-MM-DD"));
  if (null === closeTimeET) {
    return false;
  }

  // closeTimeET is "HH:MM".
  const closeMinuteOfDay = (Number(closeTimeET.slice(0, 2)) * 60) + Number(closeTimeET.slice(3, 5));
  const minuteOfDay = easternTime.hour() * 60 + easternTime.minute();
  return minuteOfDay >= ((9 * 60) + 30) && minuteOfDay < (closeMinuteOfDay + usCashCloseGraceMinutes);
}

// Exchange view of the 23x5 session: the ATS-only EARLY hour during the pause
// is not counted, and holidays are not modelled (same as us_futures).
function isUs23x5MarketOpen(referenceTime: number): boolean {
  const easternTime = moment.tz(referenceTime, usEasternTimezone);
  const day = easternTime.day();
  const minuteOfDay = easternTime.hour() * 60 + easternTime.minute();
  const pauseStartMinute = us23x5PauseStartHourET * 60;
  const resumeMinute = us23x5ResumeHourET * 60;

  if (6 === day) {
    return false;
  }

  if (0 === day) {
    return minuteOfDay >= resumeMinute;
  }

  if (5 === day) {
    return minuteOfDay < pauseStartMinute;
  }

  return minuteOfDay < pauseStartMinute || minuteOfDay >= resumeMinute;
}

function isUsFuturesMarketOpen(referenceTime: number): boolean {
  const easternTime = moment.tz(referenceTime, usEasternTimezone);
  const day = easternTime.day();
  const minuteOfDay = easternTime.hour() * 60 + easternTime.minute();

  if (6 === day) {
    return false;
  }

  if (5 === day) {
    return minuteOfDay < (17 * 60);
  }

  if (0 === day) {
    return minuteOfDay >= (18 * 60);
  }

  return minuteOfDay < (17 * 60) || minuteOfDay >= (18 * 60);
}

function isOpenDuringLocalWeekdayWindow(
  referenceTime: number,
  timezone: string,
  startHour: number,
  startMinute: number,
  endHour: number,
  endMinute: number,
): boolean {
  const localTime = moment.tz(referenceTime, timezone);
  if (true === isWeekend(localTime.day())) {
    return false;
  }

  const minuteOfDay = localTime.hour() * 60 + localTime.minute();
  const startMinuteOfDay = (startHour * 60) + startMinute;
  const endMinuteOfDay = (endHour * 60) + endMinute;

  return minuteOfDay >= startMinuteOfDay && minuteOfDay < endMinuteOfDay;
}

function isWeekend(dayOfWeek: number): boolean {
  return 0 === dayOfWeek || 6 === dayOfWeek;
}
