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
const getCalendarTextMock = jest.fn();
const getEarningsMock = jest.fn();
const getEarningsTextMock = jest.fn();
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
  getCalendarEvents: getCalendarEventsMock,
  getCalendarText: getCalendarTextMock,
}));

jest.mock("./earnings.js", () => ({
  getEarnings: getEarningsMock,
  getEarningsText: getEarningsTextMock,
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
    getEarningsMock.mockResolvedValue([]);
    getEarningsTextMock.mockReturnValue("earnings-text");
    getCalendarEventsMock.mockResolvedValue([]);
    getCalendarTextMock.mockReturnValue("calendar-text");
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

  test("startOtherTimers does not send earnings message when formatter returns none", async () => {
    const {client, send} = createClientWithChannel();
    getEarningsTextMock.mockReturnValue("none");

    startOtherTimers(client as any, "channel-id", [], []);
    await scheduledJobs[1].callback();

    expect(getEarningsMock).toHaveBeenCalledWith(0, "tomorrow", "all");
    expect(send).not.toHaveBeenCalled();
  });

  test("startOtherTimers sends two weekly calendar messages when both chunks exist", async () => {
    const {client, send} = createClientWithChannel();
    getCalendarTextMock
      .mockReturnValueOnce("week-1")
      .mockReturnValueOnce("week-2");

    startOtherTimers(client as any, "channel-id", [], []);
    await scheduledJobs[3].callback();

    expect(getCalendarEventsMock).toHaveBeenNthCalledWith(1, "", 2);
    expect(getCalendarEventsMock).toHaveBeenNthCalledWith(2, expect.any(String), 1);
    expect(send).toHaveBeenNthCalledWith(1, "week-1");
    expect(send).toHaveBeenNthCalledWith(2, "week-2");
  });
});
