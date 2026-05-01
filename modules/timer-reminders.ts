/* eslint-disable import/extensions */
import {
  type CalendarReminderAsset,
  type EarningsReminderAsset,
} from "./assets.ts";
import {type CalendarEvent} from "./calendar.ts";
import {type EarningsEvent} from "./earnings.ts";

const earningsReminderWhenSortRank = new Map<string, number>([
  ["before_open", 0],
  ["during_session", 1],
  ["after_close", 2],
]);
const earningsReminderWhenLabel = new Map<string, string>([
  ["before_open", "vor Handelsbeginn"],
  ["during_session", "während der Handelszeiten"],
  ["after_close", "nach Handelsschluss"],
]);

export function getAllowedRoleMentions(roleId: string) {
  return {
    parse: [],
    roles: [roleId],
  };
}

function getRoleMention(roleId: string): string {
  return `<@&${roleId}>`;
}

function getDiscordMonospaceText(value: string): string {
  return `\`${value.replaceAll("`", "")}\``;
}

function normalizeLowerCaseValue(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTickerSymbol(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replaceAll("/", ".")
    .replaceAll("-", ".");
}

export function getNormalizedRoleId(roleId: string | undefined): string | undefined {
  const normalizedRoleId = roleId?.trim();
  if (!normalizedRoleId) {
    return undefined;
  }

  return normalizedRoleId;
}

function getNormalizedCalendarReminderMatchers(calendarReminderAsset: CalendarReminderAsset): string[] {
  if (false === Array.isArray(calendarReminderAsset.eventNameSubstrings)) {
    return [];
  }

  return calendarReminderAsset.eventNameSubstrings
    .filter((eventNameSubstring): eventNameSubstring is string => "string" === typeof eventNameSubstring)
    .map(normalizeLowerCaseValue)
    .filter(eventNameSubstring => "" !== eventNameSubstring);
}

function getNormalizedCalendarReminderCountryFlags(calendarReminderAsset: CalendarReminderAsset): string[] {
  if (false === Array.isArray(calendarReminderAsset.countryFlags)) {
    return [];
  }

  return calendarReminderAsset.countryFlags
    .filter((countryFlag): countryFlag is string => "string" === typeof countryFlag)
    .map(countryFlag => countryFlag.trim())
    .filter(countryFlag => "" !== countryFlag);
}

function getNormalizedEarningsReminderTickers(earningsReminderAsset: EarningsReminderAsset): string[] {
  if (false === Array.isArray(earningsReminderAsset.tickerSymbols)) {
    return [];
  }

  return earningsReminderAsset.tickerSymbols
    .filter((tickerSymbol): tickerSymbol is string => "string" === typeof tickerSymbol)
    .map(normalizeTickerSymbol)
    .filter(tickerSymbol => "" !== tickerSymbol);
}

function isCalendarReminderMatch(calendarReminderAsset: CalendarReminderAsset, calendarEvent: CalendarEvent): boolean {
  const eventNameSubstrings = getNormalizedCalendarReminderMatchers(calendarReminderAsset);
  if (0 === eventNameSubstrings.length) {
    return false;
  }

  const countryFlags = getNormalizedCalendarReminderCountryFlags(calendarReminderAsset);
  if (0 < countryFlags.length && false === countryFlags.includes(calendarEvent.country)) {
    return false;
  }

  const normalizedEventName = normalizeLowerCaseValue(calendarEvent.name);
  return eventNameSubstrings.some(eventNameSubstring => normalizedEventName.includes(eventNameSubstring));
}

function getCalendarReminderJobKey(calendarReminderAsset: CalendarReminderAsset, calendarEvent: CalendarEvent): string {
  const assetName = calendarReminderAsset.name?.trim() || "calendar-reminder";
  const roleId = getNormalizedRoleId(calendarReminderAsset.roleId) ?? "missing-role";
  return `${assetName}|${roleId}|${calendarEvent.date}|${calendarEvent.time}|${calendarEvent.country}`;
}

function getCalendarReminderEventSummary(calendarEvents: CalendarEvent[]): string {
  const uniqueEventNames: string[] = [];
  const seenEventNames = new Set<string>();

  for (const calendarEvent of calendarEvents) {
    const normalizedEventName = calendarEvent.name?.trim();
    if (!normalizedEventName || true === seenEventNames.has(normalizedEventName)) {
      continue;
    }

    uniqueEventNames.push(normalizedEventName);
    seenEventNames.add(normalizedEventName);
  }

  return uniqueEventNames.join(", ");
}

export function getCalendarReminderMessage(roleId: string, calendarEvents: CalendarEvent[]): string {
  const primaryEvent = calendarEvents[0];
  if (undefined === primaryEvent) {
    return `${getRoleMention(roleId)} Heute wichtig:`;
  }

  return `${getRoleMention(roleId)} Heute wichtig: \`${primaryEvent.time}\` ${primaryEvent.country} ${getCalendarReminderEventSummary(calendarEvents)}`;
}

export function getMatchedCalendarReminderEventGroups(
  calendarReminderAssets: CalendarReminderAsset[],
  calendarEvents: CalendarEvent[],
): {asset: CalendarReminderAsset; events: CalendarEvent[]}[] {
  const groupedReminderEvents = new Map<string, {asset: CalendarReminderAsset; events: CalendarEvent[]}>();

  for (const calendarReminderAsset of calendarReminderAssets) {
    const roleId = getNormalizedRoleId(calendarReminderAsset.roleId);
    if (!roleId) {
      continue;
    }

    for (const calendarEvent of calendarEvents) {
      if (false === isCalendarReminderMatch(calendarReminderAsset, calendarEvent)) {
        continue;
      }

      const reminderKey = getCalendarReminderJobKey(calendarReminderAsset, calendarEvent);
      const existingReminderGroup = groupedReminderEvents.get(reminderKey);
      if (existingReminderGroup) {
        existingReminderGroup.events.push(calendarEvent);
        continue;
      }

      groupedReminderEvents.set(reminderKey, {
        asset: calendarReminderAsset,
        events: [calendarEvent],
      });
    }
  }

  return [...groupedReminderEvents.values()];
}

function compareEarningsReminderEvents(
  first: EarningsEvent,
  second: EarningsEvent,
  tickerOrderBySymbol: Map<string, number>,
): number {
  const firstSortRank = earningsReminderWhenSortRank.get(first.when) ?? Number.MAX_SAFE_INTEGER;
  const secondSortRank = earningsReminderWhenSortRank.get(second.when) ?? Number.MAX_SAFE_INTEGER;
  if (firstSortRank !== secondSortRank) {
    return firstSortRank - secondSortRank;
  }

  const firstTickerOrder = tickerOrderBySymbol.get(normalizeTickerSymbol(first.ticker)) ?? Number.MAX_SAFE_INTEGER;
  const secondTickerOrder = tickerOrderBySymbol.get(normalizeTickerSymbol(second.ticker)) ?? Number.MAX_SAFE_INTEGER;
  if (firstTickerOrder !== secondTickerOrder) {
    return firstTickerOrder - secondTickerOrder;
  }

  return normalizeTickerSymbol(first.ticker).localeCompare(normalizeTickerSymbol(second.ticker));
}

function getEarningsReminderWhenText(when: string): string {
  return earningsReminderWhenLabel.get(when) ?? "Zeitpunkt unbekannt";
}

export function getMatchedEarningsReminderEvents(
  earningsReminderAsset: EarningsReminderAsset,
  earningsEvents: EarningsEvent[],
): EarningsEvent[] {
  const normalizedTickerSymbols = getNormalizedEarningsReminderTickers(earningsReminderAsset);
  const tickerSymbols = new Set(normalizedTickerSymbols);
  const tickerOrderBySymbol = new Map<string, number>(normalizedTickerSymbols.map((tickerSymbol, index) => [tickerSymbol, index]));
  const matchedEvents: EarningsEvent[] = [];
  const seenEventKeys = new Set<string>();

  for (const earningsEvent of earningsEvents) {
    const normalizedTicker = normalizeTickerSymbol(earningsEvent.ticker);
    if (false === tickerSymbols.has(normalizedTicker)) {
      continue;
    }

    const eventKey = `${normalizedTicker}|${earningsEvent.when}`;
    if (true === seenEventKeys.has(eventKey)) {
      continue;
    }

    matchedEvents.push(earningsEvent);
    seenEventKeys.add(eventKey);
  }

  return matchedEvents.sort((first, second) => compareEarningsReminderEvents(first, second, tickerOrderBySymbol));
}

export function getEarningsReminderMessage(roleId: string, earningsEvents: EarningsEvent[]): string {
  const tickersByWhen = new Map<string, string[]>();

  for (const earningsEvent of earningsEvents) {
    const bucket = tickersByWhen.get(earningsEvent.when) ?? [];
    bucket.push(normalizeTickerSymbol(earningsEvent.ticker));
    tickersByWhen.set(earningsEvent.when, bucket);
  }

  const segments = [...tickersByWhen.entries()]
    .sort(([firstWhen], [secondWhen]) => (earningsReminderWhenSortRank.get(firstWhen) ?? Number.MAX_SAFE_INTEGER) - (earningsReminderWhenSortRank.get(secondWhen) ?? Number.MAX_SAFE_INTEGER))
    .map(([when, tickers]) => `${tickers.map(getDiscordMonospaceText).join(", ")} (${getEarningsReminderWhenText(when)})`);

  return `${getRoleMention(roleId)} Heute Earnings: ${segments.join("; ")}`;
}
