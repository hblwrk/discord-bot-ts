import {describe, expect, test} from "vitest";
import {CalendarReminderAsset, EarningsReminderAsset} from "./assets.ts";
import {CalendarEvent} from "./calendar.ts";
import type {EarningsEvent} from "./earnings-types.ts";
import {
  buildCalendarReminderEmbed,
  compareCalendarMetric,
  getAllowedRoleMentions,
  getCalendarReminderContent,
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

    const reminderEmbed = buildCalendarReminderEmbed("reminder", usGroup?.events ?? []);
    expect(getCalendarReminderContent("role-1", "reminder")).toBe("<@&role-1> Heute wichtig");
    expect(reminderEmbed.data.title).toBe("🇺🇸 ISM Manufacturing PMI");
    expect(reminderEmbed.data.description).toBe("**ISM Manufacturing PMI**\n**ISM Manufacturing PMI Final**");
    expect(reminderEmbed.data.footer?.text).toBe("🕒 14:30");
    expect(reminderEmbed.data.color).toBe(0x0099ff);

    const emptyEmbed = buildCalendarReminderEmbed("reminder", []);
    expect(emptyEmbed.data.title).toBe("Wirtschaftsdaten");
    expect(emptyEmbed.data.description).toBeUndefined();
    expect(emptyEmbed.data.footer).toBeUndefined();
  });

  test("compares actual versus forecast with neutral direction arrows", () => {
    expect(compareCalendarMetric("4.2%", "4.0%")).toBe("▲");
    expect(compareCalendarMetric("3.0%", "3.2%")).toBe("▼");
    expect(compareCalendarMetric("0.5%", "0.5%")).toBe("=");
    expect(compareCalendarMetric("333,979", "333,233")).toBe("▲");
    expect(compareCalendarMetric("n/a", "1.0")).toBe("");
    expect(compareCalendarMetric("1.0", "")).toBe("");
  });

  test("renders the update embed with actual, forecast and previous values", () => {
    const event = createCalendarEvent({
      actualValue: "3.4%",
      forecastValue: "3.2%",
      previousValue: "3.1%",
      name: "Consumer Price Index (CPI) y/y",
    });

    expect(hasCalendarReminderActualValues([event])).toBe(true);
    expect(hasCalendarReminderClearMetrics([event])).toBe(true);

    const updateEmbed = buildCalendarReminderEmbed("update", [event]);
    expect(getCalendarReminderContent("role-1", "update")).toBe("<@&role-1> Update");
    expect(updateEmbed.data.title).toBe("🇺🇸 Consumer Price Index (CPI) y/y");
    expect(updateEmbed.data.description).toBe("**Consumer Price Index (CPI) y/y** — `3.4%` ▲ exp. `3.2%` · prev. `3.1%`");
    expect(updateEmbed.data.footer?.text).toBe("🕒 14:30");
  });

  test("renders forecast-only and actual-only embed lines", () => {
    const forecastOnly = createCalendarEvent({
      forecastValue: "3.2%",
      previousValue: "3.1%",
      name: "Consumer Price Index (CPI) y/y",
    });
    expect(buildCalendarReminderEmbed("reminder", [forecastOnly]).data.description).toBe(
      "**Consumer Price Index (CPI) y/y** — exp. `3.2%` · prev. `3.1%`",
    );

    const actualOnly = createCalendarEvent({
      actualValue: "3.4%",
      name: "Consumer Price Index (CPI) y/y",
    });
    expect(buildCalendarReminderEmbed("update", [actualOnly]).data.description).toBe(
      "**Consumer Price Index (CPI) y/y** — actual `3.4%`",
    );
  });

  test("renders the summary embed for events without clear metrics", () => {
    const event = createCalendarEvent({
      name: "FOMC Statement",
    });

    expect(hasCalendarReminderActualValues([event])).toBe(false);
    expect(hasCalendarReminderClearMetrics([event])).toBe(false);

    const summaryEmbed = buildCalendarReminderEmbed("summary", [event], {
      sourceName: "Federal Reserve",
      summaryMarkdown: "Policy remains data dependent.",
    });
    expect(getCalendarReminderContent("role-1", "summary")).toBe("<@&role-1> Update");
    expect(summaryEmbed.data.title).toBe("🇺🇸 FOMC Statement");
    expect(summaryEmbed.data.description).toBe("**FOMC Statement**\n\nPolicy remains data dependent.");
    expect(summaryEmbed.data.footer?.text).toBe("🕒 14:30 · Quelle: Federal Reserve");
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
