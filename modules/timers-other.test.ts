import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {
  CalendarReminderAsset,
  EarningsReminderAsset,
} from "./assets.ts";
import {
  addExpectedMovesToEarningsEventsMock,
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
  loadEarningsWhispersWeeklyTickersMock,
  type MockRecurrenceRule,
  type MockRange,
  resetTimerMocks,
  restoreTimerMocks,
  scheduleJobMock,
  scheduledJobs,
  startOtherTimers,
} from "./test-utils/timers.ts";

type CalendarReminderOptions = {
  countryFlags?: string[];
  eventNameSubstrings: string[];
  minutesBefore?: number;
  name: string;
  roleId: string;
};
type EarningsReminderOptions = {
  name: string;
  roleId: string;
  tickerSymbols: string[];
};

function createCalendarReminderAsset(options: CalendarReminderOptions): CalendarReminderAsset {
  const asset = new CalendarReminderAsset();
  asset.name = options.name;
  asset.eventNameSubstrings = options.eventNameSubstrings;
  asset.countryFlags = options.countryFlags ?? [];
  asset.roleId = options.roleId;
  asset.minutesBefore = options.minutesBefore ?? 0;
  return asset;
}

function createEarningsReminderAsset(options: EarningsReminderOptions): EarningsReminderAsset {
  const asset = new EarningsReminderAsset();
  asset.name = options.name;
  asset.roleId = options.roleId;
  asset.tickerSymbols = options.tickerSymbols;
  return asset;
}

describe("timers: other announcements", () => {
  beforeEach(resetTimerMocks);
  afterEach(restoreTimerMocks);

  test("startOtherTimers schedules all other jobs and sends Friday asset", async () => {
    const {client, send} = createClientWithChannel();
    const assets = [{name: "freitag"}];

    startOtherTimers(client, "channel-id", assets, []);
    const fridayJob = getScheduledJobByTime(8, 0, "Europe/Berlin");
    const dailyEarningsWarmupJob = getScheduledJobByTime(19, 28, "Europe/Berlin");
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    const weeklyEarningsWarmupJob = getScheduledJobByTime(23, 28, "Europe/Berlin");
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

    expect(scheduleJobMock).toHaveBeenCalledTimes(8);
    expect(fridayJob.rule).toEqual(expect.objectContaining({
      hour: 8,
      minute: 0,
      tz: "Europe/Berlin",
    }));
    expect(dailyEarningsJob.rule.dayOfWeek).toEqual([expect.objectContaining({start: 0, end: 6})]);
    expect(dailyEarningsWarmupJob.rule.dayOfWeek).toEqual([expect.objectContaining({start: 0, end: 6})]);
    expect(weeklyEarningsWarmupJob.rule).toEqual(expect.objectContaining({
      hour: 23,
      minute: 28,
      tz: "Europe/Berlin",
    }));
    expect(weeklyEarningsWarmupJob.rule.dayOfWeek).toEqual([5]);
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

    startOtherTimers(client, "channel-id", [], [], [createCalendarReminderAsset({
      name: "us-cpi-1h",
      eventNameSubstrings: ["consumer price index", "cpi"],
      countryFlags: ["🇺🇸"],
      roleId: "role-123",
      minutesBefore: 60,
    })], []);
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

    startOtherTimers(client, "channel-id", [], [], [createCalendarReminderAsset({
      name: "us-cpi-1h",
      eventNameSubstrings: ["cpi"],
      countryFlags: ["🇺🇸"],
      roleId: "role-123",
      minutesBefore: 60,
    })], []);
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
      createCalendarReminderAsset({
        name: "wrong-country",
        eventNameSubstrings: ["cpi"],
        countryFlags: ["🇺🇸"],
        roleId: "role-123",
        minutesBefore: 60,
      }),
      createCalendarReminderAsset({
        name: "missing-role",
        eventNameSubstrings: ["cpi"],
        countryFlags: ["🇪🇺"],
        roleId: "   ",
        minutesBefore: 60,
      }),
      createCalendarReminderAsset({
        name: "missing-matchers",
        eventNameSubstrings: [],
        countryFlags: ["🇪🇺"],
        roleId: "role-123",
        minutesBefore: 60,
      }),
    ], []);
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
      createCalendarReminderAsset({
        name: "us-gdp-1h",
        eventNameSubstrings: ["gdp q/q"],
        countryFlags: ["🇺🇸"],
        roleId: "role-123",
      }),
      createCalendarReminderAsset({
        name: "us-fomc-statement-1h",
        eventNameSubstrings: ["fomc statement"],
        countryFlags: ["🇺🇸"],
        roleId: "role-123",
      }),
    ], []);
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

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "tomorrow", {
      source: "timer-earnings",
    });
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

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "tomorrow", {
      source: "timer-earnings",
    });
    expect(addExpectedMovesToEarningsEventsMock).toHaveBeenCalledWith([], {
      marketCapFilter: "bluechips",
      when: "all",
    });
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

  test("startOtherTimers enriches scheduled earnings with expected moves before formatting", async () => {
    const {client, send} = createClientWithChannel();
    const earningsEvents = [{
      ticker: "NVDA",
      when: "after_close",
      date: "2025-02-24",
      importance: 1,
      companyName: "NVIDIA",
      marketCap: 2_000_000_000_000,
      marketCapText: "$2T",
      epsConsensus: "0.80",
    }];
    const enrichedEvents = [{
      ...earningsEvents[0]!,
      expectedMove: 12.4,
      expectedMoveActualDte: 1,
      expectedMoveExpiration: "2025-02-25",
    }];
    getEarningsResultMock.mockResolvedValue({
      events: earningsEvents,
      status: "ok",
    });
    addExpectedMovesToEarningsEventsMock.mockResolvedValue(enrichedEvents);

    startOtherTimers(client, "channel-id", [], []);
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    await dailyEarningsJob.callback();

    expect(addExpectedMovesToEarningsEventsMock).toHaveBeenCalledWith(earningsEvents, {
      marketCapFilter: "bluechips",
      when: "all",
    });
    expect(getEarningsMessagesMock).toHaveBeenCalledWith(enrichedEvents, "all", [], {
      maxMessageLength: 1800,
      maxMessages: 8,
      marketCapFilter: "bluechips",
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: "earnings-text",
    }));
  });

  test("startOtherTimers sends most anticipated daily earnings separately and removes them from the regular post", async () => {
    const {client, send} = createClientWithChannel();
    const earningsEvents = [
      {
        ticker: "AMD",
        when: "before_open",
        date: "2025-02-24",
        importance: 1,
        companyName: "Advanced Micro Devices",
        marketCap: 220_000_000_000,
        epsConsensus: "0.48",
      },
      {
        ticker: "UBER",
        when: "before_open",
        date: "2025-02-24",
        importance: 1,
        companyName: "Uber Technologies",
        marketCap: 160_000_000_000,
        epsConsensus: "0.50",
      },
      {
        ticker: "AEHR",
        when: "after_close",
        date: "2025-02-24",
        importance: 1,
        companyName: "Aehr Test Systems",
        marketCap: 10_000_000_000,
        epsConsensus: "0.10",
      },
    ];
    getEarningsResultMock.mockResolvedValue({
      events: earningsEvents,
      status: "ok",
    });
    addExpectedMovesToEarningsEventsMock.mockResolvedValue(earningsEvents);
    loadEarningsWhispersWeeklyTickersMock.mockResolvedValue(new Set(["AMD", "AEHR"]));
    getEarningsMessagesMock
      .mockReturnValueOnce({
        messages: ["anticipated-earnings"],
        truncated: false,
        totalEvents: 2,
        includedEvents: 2,
      })
      .mockReturnValueOnce({
        messages: ["regular-earnings"],
        truncated: false,
        totalEvents: 1,
        includedEvents: 1,
      });

    startOtherTimers(client, "channel-id", [], []);
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    await dailyEarningsJob.callback();

    expect(loadEarningsWhispersWeeklyTickersMock).toHaveBeenCalledTimes(1);
    expect(loadEarningsWhispersWeeklyTickersMock.mock.calls[0]?.[0].now.format("YYYY-MM-DD")).toBe("2025-02-24");
    expect(getEarningsMessagesMock).toHaveBeenNthCalledWith(
      1,
      [earningsEvents[0], earningsEvents[2]],
      "all",
      expect.arrayContaining([
        expect.objectContaining({symbol: "AMD", exchange: "earnings-whispers"}),
        expect.objectContaining({symbol: "AEHR", exchange: "earnings-whispers"}),
      ]),
      {
        maxMessageLength: 1800,
        maxMessages: 8,
        marketCapFilter: "all",
      },
    );
    expect(getEarningsMessagesMock).toHaveBeenNthCalledWith(2, [earningsEvents[1]], "all", [], {
      maxMessageLength: 1800,
      maxMessages: 8,
      marketCapFilter: "bluechips",
    });
    expect(send).toHaveBeenNthCalledWith(1, {
      content: "🔥 **Most Anticipated Earnings**\nanticipated-earnings",
      allowedMentions: {
        parse: [],
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      content: "regular-earnings",
      allowedMentions: {
        parse: [],
      },
    });
  });

  test("startOtherTimers still sends most anticipated earnings when the regular post is empty", async () => {
    const {client, send} = createClientWithChannel();
    const earningsEvents = [{
      ticker: "AMD",
      when: "before_open",
      date: "2025-02-24",
      importance: 1,
      companyName: "Advanced Micro Devices",
      marketCap: 220_000_000_000,
      epsConsensus: "0.48",
    }];
    getEarningsResultMock.mockResolvedValue({
      events: earningsEvents,
      status: "ok",
    });
    addExpectedMovesToEarningsEventsMock.mockResolvedValue(earningsEvents);
    loadEarningsWhispersWeeklyTickersMock.mockResolvedValue(new Set(["AMD"]));
    getEarningsMessagesMock
      .mockReturnValueOnce({
        messages: ["anticipated-only"],
        truncated: false,
        totalEvents: 1,
        includedEvents: 1,
      })
      .mockReturnValueOnce({
        messages: [],
        truncated: false,
        totalEvents: 0,
        includedEvents: 0,
      });

    startOtherTimers(client, "channel-id", [], []);
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    await dailyEarningsJob.callback();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: "🔥 **Most Anticipated Earnings**\nanticipated-only",
      allowedMentions: {
        parse: [],
      },
    });
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

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "tomorrow", {
      source: "timer-earnings",
    });
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

  test("startOtherTimers sends upcoming earnings to the optional expectations thread", async () => {
    const channelSend = vi.fn().mockResolvedValue(undefined);
    const threadSend = vi.fn().mockResolvedValue(undefined);
    const client = {
      channels: {
        cache: {
          get: vi.fn((channelId: string) => {
            if ("earnings-expectations-thread" === channelId) {
              return {
                send: threadSend,
              };
            }

            return {
              send: channelSend,
            };
          }),
        },
      },
    };

    startOtherTimers(client, "channel-id", [], [], [], [], "earnings-expectations-thread");
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    await dailyEarningsJob.callback();

    expect(threadSend).toHaveBeenCalledWith({
      content: "earnings-text",
      allowedMentions: {
        parse: [],
      },
    });
    expect(channelSend).not.toHaveBeenCalled();
  });

  test("startOtherTimers sends weekly earnings with dedicated headline on Friday evening", async () => {
    const {client, send} = createClientWithChannel();
    getEarningsMessagesMock.mockReturnValue({
      messages: [
        "**Zeitraum:** Mittwoch, 6. Mai 2026 bis Donnerstag, 7. Mai 2026\n**Mittwoch, 6. Mai 2026**\nweekly-earnings-1",
        "weekly-earnings-2",
      ],
      truncated: false,
      totalEvents: 10,
      includedEvents: 10,
    });

    startOtherTimers(client, "channel-id", [], []);
    const weeklyEarningsJob = getScheduledJobByTime(23, 30, "Europe/Berlin");
    await weeklyEarningsJob.callback();

    expect(getEarningsResultMock).toHaveBeenCalledWith(5, "tomorrow", {
      source: "timer-earnings-weekly",
    });
    expect(getEarningsMessagesMock).toHaveBeenCalledWith([], "all", [], {
      maxMessageLength: 1800,
      maxMessages: 8,
      marketCapFilter: "bluechips",
    });
    expect(send).toHaveBeenNthCalledWith(1, {
      content: "📅 **Earnings der nächsten Handelswoche** (Mittwoch, 6. Mai 2026 bis Donnerstag, 7. Mai 2026)\n**Mittwoch, 6. Mai 2026**\nweekly-earnings-1",
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

  test("startOtherTimers sends most anticipated weekly earnings separately and excludes them from weekly earnings", async () => {
    const {client, send} = createClientWithChannel();
    const earningsEvents = [
      {
        ticker: "MSFT",
        when: "after_close",
        date: "2025-02-24",
        importance: 1,
        companyName: "Microsoft",
        marketCap: 3_000_000_000_000,
        epsConsensus: "3.00",
      },
      {
        ticker: "META",
        when: "after_close",
        date: "2025-02-25",
        importance: 1,
        companyName: "Meta Platforms",
        marketCap: 1_500_000_000_000,
        epsConsensus: "5.00",
      },
      {
        ticker: "AAPL",
        when: "after_close",
        date: "2025-02-26",
        importance: 1,
        companyName: "Apple",
        marketCap: 3_200_000_000_000,
        epsConsensus: "1.50",
      },
    ];
    getEarningsResultMock.mockResolvedValue({
      events: earningsEvents,
      status: "ok",
    });
    addExpectedMovesToEarningsEventsMock.mockResolvedValue(earningsEvents);
    loadEarningsWhispersWeeklyTickersMock.mockResolvedValue(new Set(["MSFT", "AAPL"]));
    getEarningsMessagesMock
      .mockReturnValueOnce({
        messages: ["weekly-anticipated"],
        truncated: false,
        totalEvents: 2,
        includedEvents: 2,
      })
      .mockReturnValueOnce({
        messages: ["weekly-regular"],
        truncated: false,
        totalEvents: 1,
        includedEvents: 1,
      });

    startOtherTimers(client, "channel-id", [], []);
    const weeklyEarningsJob = getScheduledJobByTime(23, 30, "Europe/Berlin");
    await weeklyEarningsJob.callback();

    expect(getEarningsMessagesMock).toHaveBeenNthCalledWith(
      1,
      [earningsEvents[0], earningsEvents[2]],
      "all",
      expect.arrayContaining([
        expect.objectContaining({symbol: "MSFT", exchange: "earnings-whispers"}),
        expect.objectContaining({symbol: "AAPL", exchange: "earnings-whispers"}),
      ]),
      {
        maxMessageLength: 1800,
        maxMessages: 8,
        marketCapFilter: "all",
      },
    );
    expect(getEarningsMessagesMock).toHaveBeenNthCalledWith(2, [earningsEvents[1]], "all", [], {
      maxMessageLength: 1800,
      maxMessages: 8,
      marketCapFilter: "bluechips",
    });
    expect(send).toHaveBeenNthCalledWith(1, {
      content: "🔥 **Most Anticipated Earnings der nächsten Handelswoche**\nweekly-anticipated",
      allowedMentions: {
        parse: [],
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      content: "📅 **Earnings der nächsten Handelswoche**\nweekly-regular",
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

    startOtherTimers(client, "channel-id", [], [], [], [createEarningsReminderAsset({
      name: "big-tech-earnings",
      tickerSymbols: ["NVDA", "MSFT"],
      roleId: "role-456",
    })]);
    await getEarningsReminderJob().callback();

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "today", {
      source: "earnings-reminder",
    });
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
      createEarningsReminderAsset({
        name: "big-tech-earnings",
        tickerSymbols: [" nvda ", "msft"],
        roleId: "role-456",
      }),
      createEarningsReminderAsset({
        name: "no-match",
        tickerSymbols: ["AAPL"],
        roleId: "role-789",
      }),
    ]);
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

    startOtherTimers(client, "channel-id", [], [], [], [createEarningsReminderAsset({
      name: "berkshire-earnings",
      tickerSymbols: ["BRK.B"],
      roleId: "role-456",
    })]);
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

    startOtherTimers(client, "channel-id", [], [], [], [createEarningsReminderAsset({
      name: "aapl-earnings",
      tickerSymbols: ["AAPL"],
      roleId: "   ",
    })]);
    await getEarningsReminderJob().callback();

    expect(send).not.toHaveBeenCalled();
  });

  test("startOtherTimers skips earnings reminder sends when loading earnings fails", async () => {
    const {client, send} = createClientWithChannel();
    getEarningsResultMock.mockResolvedValue({
      events: [],
      status: "error",
    });

    startOtherTimers(client, "channel-id", [], [], [], [createEarningsReminderAsset({
      name: "aapl-earnings",
      tickerSymbols: ["AAPL"],
      roleId: "role-456",
    })]);
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
