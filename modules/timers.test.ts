import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";
import {
  attachmentBuilderMock,
  createClientWithChannel,
  createClientWithoutChannel,
  findMarketOpenSentimentPollMessageMock,
  getMarketCloseRecapMock,
  getMncMock,
  getMncSummaryMock,
  getPremarketWarmupMessageMock,
  getScheduledJobByTime,
  isEarlyCloseMock,
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

  test("startNyseTimers registers NYSE jobs and stays silent on a regular trading morning", () => {
    const {client, send} = createClientWithChannel();

    startNyseTimers(client, "channel-id");
    const morningNoticeJob = getScheduledJobByTime(4, 0, "US/Eastern");

    expect(scheduleJobMock).toHaveBeenCalledTimes(11);
    expect(morningNoticeJob.rule).toEqual(expect.objectContaining({
      hour: 4,
      minute: 0,
      tz: "US/Eastern",
    }));
    expect(morningNoticeJob.rule.dayOfWeek).toEqual([expect.objectContaining({start: 1, end: 5})]);
    expect(getScheduledJobByTime(20, 0, "US/Eastern").rule.dayOfWeek).toEqual([expect.objectContaining({start: 1, end: 5})]);
    expect(getScheduledJobByTime(21, 0, "US/Eastern").rule.dayOfWeek).toEqual([expect.objectContaining({start: 0, end: 4})]);

    morningNoticeJob.callback();

    expect(send).not.toHaveBeenCalled();
    expect(isHolidayMock).toHaveBeenCalledWith("2025-02-18");
  });

  test("startNyseTimers announces the daily pause at 20:00 US/Eastern", () => {
    const {client, send} = createClientWithChannel();
    vi.setSystemTime(new Date("2025-02-18T20:00:00-05:00"));

    startNyseTimers(client, "channel-id");
    getScheduledJobByTime(20, 0, "US/Eastern").callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Verschnaufpause"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("21:00 US/Eastern / 03:00 Europe/Berlin"));
  });

  test("startNyseTimers announces the weekend close on Friday at 20:00 US/Eastern", () => {
    const {client, send} = createClientWithChannel();
    vi.setSystemTime(new Date("2025-02-21T20:00:00-05:00"));

    startNyseTimers(client, "channel-id");
    getScheduledJobByTime(20, 0, "US/Eastern").callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("schönes Wochenende"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Sonntag um 21:00 US/Eastern"));
  });

  test("startNyseTimers announces the resume at 21:00 US/Eastern", () => {
    const {client, send} = createClientWithChannel();
    vi.setSystemTime(new Date("2025-02-18T21:00:00-05:00"));

    startNyseTimers(client, "channel-id");
    getScheduledJobByTime(21, 0, "US/Eastern").callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Pause vorbei"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Handelstag Mittwoch, 19. Februar"));
  });

  test("startNyseTimers stays silent at 21:00 US/Eastern before a market holiday", () => {
    const {client, send} = createClientWithChannel();
    // 21:00 US/Eastern on 2025-12-24 precedes the Christmas holiday.
    vi.setSystemTime(new Date("2025-12-24T21:00:00-05:00"));
    isHolidayMock.mockImplementation(date => "2025-12-25" === date);

    startNyseTimers(client, "channel-id");
    getScheduledJobByTime(21, 0, "US/Eastern").callback();

    expect(send).not.toHaveBeenCalled();
  });

  test("startNyseTimers sends separate AI pre-market warmup before the regular open", async () => {
    const {client, send} = createClientWithChannel();

    startNyseTimers(client, "channel-id");
    const warmupJob = getScheduledJobByTime(9, 15, "US/Eastern");
    await warmupJob.callback();
    await flushAsyncJobs();

    expect(getPremarketWarmupMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      logger: expect.any(Object),
    }));
    expect(send).toHaveBeenCalledWith({
      allowedMentions: {
        parse: [],
      },
      content: "**Pre-Market Warmup**\n`ES +0,42%` und alle tun wieder normal.",
    });
  });

  test("startNyseTimers skips AI pre-market warmup on market holidays", async () => {
    const {client, send} = createClientWithChannel();
    isHolidayMock.mockReturnValue(true);

    startNyseTimers(client, "channel-id");
    const warmupJob = getScheduledJobByTime(9, 15, "US/Eastern");
    await warmupJob.callback();
    await flushAsyncJobs();

    expect(getPremarketWarmupMessageMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
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
    isEarlyCloseMock.mockImplementation(date => "2025-11-28" === date
      ? {date, name: "Day after Thanksgiving", closeTimeET: "13:00"}
      : null);
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
    isEarlyCloseMock.mockImplementation(date => "2025-11-28" === date
      ? {date, name: "Day after Thanksgiving", closeTimeET: "13:00"}
      : null);

    startNyseTimers(client, "channel-id");
    const premarketJob = getScheduledJobByTime(4, 0, "US/Eastern");
    premarketJob.callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Tag nach dem Truthahn-Tag"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("19:00"));
  });

  test("startNyseTimers handles Christmas Eve as an early-close day", () => {
    const {client, send} = createClientWithChannel();
    vi.setSystemTime(new Date("2026-12-24T10:00:00-05:00"));
    isEarlyCloseMock.mockImplementation(date => "2026-12-24" === date
      ? {date, name: "Christmas Eve (early close)", closeTimeET: "13:00"}
      : null);

    startNyseTimers(client, "channel-id");
    getScheduledJobByTime(4, 0, "US/Eastern").callback();

    expect(send).toHaveBeenCalledWith(expect.stringContaining("verkürzter Handelstag"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("19:00"));
    expect(send).not.toHaveBeenCalledWith(expect.stringContaining("Truthahn"));

    send.mockClear();
    getScheduledJobByTime(16, 0, "US/Eastern").callback();
    expect(send).not.toHaveBeenCalled();

    getScheduledJobByTime(13, 0, "US/Eastern").callback();
    expect(send).toHaveBeenCalledWith(expect.stringContaining("die Börsen sind zu"));
  });

  test("startNyseTimers treats holiday check by US/Eastern date for the evening close", () => {
    const {client, send} = createClientWithChannel();
    // 20:00 US/Eastern on 2025-12-25 equals 2025-12-26T01:00:00Z.
    vi.setSystemTime(new Date("2025-12-26T01:00:00Z"));
    isHolidayMock.mockImplementation(date => "2025-12-25" === date);

    startNyseTimers(client, "channel-id");
    const eveningCloseJob = getScheduledJobByTime(20, 0, "US/Eastern");
    eveningCloseJob.callback();

    expect(send).not.toHaveBeenCalled();
    expect(isHolidayMock).toHaveBeenCalledWith("2025-12-25");
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

  test("startNyseTimers prefers recovered closed poll for market close recap", async () => {
    const {client, send} = createClientWithChannel();
    const stalePollMessage = {
      poll: {
        question: {
          text: "Opening Sentiment: Wie geht ihr in den Handel?",
        },
      },
    };
    const recoveredPollMessage = {
      poll: {
        answers: new Map([
          [1, {id: 1, text: "Risk-on"}],
        ]),
        question: {
          text: "Opening Sentiment: Wie geht ihr in den Handel?",
        },
      },
    };
    send.mockResolvedValueOnce(stalePollMessage);
    findMarketOpenSentimentPollMessageMock.mockResolvedValueOnce(recoveredPollMessage);
    getMarketCloseRecapMock.mockResolvedValueOnce({
      allowedUserIds: [],
      content: "**Börsenschluss - Kurzüberblick**\n`VIX` fiel um `1,2 Punkte`.",
    });

    startNyseTimers(client, "channel-id");
    const openJob = getScheduledJobByTime(9, 30, "US/Eastern");
    openJob.callback();
    await flushAsyncJobs();

    const recapJob = getScheduledJobByTime(16, 10, "US/Eastern");
    await recapJob.callback();
    await flushAsyncJobs();

    expect(getMarketCloseRecapMock).toHaveBeenCalledWith(recoveredPollMessage, expect.any(Object), expect.any(Object));
    expect(getMarketCloseRecapMock).not.toHaveBeenCalledWith(stalePollMessage, expect.any(Object), expect.any(Object));
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
    const closeJob = getScheduledJobByTime(16, 0, "US/Eastern");

    closeJob.callback();

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
      content: expect.stringContaining("📰 **Morning News Call"),
      files: expect.any(Array),
    }));
  });

  test("startMncTimers includes an AI summary when available", async () => {
    const {client, send} = createClientWithChannel();
    getMncSummaryMock.mockResolvedValueOnce("- Futures firm ahead of payrolls.");

    startMncTimers(client, "channel-id");
    const mncJob = getScheduledJobByTime(9, 0, "US/Eastern");

    await mncJob.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("📰 **Morning News Call"),
      files: expect.any(Array),
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.not.stringContaining("\n\n- Futures firm ahead of payrolls."),
      files: expect.any(Array),
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("- Futures firm ahead of payrolls."),
      files: expect.any(Array),
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.not.stringContaining("**Morning News Call - TL;DR**"),
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
