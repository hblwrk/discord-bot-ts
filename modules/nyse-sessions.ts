import moment from "moment-timezone";
import {isEarlyClose, isHoliday} from "us-equity-market-calendar";
import {us23x5PauseStartHourET, us23x5ResumeHourET} from "./market-data-hours.ts";

const usEasternTimezone = "US/Eastern";
const europeBerlinTimezone = "Europe/Berlin";
const dateFormat = "YYYY-MM-DD";
// Covers the longest NYSE closure stretch (a holiday next to a weekend, or an
// unscheduled multi-day closure) with margin.
const maxTradeDayLookaheadDays = 14;
const nyseHolidayMorningNotice = "🛍️🏝️🛥️ Guten Morgen liebe Hebelhelden! Heute bleibt die Börse geschlossen. Genießt den Tag und gebt eure Gewinne für tolle Sachen aus! 🛥️🏝️🛍️";

/** True when the NYSE trades on the US/Eastern calendar day of `date`. */
export function isNyseTradingDay(date: moment.Moment): boolean {
  const easternDay = date.clone().tz(usEasternTimezone);
  const dayOfWeek = easternDay.day();
  if (0 === dayOfWeek || 6 === dayOfWeek) {
    return false;
  }

  return false === Boolean(isHoliday(easternDay.format(dateFormat)));
}

/**
 * The trade date (YYYY-MM-DD) that 23x5 trading at `referenceTime` counts
 * toward: the same day until the 20:00 US/Eastern pause on a trading day,
 * otherwise the next trading day. Undefined when no trading day follows within
 * the lookahead window.
 */
export function getSessionTradeDate(referenceTime = new Date()): string | undefined {
  return getSessionTradeDay(referenceTime)?.format(dateFormat);
}

/** Holiday or early-close note for the morning, or undefined on a regular trading day. */
export function getNyseMorningNotice(referenceTime = new Date()): string | undefined {
  const todayDate = getUsEasternDay(referenceTime).format(dateFormat);
  if (true === Boolean(isHoliday(todayDate))) {
    return nyseHolidayMorningNotice;
  }

  const earlyClose = isEarlyClose(todayDate);
  if (!earlyClose) {
    return undefined;
  }

  const closeTimeBerlin = moment.tz(`${todayDate} ${earlyClose.closeTimeET}`, "YYYY-MM-DD HH:mm", usEasternTimezone)
    .tz(europeBerlinTimezone)
    .format("HH:mm");
  if ("Day after Thanksgiving" === earlyClose.name) {
    return `🦃🍗🎉 Guten Morgen liebe Hebelhelden! Heute ist der Tag nach dem Truthahn-Tag, also beeilt euch - die Börse macht schon um ${closeTimeBerlin} zu! 🎉🍗🦃`;
  }

  return `⏰🔔 Guten Morgen liebe Hebelhelden! Heute ist ein verkürzter Handelstag - die Börse macht schon um ${closeTimeBerlin} zu! 🔔⏰`;
}

/**
 * Announcement for the 20:00 US/Eastern end of a trading day's session: the
 * one-hour pause when trading resumes at 21:00, otherwise the close until the
 * next session opens. Undefined on non-trading days and on early-close days,
 * whose overnight cutoff the exchanges do not publish.
 */
export function getNyseEveningCloseAnnouncement(referenceTime = new Date()): string | undefined {
  const today = getUsEasternDay(referenceTime);
  if (false === isNyseTradingDay(today) || true === isNyseEarlyCloseDay(today)) {
    return undefined;
  }

  const nextTradeDay = getNextNyseTradingDay(today);
  if (undefined === nextTradeDay) {
    return undefined;
  }

  const nextOpen = getSessionOpen(nextTradeDay);
  const nextOpenBerlin = nextOpen.clone().tz(europeBerlinTimezone);
  if (true === nextTradeDay.isSame(today.clone().add(1, "day"), "day")) {
    return `☕🔔 Verschnaufpause, liebe Hebelhelden! Der US-Aktienhandel pausiert jetzt für eine Stunde und geht um ${nextOpen.format("HH:mm")} US/Eastern / ${nextOpenBerlin.format("HH:mm")} Europe/Berlin weiter. 🔔☕`;
  }

  const reopenText = `${formatGermanWeekday(nextOpen)} um ${nextOpen.format("HH:mm")} US/Eastern (${formatGermanWeekday(nextOpenBerlin)}, ${nextOpenBerlin.format("HH:mm")} Europe/Berlin)`;
  if (5 === today.day()) {
    return `🍻🔔🔔 Feierabend und schönes Wochenende, liebe Hebelhelden! Der US-Aktienhandel ist jetzt geschlossen und öffnet wieder am ${reopenText}. 🔔🔔🍻`;
  }

  return `🛏️🔔🔔 Und jetzt ist der US-Aktienhandel für euch Nachteulen geschlossen, Zeit fürs Bettchen! Weiter geht's am ${reopenText}. 🔔🔔🛏️`;
}

/**
 * Announcement for the 21:00 US/Eastern session open: the resume after a
 * trading day's pause, the start of a trading week, or the return after a
 * holiday. Undefined when the next calendar day is not a trading day.
 */
export function getNyseEveningOpenAnnouncement(referenceTime = new Date()): string | undefined {
  const today = getUsEasternDay(referenceTime);
  const tradeDay = getSessionTradeDay(referenceTime);
  if (undefined === tradeDay || false === tradeDay.isSame(today.clone().add(1, "day"), "day")) {
    return undefined;
  }

  const tradeDayText = tradeDay.clone().locale("de").format("dddd, D. MMMM");
  if (true === isNyseTradingDay(today) && false === isNyseEarlyCloseDay(today)) {
    return `🔔🚀 Pause vorbei, weiter geht's! Die Overnight-Session für den Handelstag ${tradeDayText} ist offen. 🚀🔔`;
  }

  if (true === isFirstTradingDayOfWeek(tradeDay)) {
    return `🌃🔔 Die neue Handelswoche startet, liebe Hebelhelden! Die Overnight-Session für den Handelstag ${tradeDayText} ist offen. 🔔🌃`;
  }

  return `🌃🔔 Die Börse ist zurück, liebe Hebelhelden! Die Overnight-Session für den Handelstag ${tradeDayText} ist offen. 🔔🌃`;
}

function getSessionTradeDay(referenceTime: Date): moment.Moment | undefined {
  const easternTime = moment(referenceTime).tz(usEasternTimezone);
  const today = easternTime.clone().startOf("day");
  if (easternTime.hour() < us23x5PauseStartHourET && true === isNyseTradingDay(today)) {
    return today;
  }

  return getNextNyseTradingDay(today);
}

// The session for a trade day opens at 21:00 US/Eastern on the calendar day before it.
function getSessionOpen(tradeDay: moment.Moment): moment.Moment {
  return tradeDay.clone().subtract(1, "day").set({
    hour: us23x5ResumeHourET,
    millisecond: 0,
    minute: 0,
    second: 0,
  });
}

function getUsEasternDay(referenceTime: Date): moment.Moment {
  return moment(referenceTime).tz(usEasternTimezone).startOf("day");
}

function getNextNyseTradingDay(day: moment.Moment): moment.Moment | undefined {
  for (let offset = 1; offset <= maxTradeDayLookaheadDays; offset += 1) {
    const candidate = day.clone().add(offset, "days");
    if (true === isNyseTradingDay(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function isNyseEarlyCloseDay(day: moment.Moment): boolean {
  return Boolean(isEarlyClose(day.format(dateFormat)));
}

function isFirstTradingDayOfWeek(tradeDay: moment.Moment): boolean {
  const day = tradeDay.clone().startOf("isoWeek");
  while (true === day.isBefore(tradeDay, "day")) {
    if (true === isNyseTradingDay(day)) {
      return false;
    }

    day.add(1, "day");
  }

  return true;
}

function formatGermanWeekday(time: moment.Moment): string {
  return time.clone().locale("de").format("dddd");
}
