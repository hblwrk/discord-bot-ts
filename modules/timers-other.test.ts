import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {
  createClientWithChannel,
  getAssetByNameMock,
  getCalendarEventsMock,
  getCalendarMessagesMock,
  getEarningsMessagesMock,
  getEarningsReminderJob,
  getEarningsResultMock,
  getScheduledJobByTime,
  isHolidayMock,
  loggerMock,
  type MockRecurrenceRule,
  type MockRange,
  resetTimerMocks,
  restoreTimerMocks,
  scheduleJobMock,
  scheduledJobs,
  startOtherTimers,
} from "./test-utils/timers.ts";

describe("timers: other announcements", () => {
  beforeEach(resetTimerMocks);
  afterEach(restoreTimerMocks);

  test("startOtherTimers schedules all other jobs and sends Friday asset", async () => {
    const {client, send} = createClientWithChannel();
    const assets = [{name: "freitag"}];

    startOtherTimers(client, "channel-id", assets, []);
    const fridayJob = getScheduledJobByTime(8, 0, "Europe/Berlin");
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    const weeklyEarningsJob = getScheduledJobByTime(23, 30, "Europe/Berlin");
    const earningsReminderJob = scheduledJobs.find(job =>
      false === (job.rule instanceof Date) &&
      8 === job.rule.hour &&
      0 === job.rule.minute &&
      "Europe/Berlin" === job.rule.tz &&
      Array.isArray(job.rule.dayOfWeek) &&
      1 === (job.rule.dayOfWeek[0] as MockRange).start &&
      5 === (job.rule.dayOfWeek[0] as MockRange).end);
    const weeklyCalendarJob = getScheduledJobByTime(23, 45, "Europe/Berlin");

    expect(scheduleJobMock).toHaveBeenCalledTimes(6);
    expect(fridayJob.rule).toEqual(expect.objectContaining({
      hour: 8,
      minute: 0,
      tz: "Europe/Berlin",
    }));
    expect(dailyEarningsJob.rule.dayOfWeek).toEqual([expect.objectContaining({start: 0, end: 6})]);
    expect(weeklyEarningsJob.rule).toEqual(expect.objectContaining({
      hour: 23,
      minute: 30,
      tz: "Europe/Berlin",
    }));
    expect(earningsReminderJob?.rule).toEqual(expect.objectContaining({
      hour: 8,
      minute: 0,
      tz: "Europe/Berlin",
    }));
    expect((earningsReminderJob?.rule as MockRecurrenceRule).dayOfWeek).toEqual([expect.objectContaining({start: 1, end: 5})]);
    expect(weeklyEarningsJob.rule.dayOfWeek).toEqual([5]);
    expect(weeklyCalendarJob.rule).toEqual(expect.objectContaining({
      hour: 23,
      minute: 45,
      tz: "Europe/Berlin",
    }));
    expect(weeklyCalendarJob.rule.dayOfWeek).toEqual([5]);
    expect(`${weeklyCalendarJob.rule.hour}:${weeklyCalendarJob.rule.minute}`).not.toBe(
      `${weeklyEarningsJob.rule.hour}:${weeklyEarningsJob.rule.minute}`,
    );

    await fridayJob.callback();

    expect(getAssetByNameMock).toHaveBeenCalledWith("freitag", assets);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      files: expect.any(Array),
    }));
  });

  test("startOtherTimers sends calendar reminders after the daily calendar post", async () => {
    const {client, send} = createClientWithChannel();
    getCalendarEventsMock.mockResolvedValue([
      {
        date: "2025-02-19",
        time: "14:30",
        country: "🇺🇸",
        name: "Consumer Price Index (CPI)",
      },
    ]);

    startOtherTimers(client, "channel-id", [], [], [{
      name: "us-cpi-1h",
      eventNameSubstrings: ["consumer price index", "cpi"],
      countryFlags: ["🇺🇸"],
      roleId: "role-123",
      minutesBefore: 60,
    }] as any, []);
    const dailyCalendarJob = getScheduledJobByTime(8, 30, "Europe/Berlin");
    await dailyCalendarJob.callback();

    expect(send).toHaveBeenNthCalledWith(1, {
      content: "calendar-text",
      allowedMentions: {
        parse: [],
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      content: "<@&role-123> Heute wichtig: `14:30` 🇺🇸 Consumer Price Index (CPI)",
      allowedMentions: {
        parse: [],
        roles: ["role-123"],
      },
    });
  });

  test("startOtherTimers bundles same-minute calendar reminder matches into one reminder", async () => {
    const {client, send} = createClientWithChannel();
    getCalendarEventsMock.mockResolvedValue([
      {
        date: "2025-02-19",
        time: "14:30",
        country: "🇺🇸",
        name: "CPI y/y",
      },
      {
        date: "2025-02-19",
        time: "14:30",
        country: "🇺🇸",
        name: "Core CPI y/y",
      },
      {
        date: "2025-02-19",
        time: "14:30",
        country: "🇺🇸",
        name: "CPI m/m",
      },
    ]);

    startOtherTimers(client, "channel-id", [], [], [{
      name: "us-cpi-1h",
      eventNameSubstrings: ["cpi"],
      countryFlags: ["🇺🇸"],
      roleId: "role-123",
      minutesBefore: 60,
    }] as any, []);
    const dailyCalendarJob = getScheduledJobByTime(8, 30, "Europe/Berlin");
    await dailyCalendarJob.callback();

    expect(send).toHaveBeenNthCalledWith(2, {
      content: "<@&role-123> Heute wichtig: `14:30` 🇺🇸 CPI y/y, Core CPI y/y, CPI m/m",
      allowedMentions: {
        parse: [],
        roles: ["role-123"],
      },
    });
  });

  test("startOtherTimers skips calendar reminder assets with wrong country or invalid config", async () => {
    const {client, send} = createClientWithChannel();
    getCalendarEventsMock.mockResolvedValue([
      {
        date: "2025-02-19",
        time: "14:30",
        country: "🇪🇺",
        name: "Consumer Price Index (CPI)",
      },
    ]);

    startOtherTimers(client, "channel-id", [], [], [
      {
        name: "wrong-country",
        eventNameSubstrings: ["cpi"],
        countryFlags: ["🇺🇸"],
        roleId: "role-123",
        minutesBefore: 60,
      },
      {
        name: "missing-role",
        eventNameSubstrings: ["cpi"],
        countryFlags: ["🇪🇺"],
        roleId: "   ",
        minutesBefore: 60,
      },
      {
        name: "missing-matchers",
        eventNameSubstrings: [],
        countryFlags: ["🇪🇺"],
        roleId: "role-123",
        minutesBefore: 60,
      },
    ] as any, []);
    const dailyCalendarJob = getScheduledJobByTime(8, 30, "Europe/Berlin");
    await dailyCalendarJob.callback();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: "calendar-text",
      allowedMentions: {
        parse: [],
      },
    });
  });

  test("startOtherTimers sends multiple calendar reminder groups in event-time order after the daily calendar post", async () => {
    const {client, send} = createClientWithChannel();
    getCalendarEventsMock.mockResolvedValue([
      {
        date: "2025-02-19",
        time: "14:30",
        country: "🇺🇸",
        name: "GDP q/q",
      },
      {
        date: "2025-02-19",
        time: "20:00",
        country: "🇺🇸",
        name: "FOMC Statement",
      },
    ]);

    startOtherTimers(client, "channel-id", [], [], [
      {
        name: "us-gdp-1h",
        eventNameSubstrings: ["gdp q/q"],
        countryFlags: ["🇺🇸"],
        roleId: "role-123",
      },
      {
        name: "us-fomc-statement-1h",
        eventNameSubstrings: ["fomc statement"],
        countryFlags: ["🇺🇸"],
        roleId: "role-123",
      },
    ] as any, []);
    const dailyCalendarJob = getScheduledJobByTime(8, 30, "Europe/Berlin");
    await dailyCalendarJob.callback();

    expect(send).toHaveBeenNthCalledWith(2, {
      content: "<@&role-123> Heute wichtig: `14:30` 🇺🇸 GDP q/q",
      allowedMentions: {
        parse: [],
        roles: ["role-123"],
      },
    });
    expect(send).toHaveBeenNthCalledWith(3, {
      content: "<@&role-123> Heute wichtig: `20:00` 🇺🇸 FOMC Statement",
      allowedMentions: {
        parse: [],
        roles: ["role-123"],
      },
    });
  });

  test("startOtherTimers skips Friday announcement when asset is unavailable", async () => {
    const {client, send} = createClientWithChannel();
    getAssetByNameMock.mockReturnValue(undefined);

    startOtherTimers(client, "channel-id", [], []);
    const fridayJob = getScheduledJobByTime(8, 0, "Europe/Berlin");
    await fridayJob.callback();

    expect(send).not.toHaveBeenCalled();
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Skipping friday announcement"),
    );
  });

  test("startOtherTimers skips Friday announcement when asset is missing", async () => {
    const {client, send} = createClientWithChannel();
    getAssetByNameMock.mockReturnValueOnce(undefined);

    startOtherTimers(client, "channel-id", [], []);
    const fridayJob = getScheduledJobByTime(8, 0, "Europe/Berlin");
    await fridayJob.callback();

    expect(send).not.toHaveBeenCalled();
    expect(loggerMock.log).toHaveBeenCalledWith("warn", "Skipping friday announcement: asset missing or incomplete.");
  });

  test("startOtherTimers does not send earnings message when formatter returns none", async () => {
    const {client, send} = createClientWithChannel();
    getEarningsMessagesMock.mockReturnValue({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
    });

    startOtherTimers(client, "channel-id", [], []);
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    await dailyEarningsJob.callback();

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "tomorrow");
    expect(send).not.toHaveBeenCalled();
  });

  test("startOtherTimers skips earnings timer when next US/Eastern day is a weekend", async () => {
    const {client, send} = createClientWithChannel();
    vi.setSystemTime(new Date("2025-02-21T19:30:00+01:00"));

    startOtherTimers(client, "channel-id", [], []);
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    await dailyEarningsJob.callback();

    expect(getEarningsResultMock).not.toHaveBeenCalled();
    expect(getEarningsMessagesMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(loggerMock.log).toHaveBeenCalledWith("info", expect.objectContaining({
      source: "timer-earnings",
      message: expect.stringContaining("not a trading day"),
    }));
  });

  test("startOtherTimers skips earnings timer when next US/Eastern day is a holiday", async () => {
    const {client, send} = createClientWithChannel();
    vi.setSystemTime(new Date("2025-07-03T19:30:00+02:00"));
    isHolidayMock.mockImplementation(date => date.toDateString() === "Fri Jul 04 2025");

    startOtherTimers(client, "channel-id", [], []);
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    await dailyEarningsJob.callback();

    expect(isHolidayMock).toHaveBeenCalledWith(expect.any(Date));
    expect(getEarningsResultMock).not.toHaveBeenCalled();
    expect(getEarningsMessagesMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(loggerMock.log).toHaveBeenCalledWith("info", expect.objectContaining({
      source: "timer-earnings",
      message: expect.stringContaining("not a trading day"),
    }));
  });

  test("startOtherTimers sends earnings on Sunday evening for Monday trading day", async () => {
    const {client, send} = createClientWithChannel();
    vi.setSystemTime(new Date("2025-02-23T19:30:00+01:00"));

    startOtherTimers(client, "channel-id", [], []);
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    await dailyEarningsJob.callback();

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "tomorrow");
    expect(getEarningsMessagesMock).toHaveBeenCalledWith([], "all", [], {
      maxMessageLength: 1800,
      maxMessages: 8,
      marketCapFilter: "bluechips",
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: "earnings-text",
      allowedMentions: {
        parse: [],
      },
    }));
  });

  test("startOtherTimers sends chunked earnings messages in order with mention restrictions", async () => {
    const {client, send} = createClientWithChannel();
    getEarningsMessagesMock.mockReturnValue({
      messages: ["earnings-1", "earnings-2", "earnings-3"],
      truncated: false,
      totalEvents: 9,
      includedEvents: 9,
    });

    startOtherTimers(client, "channel-id", [], []);
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    await dailyEarningsJob.callback();

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "tomorrow");
    expect(send).toHaveBeenNthCalledWith(1, {
      content: "earnings-1",
      allowedMentions: {
        parse: [],
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      content: "earnings-2",
      allowedMentions: {
        parse: [],
      },
    });
    expect(send).toHaveBeenNthCalledWith(3, {
      content: "earnings-3",
      allowedMentions: {
        parse: [],
      },
    });
  });

  test("startOtherTimers sends weekly earnings with dedicated headline on Friday evening", async () => {
    const {client, send} = createClientWithChannel();
    getEarningsMessagesMock.mockReturnValue({
      messages: ["weekly-earnings-1", "weekly-earnings-2"],
      truncated: false,
      totalEvents: 10,
      includedEvents: 10,
    });

    startOtherTimers(client, "channel-id", [], []);
    const weeklyEarningsJob = getScheduledJobByTime(23, 30, "Europe/Berlin");
    await weeklyEarningsJob.callback();

    expect(getEarningsResultMock).toHaveBeenCalledWith(5, "tomorrow");
    expect(getEarningsMessagesMock).toHaveBeenCalledWith([], "all", [], {
      maxMessageLength: 1800,
      maxMessages: 8,
      marketCapFilter: "bluechips",
    });
    expect(send).toHaveBeenNthCalledWith(1, {
      content: "📅 **Earnings der nächsten Handelswoche:**\n\nweekly-earnings-1",
      allowedMentions: {
        parse: [],
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      content: "weekly-earnings-2",
      allowedMentions: {
        parse: [],
      },
    });
  });

  test("startOtherTimers sends weekday earnings reminders with role-limited mentions", async () => {
    const {client, send} = createClientWithChannel();
    getEarningsResultMock.mockResolvedValue({
      events: [
        {
          ticker: "NVDA",
          when: "after_close",
          date: "2025-02-18",
          importance: 1,
        },
        {
          ticker: "MSFT",
          when: "after_close",
          date: "2025-02-18",
          importance: 1,
        },
      ],
      status: "ok",
    });

    startOtherTimers(client, "channel-id", [], [], [], [{
      name: "big-tech-earnings",
      tickerSymbols: ["NVDA", "MSFT"],
      roleId: "role-456",
    }] as any);
    await getEarningsReminderJob().callback();

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "today");
    expect(send).toHaveBeenCalledWith({
      content: "<@&role-456> Heute Earnings: `NVDA`, `MSFT` (nach Handelsschluss)",
      allowedMentions: {
        parse: [],
        roles: ["role-456"],
      },
    });
  });

  test("startOtherTimers normalizes and deduplicates earnings reminder tickers and skips non-matching assets", async () => {
    const {client, send} = createClientWithChannel();
    getEarningsResultMock.mockResolvedValue({
      events: [
        {
          ticker: "nvda",
          when: "after_close",
          date: "2025-02-18",
          importance: 1,
        },
        {
          ticker: "NVDA",
          when: "after_close",
          date: "2025-02-18",
          importance: 1,
        },
        {
          ticker: " MSFT ",
          when: "after_close",
          date: "2025-02-18",
          importance: 1,
        },
      ],
      status: "ok",
    });

    startOtherTimers(client, "channel-id", [], [], [], [
      {
        name: "big-tech-earnings",
        tickerSymbols: [" nvda ", "msft"],
        roleId: "role-456",
      },
      {
        name: "no-match",
        tickerSymbols: ["AAPL"],
        roleId: "role-789",
      },
    ] as any);
    await getEarningsReminderJob().callback();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: "<@&role-456> Heute Earnings: `NVDA`, `MSFT` (nach Handelsschluss)",
      allowedMentions: {
        parse: [],
        roles: ["role-456"],
      },
    });
  });

  test("startOtherTimers matches class-share earnings reminder tickers across punctuation variants", async () => {
    const {client, send} = createClientWithChannel();
    getEarningsResultMock.mockResolvedValue({
      events: [
        {
          ticker: "BRK/B",
          when: "after_close",
          date: "2025-02-18",
          importance: 1,
        },
        {
          ticker: "BRK-B",
          when: "after_close",
          date: "2025-02-18",
          importance: 1,
        },
      ],
      status: "ok",
    });

    startOtherTimers(client, "channel-id", [], [], [], [{
      name: "berkshire-earnings",
      tickerSymbols: ["BRK.B"],
      roleId: "role-456",
    }] as any);
    await getEarningsReminderJob().callback();

    expect(send).toHaveBeenCalledWith({
      content: "<@&role-456> Heute Earnings: `BRK.B` (nach Handelsschluss)",
      allowedMentions: {
        parse: [],
        roles: ["role-456"],
      },
    });
  });

  test("startOtherTimers skips earnings reminder assets with blank role IDs", async () => {
    const {client, send} = createClientWithChannel();
    getEarningsResultMock.mockResolvedValue({
      events: [
        {
          ticker: "AAPL",
          when: "after_close",
          date: "2025-02-18",
          importance: 1,
        },
      ],
      status: "ok",
    });

    startOtherTimers(client, "channel-id", [], [], [], [{
      name: "aapl-earnings",
      tickerSymbols: ["AAPL"],
      roleId: "   ",
    }] as any);
    await getEarningsReminderJob().callback();

    expect(send).not.toHaveBeenCalled();
  });

  test("startOtherTimers skips earnings reminder sends when loading earnings fails", async () => {
    const {client, send} = createClientWithChannel();
    getEarningsResultMock.mockResolvedValue({
      events: [],
      status: "error",
    });

    startOtherTimers(client, "channel-id", [], [], [], [{
      name: "aapl-earnings",
      tickerSymbols: ["AAPL"],
      roleId: "role-456",
    }] as any);
    await getEarningsReminderJob().callback();

    expect(send).not.toHaveBeenCalled();
    expect(loggerMock.log).toHaveBeenCalledWith("warn", expect.objectContaining({
      source: "earnings-reminder",
      status: "error",
      message: "Earnings-Erinnerungen konnten nicht geladen werden.",
    }));
  });

  test("startOtherTimers sends chunked daily calendar messages in order with mention restrictions", async () => {
    const {client, send} = createClientWithChannel();
    getCalendarMessagesMock.mockReturnValueOnce({
      messages: ["day-1", "day-2", "day-3"],
      truncated: false,
      totalEvents: 7,
      includedEvents: 7,
      totalDays: 3,
      includedDays: 3,
    });

    startOtherTimers(client, "channel-id", [], []);
    const dailyCalendarJob = getScheduledJobByTime(8, 30, "Europe/Berlin");
    await dailyCalendarJob.callback();

    expect(getCalendarEventsMock).toHaveBeenCalledWith("", 0);
    expect(send).toHaveBeenNthCalledWith(1, {
      content: "day-1",
      allowedMentions: {
        parse: [],
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      content: "day-2",
      allowedMentions: {
        parse: [],
      },
    });
    expect(send).toHaveBeenNthCalledWith(3, {
      content: "day-3",
      allowedMentions: {
        parse: [],
      },
    });
  });

  test("startOtherTimers sends weekly calendar chunks and deduplicates overlapping events before formatting", async () => {
    const {client, send} = createClientWithChannel();
    getCalendarEventsMock
      .mockResolvedValueOnce([
        {date: "2025-02-24", time: "10:00", country: "🇺🇸", name: "Event A"},
        {date: "2025-02-25", time: "11:00", country: "🇺🇸", name: "Event B"},
      ])
      .mockResolvedValueOnce([
        {date: "2025-02-25", time: "11:00", country: "🇺🇸", name: "Event B"},
        {date: "2025-02-26", time: "12:00", country: "🇺🇸", name: "Event C"},
      ]);
    getCalendarMessagesMock.mockReturnValueOnce({
      messages: ["week-1", "week-2"],
      truncated: false,
      totalEvents: 3,
      includedEvents: 3,
      totalDays: 3,
      includedDays: 3,
    });

    startOtherTimers(client, "channel-id", [], []);
    const weeklyCalendarJob = getScheduledJobByTime(23, 45, "Europe/Berlin");
    await weeklyCalendarJob.callback();

    expect(getCalendarEventsMock).toHaveBeenNthCalledWith(1, "2025-02-24", 2);
    expect(getCalendarEventsMock).toHaveBeenNthCalledWith(2, "2025-02-27", 1);
    expect(getCalendarMessagesMock).toHaveBeenCalledWith([
      {date: "2025-02-24", time: "10:00", country: "🇺🇸", name: "Event A"},
      {date: "2025-02-25", time: "11:00", country: "🇺🇸", name: "Event B"},
      {date: "2025-02-26", time: "12:00", country: "🇺🇸", name: "Event C"},
    ], expect.objectContaining({
      maxMessageLength: 1800,
      maxMessages: 8,
      keepDayTogether: true,
      title: "📅 **Wichtige Termine der nächsten Handelswoche:**",
    }));
    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      content: "week-1",
      allowedMentions: {
        parse: [],
      },
    }));
    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      content: "week-2",
      allowedMentions: {
        parse: [],
      },
    }));
  });

  test("startOtherTimers logs warning when calendar output is truncated and sends bounded output", async () => {
    const {client, send} = createClientWithChannel();
    getCalendarMessagesMock.mockReturnValueOnce({
      messages: ["truncated-chunk-1", "truncated-chunk-2"],
      truncated: true,
      totalEvents: 40,
      includedEvents: 20,
      totalDays: 8,
      includedDays: 4,
    });

    startOtherTimers(client, "channel-id", [], []);
    const dailyCalendarJob = getScheduledJobByTime(8, 30, "Europe/Berlin");
    await dailyCalendarJob.callback();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      content: "truncated-chunk-1",
      allowedMentions: {
        parse: [],
      },
    }));
    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      content: "truncated-chunk-2",
      allowedMentions: {
        parse: [],
      },
    }));
    expect(loggerMock.log).toHaveBeenCalledWith("warn", expect.objectContaining({
      source: "timer-daily",
      includedEvents: 20,
      totalEvents: 40,
    }));
  });
});
