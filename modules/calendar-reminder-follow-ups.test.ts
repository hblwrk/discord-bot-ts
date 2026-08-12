import moment from "moment-timezone";
import type Schedule from "node-schedule";
import {describe, expect, test, vi} from "vitest";
import {CalendarReminderAsset} from "./assets.ts";
import {createCalendarReminderFollowUpCoordinator} from "./calendar-reminder-follow-ups.ts";
import {CalendarEvent} from "./calendar.ts";
import {buildCalendarReminderEmbed, getCalendarReminderContent} from "./timer-reminders.ts";

type ScheduledInvocation = {
  callback: () => void | Promise<void>;
  rule: Date | Schedule.RecurrenceRule;
};

function createCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const event = new CalendarEvent();
  event.actualValue = "";
  event.country = "🇺🇸";
  event.date = "2026-08-12";
  event.forecastValue = "2.7%";
  event.name = "CPI y/y";
  event.previousValue = "3.5%";
  event.sourceEventId = "cpi-yy";
  event.time = "14:30";
  Object.assign(event, overrides);
  return event;
}

function createReminderAsset(overrides: Partial<CalendarReminderAsset> = {}): CalendarReminderAsset {
  const asset = new CalendarReminderAsset();
  asset.countryFlags = ["🇺🇸"];
  asset.eventNameSubstrings = ["cpi"];
  asset.name = "us-cpi";
  asset.roleId = "alerts-role";
  Object.assign(asset, overrides);
  return asset;
}

function createHistoryMessage(event: CalendarEvent, options: {legacyFooter?: boolean} = {}) {
  const embed = buildCalendarReminderEmbed("update", [event]).data;
  const footerText = true === options.legacyFooter
    ? `🕒 ${event.time}`
    : embed.footer?.text;
  return {
    author: {id: "bot-user"},
    content: getCalendarReminderContent("alerts-role", "update"),
    createdAt: new Date("2026-08-12T12:31:00.000Z"),
    embeds: [{
      footer: {text: footerText},
      title: embed.title,
    }],
  };
}

function createFixture({
  assets = [createReminderAsset()],
  events = [],
  now = "2026-08-12T13:00:00+02:00",
}: {
  assets?: CalendarReminderAsset[];
  events?: CalendarEvent[];
  now?: string;
} = {}) {
  let currentTime = moment.parseZone(now).tz("Europe/Berlin");
  const scheduledInvocations: ScheduledInvocation[] = [];
  const send = vi.fn().mockResolvedValue({id: "sent-message"});
  const fetchHistory = vi.fn().mockResolvedValue(new Map());
  const getCalendarEventsResult = vi.fn().mockResolvedValue({
    events,
    status: "ok" as const,
  });
  const getCalendarOfficialSummary = vi.fn().mockResolvedValue(undefined);
  const logger = {log: vi.fn()};
  const channel = {
    messages: {fetch: fetchHistory},
    send,
  };
  const client = {
    channels: {
      cache: {
        get: vi.fn(() => channel),
      },
    },
    user: {id: "bot-user"},
  };
  const coordinator = createCalendarReminderFollowUpCoordinator({
    assets,
    channelId: "macro-channel",
    client,
    dependencies: {
      getCalendarEventsResultFn: getCalendarEventsResult,
      getCalendarOfficialSummaryFn: getCalendarOfficialSummary,
      nowFn: () => currentTime.clone(),
      scheduleJobFn: (rule, callback) => {
        scheduledInvocations.push({callback, rule});
        return {cancel: vi.fn()} as unknown as Schedule.Job;
      },
    },
    logger,
  });

  return {
    coordinator,
    fetchHistory,
    getCalendarEventsResult,
    getCalendarOfficialSummary,
    logger,
    scheduledInvocations,
    send,
    setNow: (nextNow: string) => {
      currentTime = moment.parseZone(nextNow).tz("Europe/Berlin");
    },
  };
}

function getDateInvocations(coordinatorFixture: ReturnType<typeof createFixture>): ScheduledInvocation[] {
  return coordinatorFixture.scheduledInvocations.filter(invocation => invocation.rule instanceof Date);
}

async function runInvocation(invocation: ScheduledInvocation | undefined) {
  if (undefined === invocation) {
    throw new Error("Expected a scheduled invocation.");
  }

  await invocation.callback();
}

describe("calendar reminder follow-up coordinator", () => {
  test("reconstructs every remaining release poll after a restart before the release", async () => {
    const event = createCalendarEvent();
    const fixture = createFixture({
      events: [event],
      now: "2026-08-12T13:59:00+02:00",
    });

    await fixture.coordinator.reconcile("startup");

    expect(getDateInvocations(fixture).map(invocation => (invocation.rule as Date).toISOString())).toEqual([
      "2026-08-12T12:30:05.000Z",
      "2026-08-12T12:30:10.000Z",
      "2026-08-12T12:30:20.000Z",
      "2026-08-12T12:30:30.000Z",
      "2026-08-12T12:31:00.000Z",
      "2026-08-12T12:32:00.000Z",
      "2026-08-12T12:33:00.000Z",
      "2026-08-12T12:35:00.000Z",
      "2026-08-12T12:40:00.000Z",
      "2026-08-12T12:45:00.000Z",
    ]);
    expect(fixture.send).not.toHaveBeenCalled();
  });

  test("recovers a released numeric event after the immediate polling window", async () => {
    const releasedEvent = createCalendarEvent({actualValue: "3.4%"});
    const fixture = createFixture({
      events: [releasedEvent],
      now: "2026-08-12T16:00:00+02:00",
    });

    await fixture.coordinator.reconcile("startup");
    await fixture.coordinator.reconcile("periodic");

    expect(fixture.fetchHistory).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({
      content: "<@&alerts-role> Update",
    }));
  });

  test("uses Discord history as the delivery record across restarts", async () => {
    const releasedEvent = createCalendarEvent({actualValue: "3.4%"});
    const fixture = createFixture({
      events: [releasedEvent],
      now: "2026-08-12T14:32:00+02:00",
    });
    fixture.fetchHistory.mockResolvedValueOnce(new Map([
      ["existing", createHistoryMessage(releasedEvent)],
    ]));

    await fixture.coordinator.reconcile("startup");

    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.logger.log).toHaveBeenCalledWith("info", expect.objectContaining({
      state: "already-posted",
    }));
  });

  test("recognizes legacy updates without a date in the footer", async () => {
    const releasedEvent = createCalendarEvent({actualValue: "3.4%"});
    const fixture = createFixture({
      events: [releasedEvent],
      now: "2026-08-12T14:32:00+02:00",
    });
    fixture.fetchHistory.mockResolvedValueOnce(new Map([
      ["existing", createHistoryMessage(releasedEvent, {legacyFooter: true})],
    ]));

    await fixture.coordinator.reconcile("startup");

    expect(fixture.send).not.toHaveBeenCalled();
  });

  test("posts when history is unavailable instead of silently dropping a release", async () => {
    const releasedEvent = createCalendarEvent({actualValue: "3.4%"});
    const fixture = createFixture({
      events: [releasedEvent],
      now: "2026-08-12T14:32:00+02:00",
    });
    fixture.fetchHistory.mockRejectedValueOnce(new Error("missing permission"));

    await fixture.coordinator.reconcile("startup");

    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.logger.log).toHaveBeenCalledWith("warn", expect.stringContaining("message history"));
  });

  test("does not duplicate an ambiguously failed send that appears in history", async () => {
    const releasedEvent = createCalendarEvent({actualValue: "3.4%"});
    const fixture = createFixture({
      events: [releasedEvent],
      now: "2026-08-12T14:32:00+02:00",
    });
    fixture.fetchHistory
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([
        ["accepted", createHistoryMessage(releasedEvent)],
      ]));
    fixture.send.mockRejectedValueOnce(new Error("response lost"));

    await fixture.coordinator.reconcile("startup");
    await fixture.coordinator.reconcile("periodic");

    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.logger.log).toHaveBeenCalledWith("info", expect.objectContaining({
      state: "already-posted",
    }));
  });

  test("tracks a provider event id when the release is rescheduled", async () => {
    const originalEvent = createCalendarEvent();
    const rescheduledEvent = createCalendarEvent({time: "15:00"});
    const fixture = createFixture({now: "2026-08-12T13:00:00+02:00"});
    fixture.getCalendarEventsResult.mockResolvedValue({
      events: [rescheduledEvent],
      status: "ok",
    });
    fixture.coordinator.scheduleGroups([{
      asset: createReminderAsset(),
      events: [originalEvent],
    }]);
    fixture.setNow("2026-08-12T14:30:05+02:00");

    await runInvocation(getDateInvocations(fixture)[0]);

    const scheduledTimes = getDateInvocations(fixture).map(invocation => (invocation.rule as Date).toISOString());
    expect(scheduledTimes).toContain("2026-08-12T13:00:05.000Z");
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.logger.log).toHaveBeenCalledWith("info", expect.objectContaining({
      state: "rescheduled",
    }));
  });

  test("recovers text-only releases through the same generic path", async () => {
    const fomcEvent = createCalendarEvent({
      forecastValue: "",
      name: "FOMC Statement",
      previousValue: "",
      sourceEventId: "fomc-statement",
      time: "20:00",
    });
    const fixture = createFixture({
      assets: [createReminderAsset({
        eventNameSubstrings: ["fomc statement"],
        name: "us-fomc",
      })],
      events: [fomcEvent],
      now: "2026-08-12T20:30:00+02:00",
    });
    fixture.getCalendarOfficialSummary.mockResolvedValueOnce({
      name: "Federal Reserve",
      summaryMarkdown: "The statement keeps policy unchanged.",
      url: "https://www.federalreserve.gov/example",
    });

    await fixture.coordinator.reconcile("periodic");

    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({
      content: "<@&alerts-role> Update",
    }));
  });

  test("retries unresolved releases on later reconciliation", async () => {
    const pendingEvent = createCalendarEvent();
    const releasedEvent = createCalendarEvent({actualValue: "3.4%"});
    const fixture = createFixture({
      events: [pendingEvent],
      now: "2026-08-12T15:30:00+02:00",
    });

    await fixture.coordinator.reconcile("startup");
    fixture.getCalendarEventsResult.mockResolvedValue({
      events: [releasedEvent],
      status: "ok",
    });
    await fixture.coordinator.reconcile("periodic");

    expect(fixture.send).toHaveBeenCalledTimes(1);
  });

  test("handles multiple configured release types without event-specific code", async () => {
    const cpiEvent = createCalendarEvent({actualValue: "3.4%"});
    const ppiEvent = createCalendarEvent({
      actualValue: "2.1%",
      name: "PPI y/y",
      sourceEventId: "ppi-yy",
    });
    const fixture = createFixture({
      assets: [
        createReminderAsset(),
        createReminderAsset({
          eventNameSubstrings: ["ppi"],
          name: "us-ppi",
        }),
      ],
      events: [cpiEvent, ppiEvent],
      now: "2026-08-12T15:00:00+02:00",
    });

    await fixture.coordinator.reconcile("startup");

    expect(fixture.fetchHistory).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledTimes(2);
  });

  test("does not post events outside the bounded recovery horizon", async () => {
    const oldEvent = createCalendarEvent({
      actualValue: "3.4%",
      date: "2026-08-11",
    });
    const fixture = createFixture({
      events: [oldEvent],
      now: "2026-08-12T15:00:01+02:00",
    });

    await fixture.coordinator.reconcile("startup");

    expect(fixture.fetchHistory).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.logger.log).toHaveBeenCalledWith("info", expect.objectContaining({
      state: "expired",
    }));
  });

  test("keeps calendar load failures retryable", async () => {
    const fixture = createFixture();
    fixture.getCalendarEventsResult.mockResolvedValueOnce({
      events: [],
      status: "error",
    });

    await fixture.coordinator.reconcile("periodic");

    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.logger.log).toHaveBeenCalledWith("warn", expect.objectContaining({
      state: "calendar-load-error",
    }));
  });

  test("starts a storage-free periodic reconciliation job", () => {
    const fixture = createFixture();

    fixture.coordinator.start();

    const recurrence = fixture.scheduledInvocations.find(invocation => false === (invocation.rule instanceof Date));
    expect(recurrence?.rule).toEqual(expect.objectContaining({
      hour: expect.objectContaining({start: 8, end: 23}),
      minute: [0, 30],
      tz: "Europe/Berlin",
    }));
  });
});
