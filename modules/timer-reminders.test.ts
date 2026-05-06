import {describe, expect, test} from "vitest";
import {CalendarReminderAsset, EarningsReminderAsset} from "./assets.ts";
import {CalendarEvent} from "./calendar.ts";
import type {EarningsEvent} from "./earnings-types.ts";
import {
  getAllowedRoleMentions,
  getCalendarReminderMessage,
  getCalendarReminderSummaryMessage,
  getCalendarReminderUpdateMessage,
  getEarningsReminderMessage,
  getMatchedCalendarReminderEventGroups,
  getMatchedEarningsReminderEvents,
  getNormalizedRoleId,
  hasCalendarReminderActualValues,
  hasCalendarReminderClearMetrics,
} from "./timer-reminders.ts";

function createCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const event = new CalendarEvent();
  event.date = "2026-05-04";
  event.time = "14:30";
  event.country = "🇺🇸";
  event.name = "ISM Manufacturing PMI";
  Object.assign(event, overrides);
  return event;
}

function createCalendarReminderAsset(overrides: Partial<CalendarReminderAsset> = {}): CalendarReminderAsset {
  const asset = new CalendarReminderAsset();
  asset.name = "macro";
  asset.roleId = "role-1";
  asset.eventNameSubstrings = [" PMI ", "", "ignored"];
  asset.countryFlags = ["🇺🇸", ""];
  Object.assign(asset, overrides);
  return asset;
}

function createEarningsReminderAsset(overrides: Partial<EarningsReminderAsset> = {}): EarningsReminderAsset {
  const asset = new EarningsReminderAsset();
  asset.roleId = "role-earnings";
  asset.tickerSymbols = ["BRK/B", "AAPL", "", "msft"];
  Object.assign(asset, overrides);
  return asset;
}

function createEarningsEvent(overrides: Partial<EarningsEvent> = {}): EarningsEvent {
  return {
    date: "2026-05-04",
    importance: 1,
    ticker: "AAPL",
    when: "before_open",
    ...overrides,
  };
}

describe("timer-reminders", () => {
  test("formats role mentions and normalizes role ids", () => {
    expect(getAllowedRoleMentions("role-1")).toEqual({
      parse: [],
      roles: ["role-1"],
    });
    expect(getNormalizedRoleId(" role-1 ")).toBe("role-1");
    expect(getNormalizedRoleId(" ")).toBeUndefined();
    expect(getNormalizedRoleId(undefined)).toBeUndefined();
  });

  test("groups matching calendar reminder events and skips invalid assets", () => {
    const matchingEvent = createCalendarEvent();
    const duplicateKeyEvent = createCalendarEvent({
      name: "ISM Manufacturing PMI Final",
    });
    const wrongCountryEvent = createCalendarEvent({
      country: "🇪🇺",
      name: "Eurozone PMI",
    });
    const groups = getMatchedCalendarReminderEventGroups([
      createCalendarReminderAsset(),
      createCalendarReminderAsset({roleId: " "}),
      createCalendarReminderAsset({eventNameSubstrings: []}),
      createCalendarReminderAsset({countryFlags: ["🇪🇺"]}),
    ], [
      matchingEvent,
      duplicateKeyEvent,
      wrongCountryEvent,
    ]);

    expect(groups).toHaveLength(2);
    const usGroup = groups.find(group => "🇺🇸" === group.events[0]?.country);
    expect(usGroup?.events).toHaveLength(2);
    expect(getCalendarReminderMessage("role-1", usGroup?.events ?? [])).toBe(
      "<@&role-1> Heute wichtig: `14:30` 🇺🇸 ISM Manufacturing PMI, ISM Manufacturing PMI Final",
    );
    expect(getCalendarReminderMessage("role-1", [])).toBe("<@&role-1> Heute wichtig:");
  });

  test("formats calendar reminders with expected actual and previous values", () => {
    const event = createCalendarEvent({
      actualValue: "3.4%",
      forecastValue: "3.2%",
      previousValue: "3.1%",
      name: "Consumer Price Index (CPI) y/y",
    });

    expect(hasCalendarReminderActualValues([event])).toBe(true);
    expect(hasCalendarReminderClearMetrics([event])).toBe(true);
    expect(getCalendarReminderMessage("role-1", [event])).toBe(
      "<@&role-1> Heute wichtig: `14:30` 🇺🇸 Consumer Price Index (CPI) y/y: actual `3.4%`, exp. `3.2%`, prev. `3.1%`",
    );
    expect(getCalendarReminderUpdateMessage("role-1", [event])).toBe(
      "<@&role-1> Update: `14:30` 🇺🇸 Consumer Price Index (CPI) y/y: actual `3.4%`, exp. `3.2%`, prev. `3.1%`",
    );
  });

  test("formats calendar reminder summaries for events without clear metrics", () => {
    const event = createCalendarEvent({
      name: "FOMC Statement",
    });

    expect(hasCalendarReminderActualValues([event])).toBe(false);
    expect(hasCalendarReminderClearMetrics([event])).toBe(false);
    expect(getCalendarReminderSummaryMessage("role-1", [event], "Federal Reserve", "Policy remains data dependent.")).toBe(
      "<@&role-1> Update: `14:30` 🇺🇸 FOMC Statement\nSource: Federal Reserve\nPolicy remains data dependent.",
    );
  });

  test("matches earnings reminder tickers, removes duplicates and formats by time bucket", () => {
    const asset = createEarningsReminderAsset();
    const matchedEvents = getMatchedEarningsReminderEvents(asset, [
      createEarningsEvent({ticker: "MSFT", when: "after_close"}),
      createEarningsEvent({ticker: "BRK-B", when: "during_session"}),
      createEarningsEvent({ticker: "AAPL", when: "before_open"}),
      createEarningsEvent({ticker: "AAPL", when: "before_open", importance: 2}),
      createEarningsEvent({ticker: "TSLA", when: "after_close"}),
    ]);

    expect(matchedEvents.map(event => `${event.ticker}:${event.when}`)).toEqual([
      "AAPL:before_open",
      "BRK-B:during_session",
      "MSFT:after_close",
    ]);
    expect(getEarningsReminderMessage("role-earnings", matchedEvents)).toBe(
      "<@&role-earnings> Heute Earnings: `AAPL` (vor Handelsbeginn); `BRK.B` (während der Handelszeiten); `MSFT` (nach Handelsschluss)",
    );
    expect(getMatchedEarningsReminderEvents(createEarningsReminderAsset({tickerSymbols: []}), matchedEvents)).toEqual([]);
  });
});
