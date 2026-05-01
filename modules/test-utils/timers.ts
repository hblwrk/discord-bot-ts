import moment from "moment-timezone";

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
const getCalendarEventsResultMock = jest.fn();
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

jest.mock("../assets.js", () => ({
  getAssetByName: getAssetByNameMock,
}));

jest.mock("../calendar.js", () => ({
  CALENDAR_MAX_MESSAGE_LENGTH: 1800,
  CALENDAR_MAX_MESSAGES_TIMER: 8,
  getCalendarEventDateTime: (event: {date: string; time: string}) => moment.tz(
    `${event.date} ${event.time}`,
    "YYYY-MM-DD HH:mm",
    "Europe/Berlin",
  ),
  getCalendarEvents: getCalendarEventsMock,
  getCalendarEventsResult: getCalendarEventsResultMock,
  getCalendarMessages: getCalendarMessagesMock,
}));

jest.mock("../earnings.js", () => ({
  EARNINGS_MAX_MESSAGE_LENGTH: 1800,
  EARNINGS_MAX_MESSAGES_TIMER: 8,
  getEarningsResult: getEarningsResultMock,
  getEarningsMessages: getEarningsMessagesMock,
}));

jest.mock("../mnc-downloader.js", () => ({
  getMnc: getMncMock,
}));

jest.mock("../logging.js", () => ({
  getLogger: () => loggerMock,
}));

import {startMncTimers, startNyseTimers, startOtherTimers} from "../timers.js";

type ScheduledJob = {
  callback: (...args: unknown[]) => unknown;
  rule: MockRecurrenceRule | Date;
  scheduledJob: {
    cancel: jest.Mock;
  };
};
type RecurringScheduledJob = ScheduledJob & {
  rule: MockRecurrenceRule;
};
type DateScheduledJob = ScheduledJob & {
  rule: Date;
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

function getScheduledJobByTime(hour: number, minute: number, tz: string): RecurringScheduledJob {
  const scheduledJob = scheduledJobs.find(job =>
    false === (job.rule instanceof Date) &&
    hour === job.rule.hour &&
    minute === job.rule.minute &&
    tz === job.rule.tz);
  if (!scheduledJob) {
    throw new Error(`Scheduled job not found for ${tz} ${hour}:${minute}.`);
  }

  return scheduledJob as RecurringScheduledJob;
}

function getScheduledDateJobs(): DateScheduledJob[] {
  return scheduledJobs.filter(job => job.rule instanceof Date) as DateScheduledJob[];
}

function getEarningsReminderJob(): RecurringScheduledJob {
  const earningsReminderJob = scheduledJobs.find(job =>
    false === (job.rule instanceof Date) &&
    8 === job.rule.hour &&
    0 === job.rule.minute &&
    "Europe/Berlin" === job.rule.tz &&
    Array.isArray(job.rule.dayOfWeek) &&
    1 === (job.rule.dayOfWeek[0] as MockRange).start &&
    5 === (job.rule.dayOfWeek[0] as MockRange).end);
  if (!earningsReminderJob) {
    throw new Error("Scheduled earnings reminder job not found.");
  }

  return earningsReminderJob as RecurringScheduledJob;
}


export function resetTimerMocks() {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-02-18T10:00:00-05:00"));
  jest.clearAllMocks();
  scheduledJobs.length = 0;

  scheduleJobMock.mockImplementation((rule: MockRecurrenceRule, callback: (...args: unknown[]) => unknown) => {
    const scheduledJob = {
      cancel: jest.fn(),
    };
    scheduledJobs.push({rule, callback, scheduledJob});
    return scheduledJob;
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
  getCalendarEventsResultMock.mockResolvedValue({
    events: [],
    status: "ok",
  });
  getCalendarMessagesMock.mockReturnValue({
    messages: ["calendar-text"],
    truncated: false,
    totalEvents: 1,
    includedEvents: 1,
    totalDays: 1,
    includedDays: 1,
  });
}

export function restoreTimerMocks() {
  jest.useRealTimers();
}

export {
  attachmentBuilderMock,
  createClientWithChannel,
  createClientWithoutChannel,
  getAssetByNameMock,
  getCalendarEventsMock,
  getCalendarEventsResultMock,
  getCalendarMessagesMock,
  getEarningsMessagesMock,
  getEarningsReminderJob,
  getEarningsResultMock,
  getHolidaysMock,
  getMncMock,
  getScheduledDateJobs,
  getScheduledJobByTime,
  isHolidayMock,
  loggerMock,
  MockRecurrenceRule,
  MockRange,
  scheduleJobMock,
  scheduledJobs,
  startMncTimers,
  startNyseTimers,
  startOtherTimers,
};
