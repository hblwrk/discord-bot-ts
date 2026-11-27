import moment from "moment-timezone";
import type * as UsEquityMarketCalendarModule from "us-equity-market-calendar";
import {afterEach, describe, expect, test, vi} from "vitest";

const calendarOverrides = vi.hoisted(() => ({
  closedAfter: undefined as string | undefined,
  extraEarlyClose: undefined as string | undefined,
}));

// The real calendar drives every test; the overrides only reach branches the
// real calendar never produces (an exhausted lookahead, an early close that is
// followed by a trading day).
vi.mock("us-equity-market-calendar", async importOriginal => {
  const actual = await importOriginal<typeof UsEquityMarketCalendarModule>();
  return {
    ...actual,
    isEarlyClose: (date: string) => calendarOverrides.extraEarlyClose === date
      ? {closeTimeET: "13:00", date, name: "Test early close"}
      : actual.isEarlyClose(date),
    isHoliday: (date: string) => undefined !== calendarOverrides.closedAfter && date > calendarOverrides.closedAfter
      ? {date, kind: "special", name: "Test closure"}
      : actual.isHoliday(date),
  };
});

const {
  getNyseEveningCloseAnnouncement,
  getNyseEveningOpenAnnouncement,
  getNyseMorningNotice,
  getSessionTradeDate,
  isNyseTradingDay,
} = await import("./nyse-sessions.ts");

function usEastern(localTime: string): Date {
  return moment.tz(localTime, "US/Eastern").toDate();
}

describe("nyse-sessions", () => {
  afterEach(() => {
    calendarOverrides.closedAfter = undefined;
    calendarOverrides.extraEarlyClose = undefined;
  });

  test("evaluates trading days on the US/Eastern calendar day", () => {
    // Saturday 03:00 UTC is still Friday evening in US/Eastern.
    expect(isNyseTradingDay(moment.utc("2026-12-12T03:00:00Z"))).toBe(true);
    expect(isNyseTradingDay(moment.tz("2026-12-12T12:00:00", "US/Eastern"))).toBe(false);
    expect(isNyseTradingDay(moment.tz("2026-12-13T12:00:00", "US/Eastern"))).toBe(false);
    expect(isNyseTradingDay(moment.tz("2026-12-25T12:00:00", "US/Eastern"))).toBe(false);
  });

  test.each([
    ["trading day before the pause", "2026-12-07T19:59:00", "2026-12-07"],
    ["trading day at the pause", "2026-12-07T20:00:00", "2026-12-08"],
    ["Friday evening", "2026-12-11T21:00:00", "2026-12-14"],
    ["Saturday", "2026-12-12T12:00:00", "2026-12-14"],
    ["Sunday evening session", "2026-12-06T21:00:00", "2026-12-07"],
    ["holiday", "2026-12-25T10:00:00", "2026-12-28"],
    ["early-close day evening", "2026-12-24T20:00:00", "2026-12-28"],
  ])("maps the session trade date: %s", (_label, localTime, expectedTradeDate) => {
    expect(getSessionTradeDate(usEastern(localTime))).toBe(expectedTradeDate);
  });

  test("returns no trade date when no trading day follows within the lookahead", () => {
    calendarOverrides.closedAfter = "2026-12-07";

    expect(getSessionTradeDate(usEastern("2026-12-07T20:00:00"))).toBeUndefined();
  });

  test.each([
    ["holiday", "2026-12-25T04:00:00", "Heute bleibt die Börse geschlossen"],
    ["early close", "2026-12-24T04:00:00", "Heute ist ein verkürzter Handelstag - die Börse macht schon um 19:00 zu!"],
    ["day after Thanksgiving", "2026-11-27T04:00:00", "Tag nach dem Truthahn-Tag, also beeilt euch - die Börse macht schon um 19:00 zu!"],
  ])("sends a morning notice on a %s", (_label, localTime, expectedText) => {
    expect(getNyseMorningNotice(usEastern(localTime))).toContain(expectedText);
  });

  test("stays silent in the morning of a regular trading day", () => {
    expect(getNyseMorningNotice(usEastern("2026-12-08T04:00:00"))).toBeUndefined();
  });

  test.each([
    [
      "pause on a regular trading day",
      "2026-12-07T20:00:00",
      "☕🔔 Verschnaufpause, liebe Hebelhelden! Der US-Aktienhandel pausiert jetzt für eine Stunde und geht um 21:00 US/Eastern / 03:00 Europe/Berlin weiter. 🔔☕",
    ],
    [
      "pause while US and EU daylight saving times differ",
      "2026-03-16T20:00:00",
      "☕🔔 Verschnaufpause, liebe Hebelhelden! Der US-Aktienhandel pausiert jetzt für eine Stunde und geht um 21:00 US/Eastern / 02:00 Europe/Berlin weiter. 🔔☕",
    ],
    [
      "weekly close on Friday",
      "2026-12-11T20:00:00",
      "🍻🔔🔔 Feierabend und schönes Wochenende, liebe Hebelhelden! Der US-Aktienhandel ist jetzt geschlossen und öffnet wieder am Sonntag um 21:00 US/Eastern (Montag, 03:00 Europe/Berlin). 🔔🔔🍻",
    ],
    [
      "weekly close before a Monday holiday",
      "2027-01-15T20:00:00",
      "🍻🔔🔔 Feierabend und schönes Wochenende, liebe Hebelhelden! Der US-Aktienhandel ist jetzt geschlossen und öffnet wieder am Montag um 21:00 US/Eastern (Dienstag, 03:00 Europe/Berlin). 🔔🔔🍻",
    ],
    [
      "close before a holiday",
      "2026-11-25T20:00:00",
      "🛏️🔔🔔 Und jetzt ist der US-Aktienhandel für euch Nachteulen geschlossen, Zeit fürs Bettchen! Weiter geht's am Donnerstag um 21:00 US/Eastern (Freitag, 03:00 Europe/Berlin). 🔔🔔🛏️",
    ],
    [
      "close before a holiday that joins the weekend",
      "2026-12-31T20:00:00",
      "🛏️🔔🔔 Und jetzt ist der US-Aktienhandel für euch Nachteulen geschlossen, Zeit fürs Bettchen! Weiter geht's am Sonntag um 21:00 US/Eastern (Montag, 03:00 Europe/Berlin). 🔔🔔🛏️",
    ],
  ])("announces the evening %s", (_label, localTime, expectedAnnouncement) => {
    expect(getNyseEveningCloseAnnouncement(usEastern(localTime))).toBe(expectedAnnouncement);
  });

  test.each([
    ["holiday", "2026-12-25T20:00:00"],
    ["early-close day", "2026-12-24T20:00:00"],
  ])("stays silent at the evening close on a %s", (_label, localTime) => {
    expect(getNyseEveningCloseAnnouncement(usEastern(localTime))).toBeUndefined();
  });

  test("stays silent at the evening close when no trading day follows within the lookahead", () => {
    calendarOverrides.closedAfter = "2026-12-07";

    expect(getNyseEveningCloseAnnouncement(usEastern("2026-12-07T20:00:00"))).toBeUndefined();
  });

  test.each([
    [
      "resume after the pause",
      "2026-12-08T21:00:00",
      "🔔🚀 Pause vorbei, weiter geht's! Die Overnight-Session für den Handelstag Mittwoch, 9. Dezember ist offen. 🚀🔔",
    ],
    [
      "week start on Sunday",
      "2026-12-06T21:00:00",
      "🌃🔔 Die neue Handelswoche startet, liebe Hebelhelden! Die Overnight-Session für den Handelstag Montag, 7. Dezember ist offen. 🔔🌃",
    ],
    [
      "week start after a Monday holiday",
      "2027-01-18T21:00:00",
      "🌃🔔 Die neue Handelswoche startet, liebe Hebelhelden! Die Overnight-Session für den Handelstag Dienstag, 19. Januar ist offen. 🔔🌃",
    ],
    [
      "return after a midweek holiday",
      "2026-11-26T21:00:00",
      "🌃🔔 Die Börse ist zurück, liebe Hebelhelden! Die Overnight-Session für den Handelstag Freitag, 27. November ist offen. 🔔🌃",
    ],
  ])("announces the evening %s", (_label, localTime, expectedAnnouncement) => {
    expect(getNyseEveningOpenAnnouncement(usEastern(localTime))).toBe(expectedAnnouncement);
  });

  test("does not claim a pause ended after an early close", () => {
    calendarOverrides.extraEarlyClose = "2026-12-08";

    expect(getNyseEveningOpenAnnouncement(usEastern("2026-12-08T21:00:00"))).toBe(
      "🌃🔔 Die Börse ist zurück, liebe Hebelhelden! Die Overnight-Session für den Handelstag Mittwoch, 9. Dezember ist offen. 🔔🌃",
    );
  });

  test.each([
    ["Sunday before a Monday holiday", "2027-01-17T21:00:00"],
    ["Friday evening", "2026-12-11T21:00:00"],
    ["evening before a holiday", "2026-12-24T21:00:00"],
  ])("stays silent at the evening open on a %s", (_label, localTime) => {
    expect(getNyseEveningOpenAnnouncement(usEastern(localTime))).toBeUndefined();
  });

  test("stays silent at the evening open when no trading day follows within the lookahead", () => {
    calendarOverrides.closedAfter = "2026-12-07";

    expect(getNyseEveningOpenAnnouncement(usEastern("2026-12-07T21:00:00"))).toBeUndefined();
  });
});
