import type {Mock} from "vitest";
import moment from "moment-timezone";
import {vi} from "vitest";

const scheduleJobMock = vi.fn();

interface MockRecurrenceRule {
  hour?: number;
  minute?: number;
  dayOfWeek?: unknown[];
  tz?: string;
}

function MockRecurrenceRule(this: MockRecurrenceRule) {}

interface MockRange {
  start: number;
  end: number;
}

function MockRange(this: MockRange, start: number, end: number) {
  this.start = start;
  this.end = end;
}

const attachmentBuilderMock = vi.fn().mockImplementation(function mockAttachmentBuilder(file: Buffer, options: {name: string}) {
  return {file, ...options};
});

const getHolidaysMock = vi.fn();
const isHolidayMock = vi.fn();
const getAssetByNameMock = vi.fn();
const getCalendarEventsMock = vi.fn();
const getCalendarEventsResultMock = vi.fn();
const getCalendarMessagesMock = vi.fn();
const addExpectedMovesToEarningsEventsMock = vi.fn();
const getEarningsResultMock = vi.fn();
const getEarningsMessagesMock = vi.fn();
const getMncMock = vi.fn();
const loggerMock = {
  log: vi.fn(),
};

vi.mock("discord.js", () => ({
  AttachmentBuilder: function MockAttachmentBuilder(...args: [Buffer, {name: string}]) {
    return attachmentBuilderMock(...args);
  },
}));

vi.mock("node-schedule", () => ({
  __esModule: true,
  default: {
    RecurrenceRule: MockRecurrenceRule,
    Range: MockRange,
    scheduleJob: (...args: unknown[]) => scheduleJobMock(...args),
  },
}));

vi.mock("nyse-holidays", () => ({
  getHolidays: (...args: unknown[]) => getHolidaysMock(...args),
  isHoliday: (...args: unknown[]) => isHolidayMock(...args),
}));

vi.mock("../assets.ts", () => ({
  getAssetByName: (...args: unknown[]) => getAssetByNameMock(...args),
}));

vi.mock("../calendar.ts", () => ({
  CALENDAR_MAX_MESSAGE_LENGTH: 1800,
  CALENDAR_MAX_MESSAGES_TIMER: 8,
  getCalendarEventDateTime: (event: {date: string; time: string}) => moment.tz(
    `${event.date} ${event.time}`,
    "YYYY-MM-DD HH:mm",
    "Europe/Berlin",
  ),
  getCalendarEvents: (...args: unknown[]) => getCalendarEventsMock(...args),
  getCalendarEventsResult: (...args: unknown[]) => getCalendarEventsResultMock(...args),
  getCalendarMessages: (...args: unknown[]) => getCalendarMessagesMock(...args),
}));

vi.mock("../earnings.ts", () => ({
  EARNINGS_MAX_MESSAGE_LENGTH: 1800,
  EARNINGS_MAX_MESSAGES_TIMER: 8,
  getEarningsResult: (...args: unknown[]) => getEarningsResultMock(...args),
  getEarningsMessages: (...args: unknown[]) => getEarningsMessagesMock(...args),
}));

vi.mock("../earnings-expected-move.ts", () => ({
  addExpectedMovesToEarningsEvents: (...args: unknown[]) => addExpectedMovesToEarningsEventsMock(...args),
}));

vi.mock("../mnc-downloader.ts", () => ({
  getMnc: (...args: unknown[]) => getMncMock(...args),
}));

vi.mock("../logging.ts", () => ({
  getLogger: () => ({
    log: (...args: unknown[]) => loggerMock.log(...args),
  }),
}));

const {startMncTimers, startNyseTimers, startOtherTimers} = await import("../timers.ts");

type ScheduledJob = {
  callback: (...args: unknown[]) => unknown;
  rule: MockRecurrenceRule | Date;
  scheduledJob: {
    cancel: Mock;
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
  const send = vi.fn().mockResolvedValue(undefined);
  const channel = {send};
  const get = vi.fn(() => channel);
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
  const get = vi.fn(() => undefined);
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

  return scheduledJob;
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

  return earningsReminderJob;
}


export function resetTimerMocks() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-02-18T10:00:00-05:00"));
  vi.clearAllMocks();
  scheduledJobs.length = 0;

  scheduleJobMock.mockImplementation((rule: MockRecurrenceRule, callback: (...args: unknown[]) => unknown) => {
    const scheduledJob = {
      cancel: vi.fn(),
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
  addExpectedMovesToEarningsEventsMock.mockImplementation(async events => events);
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
  vi.useRealTimers();
}

export {
  addExpectedMovesToEarningsEventsMock,
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
