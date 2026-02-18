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
  EARNINGS_BLOCKED_MESSAGE: "blocked",
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
      watchlistFilterDropped: false,
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

    expect(scheduleJobMock).toHaveBeenCalledTimes(6);
    expect(scheduledJobs[0].rule).toEqual(expect.objectContaining({
      hour: 4,
      minute: 0,
      tz: "US/Eastern",
    }));
    expect(scheduledJobs[0].rule.dayOfWeek).toEqual([expect.objectContaining({start: 1, end: 5})]);

    scheduledJobs[0].callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Der Pre-market hat geöffnet"));
    expect(isHolidayMock).toHaveBeenCalledTimes(1);
  });

  test("startNyseTimers sends holiday closed message on market holiday", () => {
    const {client, send} = createClientWithChannel();
    isHolidayMock.mockReturnValue(true);

    startNyseTimers(client as any, "channel-id");
    scheduledJobs[0].callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Heute bleibt die Börse geschlossen"));
  });

  test("startNyseTimers sends Thanksgiving early-close reminder on the day after Thanksgiving", () => {
    const {client, send} = createClientWithChannel();
    jest.setSystemTime(new Date("2025-11-28T10:00:00-05:00"));

    startNyseTimers(client as any, "channel-id");
    scheduledJobs[0].callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Tag nach dem Truthahn-Tag"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("19:00"));
  });

  test("startNyseTimers treats holiday check by US/Eastern date for aftermarket close", () => {
    const {client, send} = createClientWithChannel();
    // 20:00 US/Eastern on 2025-12-25 equals 2025-12-26T01:00:00Z.
    jest.setSystemTime(new Date("2025-12-26T01:00:00Z"));
    isHolidayMock.mockImplementation(date => date.toDateString() === "Thu Dec 25 2025");

    startNyseTimers(client as any, "channel-id");
    scheduledJobs[4].callback();

    expect(send).not.toHaveBeenCalled();
    expect(isHolidayMock).toHaveBeenCalledWith(expect.any(Date));
  });

  test("startNyseTimers skips announcement when channel is missing", () => {
    const {client} = createClientWithoutChannel();

    startNyseTimers(client as any, "channel-id");

    expect(() => {
      scheduledJobs[0].callback();
    }).not.toThrow();
    expect(loggerMock.log).toHaveBeenCalledWith("error", expect.stringContaining("Skipping NYSE announcement"));
  });

  test("startMncTimers schedules MNC announcement and sends attachment payload", async () => {
    const {client, send} = createClientWithChannel();

    startMncTimers(client as any, "channel-id");

    expect(scheduleJobMock).toHaveBeenCalledTimes(1);
    expect(scheduledJobs[0].rule).toEqual(expect.objectContaining({
      hour: 9,
      minute: 0,
      tz: "US/Eastern",
    }));

    await scheduledJobs[0].callback();
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
    await scheduledJobs[0].callback();

    expect(attachmentBuilderMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(loggerMock.log).toHaveBeenCalledWith("warn", "Skipping MNC announcement: no file downloaded.");
  });

  test("startMncTimers logs and skips when channel is missing", async () => {
    const {client} = createClientWithoutChannel();

    startMncTimers(client as any, "channel-id");
    await scheduledJobs[0].callback();

    expect(loggerMock.log).toHaveBeenCalledWith("error", expect.stringContaining("Skipping MNC announcement"));
  });

  test("startOtherTimers schedules all other jobs and sends Friday asset", async () => {
    const {client, send} = createClientWithChannel();
    const assets = [{title: "freitag"}];

    startOtherTimers(client as any, "channel-id", assets, []);

    expect(scheduleJobMock).toHaveBeenCalledTimes(4);
    expect(scheduledJobs[0].rule).toEqual(expect.objectContaining({
      hour: 8,
      minute: 0,
      tz: "Europe/Berlin",
    }));

    await scheduledJobs[0].callback();

    expect(getAssetByNameMock).toHaveBeenCalledWith("freitag", assets);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      files: expect.any(Array),
    }));
  });

  test("startOtherTimers skips Friday announcement when asset is missing", async () => {
    const {client, send} = createClientWithChannel();
    getAssetByNameMock.mockReturnValueOnce(undefined);

    startOtherTimers(client as any, "channel-id", [], []);
    await scheduledJobs[0].callback();

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
    await scheduledJobs[1].callback();

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "tomorrow", "all");
    expect(send).not.toHaveBeenCalled();
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
    await scheduledJobs[1].callback();

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "tomorrow", "all");
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
    await scheduledJobs[2].callback();

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
    await scheduledJobs[3].callback();

    expect(getCalendarEventsMock).toHaveBeenNthCalledWith(1, "", 2);
    expect(getCalendarEventsMock).toHaveBeenNthCalledWith(2, expect.any(String), 1);
    expect(getCalendarMessagesMock).toHaveBeenCalledWith([
      {date: "2025-02-24", time: "10:00", country: "🇺🇸", name: "Event A"},
      {date: "2025-02-25", time: "11:00", country: "🇺🇸", name: "Event B"},
      {date: "2025-02-26", time: "12:00", country: "🇺🇸", name: "Event C"},
    ], expect.objectContaining({
      maxMessageLength: 1800,
      maxMessages: 8,
      keepDayTogether: true,
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
    await scheduledJobs[2].callback();

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
