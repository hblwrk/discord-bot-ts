import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {
  attachmentBuilderMock,
  createClientWithChannel,
  createClientWithoutChannel,
  findMarketOpenSentimentPollMessageMock,
  getHolidaysMock,
  getMarketCloseRecapMock,
  getMncMock,
  getMncSummaryMock,
  getScheduledJobByTime,
  isHolidayMock,
  loggerMock,
  resetTimerMocks,
  restoreTimerMocks,
  scheduleJobMock,
  startMncTimers,
  startNyseTimers,
} from "./test-utils/timers.ts";

async function flushAsyncJobs() {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve();
  }
}

describe("timers: NYSE and MNC", () => {
  beforeEach(resetTimerMocks);
  afterEach(restoreTimerMocks);

  test("startNyseTimers registers NYSE jobs and sends regular pre-market announcement", () => {
    const {client, send} = createClientWithChannel();

    startNyseTimers(client, "channel-id");
    const premarketJob = getScheduledJobByTime(4, 0, "US/Eastern");

    expect(scheduleJobMock).toHaveBeenCalledTimes(10);
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

  test("startNyseTimers sends native opening sentiment poll and ends it two hours before regular close", async () => {
    const {client, send} = createClientWithChannel();
    const endPoll = vi.fn().mockResolvedValue(undefined);
    send.mockResolvedValueOnce({
      poll: {
        end: endPoll,
      },
    });

    startNyseTimers(client, "channel-id");
    const openJob = getScheduledJobByTime(9, 30, "US/Eastern");
    openJob.callback();
    await flushAsyncJobs();

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Der Börsenritt beginnt"),
      poll: expect.objectContaining({
        question: {
          text: "Opening Sentiment: Wie geht ihr in den Handel?",
        },
        answers: [
          {emoji: "🟢", text: "Risk-on"},
          {emoji: "🔴", text: "Risk-off"},
          {emoji: "💵", text: "Cash"},
          {emoji: "🎢", text: "Chaos"},
        ],
        duration: 5,
        allowMultiselect: false,
      }),
    }));

    const sentimentCloseJob = getScheduledJobByTime(14, 0, "US/Eastern");
    sentimentCloseJob.callback();
    await flushAsyncJobs();

    expect(endPoll).toHaveBeenCalledTimes(1);
  });

  test("startNyseTimers ends early-close opening sentiment poll two hours before early close", async () => {
    const {client, send} = createClientWithChannel();
    const endPoll = vi.fn().mockResolvedValue(undefined);
    vi.setSystemTime(new Date("2025-11-28T09:30:00-05:00"));
    send.mockResolvedValueOnce({
      poll: {
        end: endPoll,
      },
    });

    startNyseTimers(client, "channel-id");
    const openJob = getScheduledJobByTime(9, 30, "US/Eastern");
    openJob.callback();
    await flushAsyncJobs();

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      poll: expect.objectContaining({
        duration: 2,
      }),
    }));

    const sentimentCloseEarlyJob = getScheduledJobByTime(11, 0, "US/Eastern");
    sentimentCloseEarlyJob.callback();
    await flushAsyncJobs();

    expect(endPoll).toHaveBeenCalledTimes(1);
  });

  test("startNyseTimers sends holiday closed message on market holiday", () => {
    const {client, send} = createClientWithChannel();
    isHolidayMock.mockReturnValue(true);

    startNyseTimers(client, "channel-id");
    const premarketJob = getScheduledJobByTime(4, 0, "US/Eastern");
    premarketJob.callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Heute bleibt die Börse geschlossen"));
  });

  test("startNyseTimers sends Thanksgiving early-close reminder on the day after Thanksgiving", () => {
    const {client, send} = createClientWithChannel();
    vi.setSystemTime(new Date("2025-11-28T10:00:00-05:00"));

    startNyseTimers(client, "channel-id");
    const premarketJob = getScheduledJobByTime(4, 0, "US/Eastern");
    premarketJob.callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Tag nach dem Truthahn-Tag"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("19:00"));
  });

  test("startNyseTimers resolves Thanksgiving date based on the current US/Eastern year", () => {
    const {client, send} = createClientWithChannel();
    vi.setSystemTime(new Date("2025-12-30T10:00:00-05:00"));
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

    startNyseTimers(client, "channel-id");
    vi.setSystemTime(new Date("2026-11-27T10:00:00-05:00"));
    const premarketJob = getScheduledJobByTime(4, 0, "US/Eastern");
    premarketJob.callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Tag nach dem Truthahn-Tag"));
    expect(getHolidaysMock).toHaveBeenLastCalledWith(2026);
  });

  test("startNyseTimers treats holiday check by US/Eastern date for aftermarket close", () => {
    const {client, send} = createClientWithChannel();
    // 20:00 US/Eastern on 2025-12-25 equals 2025-12-26T01:00:00Z.
    vi.setSystemTime(new Date("2025-12-26T01:00:00Z"));
    isHolidayMock.mockImplementation(date => date.toDateString() === "Thu Dec 25 2025");

    startNyseTimers(client, "channel-id");
    const aftermarketJob = getScheduledJobByTime(20, 0, "US/Eastern");
    aftermarketJob.callback();

    expect(send).not.toHaveBeenCalled();
    expect(isHolidayMock).toHaveBeenCalledWith(expect.any(Date));
  });

  test("startNyseTimers points close announcement to Heutige Gains&Losses thread", () => {
    const {client, send} = createClientWithChannel();

    startNyseTimers(client, "channel-id", "thread-id");
    const closeJob = getScheduledJobByTime(16, 0, "US/Eastern");
    closeJob.callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("<#thread-id>"));
  });

  test("startNyseTimers posts optional market close recap with poll winners", async () => {
    const {client, send} = createClientWithChannel();
    const pollMessage = {
      poll: {
        question: {
          text: "Opening Sentiment: Wie geht ihr in den Handel?",
        },
      },
    };
    send.mockResolvedValueOnce(pollMessage);
    getMarketCloseRecapMock.mockResolvedValueOnce({
      allowedUserIds: ["123", "456"],
      content: "**Börsenschluss - Kurzüberblick**\n`VIX` fiel um `1,2 Punkte`.",
    });

    startNyseTimers(client, "channel-id");
    const openJob = getScheduledJobByTime(9, 30, "US/Eastern");
    openJob.callback();
    await flushAsyncJobs();

    const recapJob = getScheduledJobByTime(16, 10, "US/Eastern");
    await recapJob.callback();
    await flushAsyncJobs();

    expect(getMarketCloseRecapMock).toHaveBeenCalledWith(pollMessage, expect.objectContaining({
      logger: expect.any(Object),
    }), expect.objectContaining({
      date: expect.any(Date),
    }));
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      allowedMentions: {
        parse: [],
        users: ["123", "456"],
      },
      content: expect.stringContaining("Börsenschluss"),
    }));
  });

  test("startNyseTimers recovers the opening poll from history after a restart", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const channel = {
      messages: {
        fetch: vi.fn(),
      },
      send,
    };
    const client = {
      channels: {
        cache: {
          get: vi.fn(() => channel),
        },
      },
    };
    const recoveredPollMessage = {
      poll: {
        question: {
          text: "Opening Sentiment: Wie geht ihr in den Handel?",
        },
      },
    };
    findMarketOpenSentimentPollMessageMock.mockResolvedValueOnce(recoveredPollMessage);
    getMarketCloseRecapMock.mockResolvedValueOnce({
      allowedUserIds: [],
      content: "**Börsenschluss - Kurzüberblick**\n`VIX` stieg um `0,8 Punkte`.",
    });

    startNyseTimers(client, "channel-id");
    const recapJob = getScheduledJobByTime(16, 10, "US/Eastern");
    await recapJob.callback();
    await flushAsyncJobs();

    expect(findMarketOpenSentimentPollMessageMock).toHaveBeenCalledWith(channel, expect.objectContaining({
      logger: expect.any(Object),
    }), expect.objectContaining({
      date: expect.any(Date),
    }));
    expect(getMarketCloseRecapMock).toHaveBeenCalledWith(recoveredPollMessage, expect.any(Object), expect.any(Object));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Börsenschluss"),
    }));
  });

  test("startNyseTimers skips announcement when channel is missing", () => {
    const {client} = createClientWithoutChannel();

    startNyseTimers(client, "channel-id");
    const premarketJob = getScheduledJobByTime(4, 0, "US/Eastern");

    premarketJob.callback();

    expect(loggerMock.log).toHaveBeenCalledWith("error", expect.stringContaining("Skipping NYSE announcement"));
  });

  test("startMncTimers schedules MNC announcement and sends attachment payload", async () => {
    const {client, send} = createClientWithChannel();

    startMncTimers(client, "channel-id");
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
    expect(getMncSummaryMock).toHaveBeenCalledWith(Buffer.from("mnc-pdf"), expect.objectContaining({
      logger: expect.any(Object),
    }));
    expect(attachmentBuilderMock).toHaveBeenCalledWith(Buffer.from("mnc-pdf"), expect.objectContaining({
      name: expect.stringMatching(/^MNC-\d{4}-\d{2}-\d{2}\.pdf$/),
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("📰 Morning News Call"),
      files: expect.any(Array),
    }));
  });

  test("startMncTimers includes an AI summary when available", async () => {
    const {client, send} = createClientWithChannel();
    getMncSummaryMock.mockResolvedValueOnce("**Morning News Call - TL;DR**\n- Futures firm ahead of payrolls.");

    startMncTimers(client, "channel-id");
    const mncJob = getScheduledJobByTime(9, 0, "US/Eastern");

    await mncJob.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("📰 Morning News Call"),
      files: expect.any(Array),
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("**Morning News Call - TL;DR**"),
      files: expect.any(Array),
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.not.stringContaining("📰 **Morning News Call - TL;DR**"),
      files: expect.any(Array),
    }));
  });

  test("startMncTimers skips announcement when no MNC file was downloaded", async () => {
    const {client, send} = createClientWithChannel();
    getMncMock.mockResolvedValueOnce(undefined);

    startMncTimers(client, "channel-id");
    const mncJob = getScheduledJobByTime(9, 0, "US/Eastern");
    await mncJob.callback();

    expect(attachmentBuilderMock).not.toHaveBeenCalled();
    expect(getMncSummaryMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(loggerMock.log).toHaveBeenCalledWith("warn", "Skipping MNC announcement: no file downloaded.");
  });

  test("startMncTimers skips announcement on market holiday", async () => {
    const {client, send} = createClientWithChannel();
    isHolidayMock.mockReturnValue(true);

    startMncTimers(client, "channel-id");
    const mncJob = getScheduledJobByTime(9, 0, "US/Eastern");
    await mncJob.callback();

    expect(getMncMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(loggerMock.log).toHaveBeenCalledWith("info", "Skipping MNC announcement: market holiday.");
  });

  test("startMncTimers logs and skips when channel is missing", async () => {
    const {client} = createClientWithoutChannel();

    startMncTimers(client, "channel-id");
    const mncJob = getScheduledJobByTime(9, 0, "US/Eastern");
    await mncJob.callback();

    expect(loggerMock.log).toHaveBeenCalledWith("error", expect.stringContaining("Skipping MNC announcement"));
  });
});
