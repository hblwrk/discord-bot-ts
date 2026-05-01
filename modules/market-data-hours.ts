import moment from "moment-timezone";
import {isHoliday} from "nyse-holidays";
import {
  type MarketDataAsset,
  type MarketPresenceData,
} from "./market-data-types.ts";

export const marketClosedPresence = "Market closed.";
const marketClosedTrend = "⬛";
const usEasternTimezone = "US/Eastern";
const europeBerlinTimezone = "Europe/Berlin";

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

  if (true === isHoliday(easternTime.clone().startOf("day").toDate())) {
    return false;
  }

  const minuteOfDay = easternTime.hour() * 60 + easternTime.minute();
  return minuteOfDay >= ((9 * 60) + 30) && minuteOfDay < ((16 * 60) + 15);
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
