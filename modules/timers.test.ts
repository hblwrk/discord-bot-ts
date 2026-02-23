const scheduleJobMock = jest.fn();

class MockRecurrenceRule {
  hour?: number;
  minute?: number;
  dayOfWeek?: unknown[];
  tz?: string;
}

class MockRange {
  start: number;
  end: number;

  constructor(start: number, end: number) {
    this.start = start;
    this.end = end;
  }
}

const attachmentBuilderMock = jest.fn().mockImplementation(function mockAttachmentBuilder(file: Buffer, options: {name: string}) {
  return {file, ...options};
});

const getHolidaysMock = jest.fn();
const isHolidayMock = jest.fn();
const getAssetByNameMock = jest.fn();
const getCalendarEventsMock = jest.fn();
const getCalendarMessagesMock = jest.fn();
const getEarningsResultMock = jest.fn();
const getEarningsMessagesMock = jest.fn();
const getMncMock = jest.fn();
const loggerMock = {
  log: jest.fn(),
};

jest.mock("discord.js", () => ({
  AttachmentBuilder: attachmentBuilderMock,
}));

jest.mock("node-schedule", () => ({
  __esModule: true,
  default: {
    RecurrenceRule: MockRecurrenceRule,
    Range: MockRange,
    scheduleJob: scheduleJobMock,
  },
}));

jest.mock("nyse-holidays", () => ({
  getHolidays: getHolidaysMock,
  isHoliday: isHolidayMock,
}));

jest.mock("./assets.js", () => ({
  getAssetByName: getAssetByNameMock,
}));

jest.mock("./calendar.js", () => ({
  CALENDAR_MAX_MESSAGE_LENGTH: 1800,
  CALENDAR_MAX_MESSAGES_TIMER: 8,
  getCalendarEvents: getCalendarEventsMock,
  getCalendarMessages: getCalendarMessagesMock,
}));

jest.mock("./earnings.js", () => ({
  EARNINGS_MAX_MESSAGE_LENGTH: 1800,
  EARNINGS_MAX_MESSAGES_TIMER: 8,
  getEarningsResult: getEarningsResultMock,
  getEarningsMessages: getEarningsMessagesMock,
}));

jest.mock("./mnc-downloader.js", () => ({
  getMnc: getMncMock,
}));

jest.mock("./logging.js", () => ({
  getLogger: () => loggerMock,
}));

import {startMncTimers, startNyseTimers, startOtherTimers} from "./timers.js";

type ScheduledJob = {
  callback: (...args: unknown[]) => unknown;
  rule: MockRecurrenceRule;
};

const scheduledJobs: ScheduledJob[] = [];

function createClientWithChannel() {
  const send = jest.fn().mockResolvedValue(undefined);
  const channel = {send};
  const get = jest.fn(() => channel);
  const client = {
    channels: {
      cache: {
        get,
      },
    },
  };

  return {
    client,
    get,
    send,
  };
}

function createClientWithoutChannel() {
  const get = jest.fn(() => undefined);
  const client = {
    channels: {
      cache: {
        get,
      },
    },
  };

  return {
    client,
    get,
  };
}

function getScheduledJobByTime(hour: number, minute: number, tz: string): ScheduledJob {
  const scheduledJob = scheduledJobs.find(job =>
    hour === job.rule.hour &&
    minute === job.rule.minute &&
    tz === job.rule.tz);
  if (!scheduledJob) {
    throw new Error(`Scheduled job not found for ${tz} ${hour}:${minute}.`);
  }

  return scheduledJob;
}

describe("timers", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-02-18T10:00:00-05:00"));
    jest.clearAllMocks();
    scheduledJobs.length = 0;

    scheduleJobMock.mockImplementation((rule: MockRecurrenceRule, callback: (...args: unknown[]) => unknown) => {
      scheduledJobs.push({rule, callback});
      return {cancel: jest.fn()};
    });

    getHolidaysMock.mockReturnValue([
      {
        date: new Date("2025-11-27T12:00:00-05:00"),
        dateString: "2025-11-27",
        name: "Thanksgiving Day",
      },
    ]);

    isHolidayMock.mockReturnValue(false);
    getMncMock.mockResolvedValue(Buffer.from("mnc-pdf"));
    getAssetByNameMock.mockReturnValue({
      fileContent: Buffer.from("freitag"),
      fileName: "freitag.png",
    });
    getEarningsResultMock.mockResolvedValue({
      events: [],
      status: "ok",
    });
    getEarningsMessagesMock.mockReturnValue({
      messages: ["earnings-text"],
      truncated: false,
      totalEvents: 1,
      includedEvents: 1,
    });
    getCalendarEventsMock.mockResolvedValue([]);
    getCalendarMessagesMock.mockReturnValue({
      messages: ["calendar-text"],
      truncated: false,
      totalEvents: 1,
      includedEvents: 1,
      totalDays: 1,
      includedDays: 1,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("startNyseTimers registers NYSE jobs and sends regular pre-market announcement", () => {
    const {client, send} = createClientWithChannel();

    startNyseTimers(client as any, "channel-id");
    const premarketJob = getScheduledJobByTime(4, 0, "US/Eastern");

    expect(scheduleJobMock).toHaveBeenCalledTimes(6);
    expect(premarketJob.rule).toEqual(expect.objectContaining({
      hour: 4,
      minute: 0,
      tz: "US/Eastern",
    }));
    expect(premarketJob.rule.dayOfWeek).toEqual([expect.objectContaining({start: 1, end: 5})]);

    premarketJob.callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Der Pre-market hat geöffnet"));
    expect(isHolidayMock).toHaveBeenCalledTimes(1);
  });

  test("startNyseTimers sends holiday closed message on market holiday", () => {
    const {client, send} = createClientWithChannel();
    isHolidayMock.mockReturnValue(true);

    startNyseTimers(client as any, "channel-id");
    const premarketJob = getScheduledJobByTime(4, 0, "US/Eastern");
    premarketJob.callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Heute bleibt die Börse geschlossen"));
  });

  test("startNyseTimers sends Thanksgiving early-close reminder on the day after Thanksgiving", () => {
    const {client, send} = createClientWithChannel();
    jest.setSystemTime(new Date("2025-11-28T10:00:00-05:00"));

    startNyseTimers(client as any, "channel-id");
    const premarketJob = getScheduledJobByTime(4, 0, "US/Eastern");
    premarketJob.callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Tag nach dem Truthahn-Tag"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("19:00"));
  });

  test("startNyseTimers resolves Thanksgiving date based on the current US/Eastern year", () => {
    const {client, send} = createClientWithChannel();
    jest.setSystemTime(new Date("2025-12-30T10:00:00-05:00"));
    getHolidaysMock.mockImplementation(year => {
      if (2025 === year) {
        return [
          {
            date: new Date("2025-11-27T12:00:00-05:00"),
            name: "Thanksgiving Day",
          },
        ];
      }

      if (2026 === year) {
        return [
          {
            date: new Date("2026-11-26T12:00:00-05:00"),
            name: "Thanksgiving Day",
          },
        ];
      }

      return [];
    });

    startNyseTimers(client as any, "channel-id");
    jest.setSystemTime(new Date("2026-11-27T10:00:00-05:00"));
    const premarketJob = getScheduledJobByTime(4, 0, "US/Eastern");
    premarketJob.callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Tag nach dem Truthahn-Tag"));
    expect(getHolidaysMock).toHaveBeenLastCalledWith(2026);
  });

  test("startNyseTimers treats holiday check by US/Eastern date for aftermarket close", () => {
    const {client, send} = createClientWithChannel();
    // 20:00 US/Eastern on 2025-12-25 equals 2025-12-26T01:00:00Z.
    jest.setSystemTime(new Date("2025-12-26T01:00:00Z"));
    isHolidayMock.mockImplementation(date => date.toDateString() === "Thu Dec 25 2025");

    startNyseTimers(client as any, "channel-id");
    const aftermarketJob = getScheduledJobByTime(20, 0, "US/Eastern");
    aftermarketJob.callback();

    expect(send).not.toHaveBeenCalled();
    expect(isHolidayMock).toHaveBeenCalledWith(expect.any(Date));
  });

  test("startNyseTimers points close announcement to Heutige Gains&Losses thread", () => {
    const {client, send} = createClientWithChannel();

    startNyseTimers(client as any, "channel-id", "thread-id");
    const closeJob = getScheduledJobByTime(16, 0, "US/Eastern");
    closeJob.callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("<#thread-id>"));
  });

  test("startNyseTimers skips announcement when channel is missing", () => {
    const {client} = createClientWithoutChannel();

    startNyseTimers(client as any, "channel-id");
    const premarketJob = getScheduledJobByTime(4, 0, "US/Eastern");

    expect(() => {
      premarketJob.callback();
    }).not.toThrow();
    expect(loggerMock.log).toHaveBeenCalledWith("error", expect.stringContaining("Skipping NYSE announcement"));
  });

  test("startMncTimers schedules MNC announcement and sends attachment payload", async () => {
    const {client, send} = createClientWithChannel();

    startMncTimers(client as any, "channel-id");
    const mncJob = getScheduledJobByTime(9, 0, "US/Eastern");

    expect(scheduleJobMock).toHaveBeenCalledTimes(1);
    expect(mncJob.rule).toEqual(expect.objectContaining({
      hour: 9,
      minute: 0,
      tz: "US/Eastern",
    }));

    await mncJob.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(getMncMock).toHaveBeenCalledTimes(1);
    expect(attachmentBuilderMock).toHaveBeenCalledWith(Buffer.from("mnc-pdf"), expect.objectContaining({
      name: expect.stringMatching(/^MNC-\d{4}-\d{2}-\d{2}\.pdf$/),
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Morning News Call"),
      files: expect.any(Array),
    }));
  });

  test("startMncTimers skips announcement when no MNC file was downloaded", async () => {
    const {client, send} = createClientWithChannel();
    getMncMock.mockResolvedValueOnce(undefined);

    startMncTimers(client as any, "channel-id");
    const mncJob = getScheduledJobByTime(9, 0, "US/Eastern");
    await mncJob.callback();

    expect(attachmentBuilderMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(loggerMock.log).toHaveBeenCalledWith("warn", "Skipping MNC announcement: no file downloaded.");
  });

  test("startMncTimers logs and skips when channel is missing", async () => {
    const {client} = createClientWithoutChannel();

    startMncTimers(client as any, "channel-id");
    const mncJob = getScheduledJobByTime(9, 0, "US/Eastern");
    await mncJob.callback();

    expect(loggerMock.log).toHaveBeenCalledWith("error", expect.stringContaining("Skipping MNC announcement"));
  });

  test("startOtherTimers schedules all other jobs and sends Friday asset", async () => {
    const {client, send} = createClientWithChannel();
    const assets = [{title: "freitag"}];

    startOtherTimers(client as any, "channel-id", assets, []);
    const fridayJob = getScheduledJobByTime(8, 0, "Europe/Berlin");
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    const weeklyEarningsJob = getScheduledJobByTime(23, 30, "Europe/Berlin");
    const weeklyCalendarJob = getScheduledJobByTime(23, 45, "Europe/Berlin");

    expect(scheduleJobMock).toHaveBeenCalledTimes(5);
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

  test("startOtherTimers skips Friday announcement when asset is unavailable", async () => {
    const {client, send} = createClientWithChannel();
    getAssetByNameMock.mockReturnValue(undefined);

    startOtherTimers(client as any, "channel-id", [], []);
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

    startOtherTimers(client as any, "channel-id", [], []);
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

    startOtherTimers(client as any, "channel-id", [], []);
    const dailyEarningsJob = getScheduledJobByTime(19, 30, "Europe/Berlin");
    await dailyEarningsJob.callback();

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "tomorrow");
    expect(send).not.toHaveBeenCalled();
  });

  test("startOtherTimers skips earnings timer when next US/Eastern day is a weekend", async () => {
    const {client, send} = createClientWithChannel();
    jest.setSystemTime(new Date("2025-02-21T19:30:00+01:00"));

    startOtherTimers(client as any, "channel-id", [], []);
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
    jest.setSystemTime(new Date("2025-07-03T19:30:00+02:00"));
    isHolidayMock.mockImplementation(date => date.toDateString() === "Fri Jul 04 2025");

    startOtherTimers(client as any, "channel-id", [], []);
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
    jest.setSystemTime(new Date("2025-02-23T19:30:00+01:00"));

    startOtherTimers(client as any, "channel-id", [], []);
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

    startOtherTimers(client as any, "channel-id", [], []);
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

    startOtherTimers(client as any, "channel-id", [], []);
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

    startOtherTimers(client as any, "channel-id", [], []);
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

    startOtherTimers(client as any, "channel-id", [], []);
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

    startOtherTimers(client as any, "channel-id", [], []);
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
