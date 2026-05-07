import {beforeEach, describe, expect, test, vi} from "vitest";
import {clearAiProviderState} from "./ai-provider.ts";
import {
  findMarketOpenSentimentPollMessage,
  getMarketCloseRecap,
} from "./market-close-recap.ts";
import {type MarketCloseTickerFact} from "./market-close-ticker-facts.ts";

describe("market close recap", () => {
  const logger = {
    log: vi.fn(),
  };
  const readSecretFn = vi.fn((secretName: string) => {
    if ("gemini_api_key" === secretName) {
      return "gemini-key";
    }

    throw new Error(`missing ${secretName}`);
  });
  const validRecapJson = {
    sentimentTitle: "ruhiger Risikoappetit",
    summaryMarkdown: "`SPX` schloss über dem Open. Der `VIX` fiel um `1,1 Punkte`.",
    winningPollAnswer: "Risk-on",
  };
  const riskOnTickerFacts = [{
    close: 5225,
    closeChange: 25,
    closeChangePercent: 0.48,
    date: "2026-05-07",
    high: 5230,
    low: 5175,
    open: 5190,
    openToCloseChange: 35,
    openToCloseChangePercent: 0.67,
    previousClose: 5200,
    sourceSymbol: "^GSPC",
    symbol: "SPX",
  }, {
    close: 18750,
    closeChange: 90,
    closeChangePercent: 0.48,
    date: "2026-05-07",
    high: 18780,
    low: 18550,
    open: 18610,
    openToCloseChange: 140,
    openToCloseChangePercent: 0.75,
    previousClose: 18660,
    sourceSymbol: "^NDX",
    symbol: "NQ",
  }, {
    close: 2095,
    closeChange: 15,
    closeChangePercent: 0.72,
    date: "2026-05-07",
    high: 2100,
    low: 2070,
    open: 2080,
    openToCloseChange: 15,
    openToCloseChangePercent: 0.72,
    previousClose: 2080,
    sourceSymbol: "^RUT",
    symbol: "RTY",
  }, {
    close: 17.1,
    closeChange: -0.4,
    closeChangePercent: -2.29,
    date: "2026-05-07",
    high: 17.7,
    low: 16.9,
    open: 17.4,
    openToCloseChange: -0.3,
    openToCloseChangePercent: -1.72,
    previousClose: 17.5,
    sourceSymbol: "^VIX",
    symbol: "VIX",
  }] satisfies MarketCloseTickerFact[];
  const weakTickerFacts = [{
    close: 5110,
    closeChange: -80,
    closeChangePercent: -1.54,
    date: "2026-05-07",
    high: 5220,
    low: 5100,
    open: 5200,
    openToCloseChange: -90,
    openToCloseChangePercent: -1.73,
    previousClose: 5190,
    sourceSymbol: "^GSPC",
    symbol: "SPX",
  }, {
    close: 18280,
    closeChange: -180,
    closeChangePercent: -0.98,
    date: "2026-05-07",
    high: 18620,
    low: 18230,
    open: 18570,
    openToCloseChange: -290,
    openToCloseChangePercent: -1.56,
    previousClose: 18460,
    sourceSymbol: "^NDX",
    symbol: "NQ",
  }, {
    close: 2035,
    closeChange: -40,
    closeChangePercent: -1.93,
    date: "2026-05-07",
    high: 2088,
    low: 2025,
    open: 2070,
    openToCloseChange: -35,
    openToCloseChangePercent: -1.69,
    previousClose: 2075,
    sourceSymbol: "^RUT",
    symbol: "RTY",
  }, {
    close: 17.39,
    closeChange: 0.01,
    closeChangePercent: 0.06,
    date: "2026-05-07",
    high: 18.2,
    low: 17.1,
    open: 17.38,
    openToCloseChange: 0.01,
    openToCloseChangePercent: 0.06,
    previousClose: 17.38,
    sourceSymbol: "^VIX",
    symbol: "VIX",
  }] satisfies MarketCloseTickerFact[];

  function createPostWithRecap(overrides: Record<string, unknown> = {}) {
    return vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                ...validRecapJson,
                ...overrides,
              }),
            }],
          },
        }],
      },
    });
  }

  function createYahooChartResponse(
    previousTimestamp: number,
    targetTimestamp: number,
    previousClose: number,
    open: number,
    high: number,
    low: number,
    close: number,
  ) {
    return {
      data: {
        chart: {
          result: [{
            indicators: {
              quote: [{
                close: [previousClose, close],
                high: [previousClose, high],
                low: [previousClose, low],
                open: [previousClose, open],
              }],
            },
            timestamp: [previousTimestamp, targetTimestamp],
          }],
        },
      },
    };
  }

  function createPollMessage(answerText: string, fetch: ReturnType<typeof vi.fn>) {
    return {
      poll: {
        answers: new Map([
          [1, {id: 1, text: answerText, voters: {fetch}}],
        ]),
        question: {
          text: "Opening Sentiment: Wie geht ihr in den Handel?",
        },
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearAiProviderState();
  });

  test("generates a German grounded close recap and mentions voters who picked the matching sentiment", async () => {
    const chaosVotersFetch = vi.fn().mockResolvedValue(new Map([
      ["123", {id: "123"}],
      ["456", {id: "456"}],
    ]));
    const pollMessage = {
      poll: {
        answers: new Map([
          [1, {id: 1, text: "Risk-on", voters: {fetch: vi.fn()}}],
          [2, {id: 2, text: "Risk-off", voters: {fetch: vi.fn()}}],
          [3, {id: 3, text: "Cash", voters: {fetch: vi.fn()}}],
          [4, {id: 4, text: "Chaos", voters: {fetch: chaosVotersFetch}}],
        ]),
        question: {
          text: "Opening Sentiment: Wie geht ihr in den Handel?",
        },
      },
    };
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                sentimentTitle: "wildes Hin und Her mit bullischem Finish",
                summaryMarkdown: [
                  "`SPX` und `RTY` schlossen über dem Open, während `NQ` nur knapp behauptet war.",
                  "Der `VIX` fiel von `19,2` auf `17,8` und damit um `1,4 Punkte`.",
                ].join("\n"),
                winningPollAnswer: "Chaos",
              }),
            }],
          },
        }],
      },
    });

    const recap = await getMarketCloseRecap(pollMessage, {
      logger,
      postWithRetryFn,
      readSecretFn,
    }, {
      date: new Date("2026-05-05T20:10:00Z"),
    });

    expect(recap).toEqual({
      allowedUserIds: ["123", "456"],
      content: expect.stringContaining("**Börsenschluss - Kurzüberblick**"),
    });
    expect(recap?.content).toContain("**Börsenschluss - Kurzüberblick**\n`SPX`");
    expect(recap?.content).not.toContain("**Börsenschluss - Kurzüberblick**\n\n");
    expect(recap?.content).toContain("Das heutige Sentiment war: **🎢 Chaos**");
    expect(recap?.content).toContain("<@123> <@456>");
    expect(recap?.content).not.toContain("Gemini");
    expect(recap?.content).not.toContain("GPT");
    expect(chaosVotersFetch).toHaveBeenCalledWith({
      limit: 100,
    });
    expect(postWithRetryFn).toHaveBeenCalledWith(
      expect.stringContaining("gemini-2.5-flash-lite:generateContent"),
      expect.objectContaining({
        tools: [{
          google_search: {},
        }],
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-goog-api-key": "gemini-key",
        }),
      }),
      expect.objectContaining({
        timeoutMs: 45_000,
      }),
    );
    const requestBody = postWithRetryFn.mock.calls[0]?.[1] as {contents?: {parts?: {text?: string}[]}[]};
    expect(requestBody.contents?.[0]?.parts?.[0]?.text).toContain("Der `VIX` darf niemals als Prozentwert beschrieben werden.");
    expect(requestBody.contents?.[0]?.parts?.[0]?.text).toContain("Reuters, Bloomberg, CNBC, MarketWatch, WSJ, Nasdaq, NYSE, Cboe und S&P Dow Jones Indices");
  });

  test("grounds the close recap prompt with ticker facts when available", async () => {
    const postWithRetryFn = createPostWithRecap();

    const recap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn,
      readSecretFn,
    }, {
      date: new Date("2026-05-07T20:15:00Z"),
      tickerFacts: riskOnTickerFacts,
    });

    expect(recap?.content).toContain("Das heutige Sentiment war: **🟢 Risk-on**");
    const requestBody = postWithRetryFn.mock.calls[0]?.[1] as {contents?: {parts?: {text?: string}[]}[]};
    const prompt = requestBody.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(prompt).toContain("Verifizierte Ticker-Daten aus Daily-Bars fuer den Zieltag:");
    expect(prompt).toContain("`SPX` (^GSPC); Open `5.190,00`; High `5.230,00`; Low `5.175,00`; Close `5.225,00`");
    expect(prompt).toContain("Diese Ticker-Daten haben Vorrang vor News-Texten");
    expect(prompt).toContain("Behaupte keine Schlusskurs-Rekorde");
  });

  test("loads daily ticker bars before asking the AI provider", async () => {
    const postWithRetryFn = createPostWithRecap();
    const previousTimestamp = Date.parse("2026-05-06T13:30:00Z") / 1000;
    const targetTimestamp = Date.parse("2026-05-07T13:30:00Z") / 1000;
    const getWithRetryFn = vi.fn()
      .mockResolvedValueOnce(createYahooChartResponse(previousTimestamp, targetTimestamp, 5200, 5190, 5230, 5175, 5225))
      .mockResolvedValueOnce(createYahooChartResponse(previousTimestamp, targetTimestamp, 18660, 18610, 18780, 18550, 18750))
      .mockResolvedValueOnce(createYahooChartResponse(previousTimestamp, targetTimestamp, 2080, 2080, 2100, 2070, 2095))
      .mockResolvedValueOnce(createYahooChartResponse(previousTimestamp, targetTimestamp, 17.5, 17.4, 17.7, 16.9, 17.1));

    await getMarketCloseRecap(undefined, {
      getWithRetryFn,
      logger,
      postWithRetryFn,
      readSecretFn,
    }, {
      date: new Date("2026-05-07T20:15:00Z"),
    });

    expect(getWithRetryFn).toHaveBeenCalledTimes(4);
    expect(getWithRetryFn).toHaveBeenCalledWith(
      expect.stringContaining("/%5EGSPC?"),
      undefined,
      expect.objectContaining({
        maxAttempts: 2,
        timeoutMs: 8_000,
      }),
    );
    const requestBody = postWithRetryFn.mock.calls[0]?.[1] as {contents?: {parts?: {text?: string}[]}[]};
    expect(requestBody.contents?.[0]?.parts?.[0]?.text).toContain("Close-to-close `+0,48%`");
  });

  test("rejects stale bullish close-high claims that contradict ticker facts", async () => {
    const recap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn: createPostWithRecap({
        sentimentTitle: "breiter Risikoappetit bis zum Schluss",
        summaryMarkdown: [
          "`SPX` und `NQ` zogen bis zum regulären Close auf neue Hochs, `RTY` lief mit.",
          "Der `VIX` stand praktisch seitwärts bei `17,39` und änderte sich um `+0,01 Punkte`.",
        ].join("\n"),
        winningPollAnswer: "Risk-on",
      }),
      readSecretFn,
    }, {
      date: new Date("2026-05-07T20:15:00Z"),
      tickerFacts: weakTickerFacts,
    });

    expect(recap).toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI market close recap contradicted ticker facts: output claimed closing highs not supported by ticker facts.",
    );
  });

  test("stays disabled when the active provider API key is missing", async () => {
    const postWithRetryFn = vi.fn();

    const recap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn,
      readSecretFn: vi.fn(() => {
        throw new Error("missing secret");
      }),
    });

    expect(recap).toBeUndefined();
    expect(postWithRetryFn).not.toHaveBeenCalled();
  });

  test("omits voter mentions when no poll can be recovered", async () => {
    const recap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn: createPostWithRecap(),
      readSecretFn,
    });

    expect(recap?.allowedUserIds).toEqual([]);
    expect(recap?.content).toContain("Das heutige Sentiment war: **🟢 Risk-on**");
    expect(recap?.content).not.toContain("Richtig gelegen");
    expect(recap?.content).not.toContain("Punkte`.\n\nDas heutige");
  });

  test("matches Discord poll answer text variants when fetching voters", async () => {
    const votersFetch = vi.fn().mockResolvedValue(new Map([
      ["123", {id: "123"}],
    ]));

    const recap = await getMarketCloseRecap({
      poll: {
        answers: [{
          answer_id: 1,
          poll_media: {
            text: "🟢 Risk‑on",
          },
          voters: {
            fetch: votersFetch,
          },
        }],
      },
    }, {
      logger,
      postWithRetryFn: createPostWithRecap(),
      readSecretFn,
    });

    expect(recap?.allowedUserIds).toEqual(["123"]);
    expect(votersFetch).toHaveBeenCalledWith({
      limit: 100,
    });
  });

  test("matches hydrated Discord poll answer media and camelCase answer ids", async () => {
    const mediaVotersFetch = vi.fn().mockResolvedValue(new Map([
      ["789", {id: "789"}],
    ]));

    const mediaRecap = await getMarketCloseRecap({
      poll: {
        answers: [{
          answerId: 1,
          pollMedia: {
            text: "🟢 Risk-on",
          },
          voters: {
            fetch: mediaVotersFetch,
          },
        }],
      },
    }, {
      logger,
      postWithRetryFn: createPostWithRecap(),
      readSecretFn,
    });

    const idVotersFetch = vi.fn().mockResolvedValue(new Map([
      ["987", {id: "987"}],
    ]));
    const idRecap = await getMarketCloseRecap({
      poll: {
        answers: [{
          answerId: 1,
          emoji: {name: "🟢"},
          text: null,
          voters: {
            fetch: idVotersFetch,
          },
        }],
      },
    }, {
      logger,
      postWithRetryFn: createPostWithRecap(),
      readSecretFn,
    });

    expect(mediaRecap?.allowedUserIds).toEqual(["789"]);
    expect(idRecap?.allowedUserIds).toEqual(["987"]);
    expect(logger.log).not.toHaveBeenCalledWith(
      "warn",
      "Skipping market close recap voter mentions: poll answer Risk-on was not found.",
    );
  });

  test("falls back to stable poll answer IDs when answer text is partial", async () => {
    const votersFetch = vi.fn().mockResolvedValue(new Map([
      ["456", {id: "456"}],
    ]));

    const recap = await getMarketCloseRecap({
      poll: {
        answers: new Map([
          [1, {
            id: 1,
            text: null,
            voters: {
              fetch: votersFetch,
            },
          }],
        ]),
      },
    }, {
      logger,
      postWithRetryFn: createPostWithRecap(),
      readSecretFn,
    });

    expect(recap?.allowedUserIds).toEqual(["456"]);
    expect(logger.log).not.toHaveBeenCalledWith(
      "warn",
      "Skipping market close recap voter mentions: poll answer Risk-on was not found.",
    );
  });

  test("handles an empty sentiment title and truncates long summaries", async () => {
    const longSummary = [
      "`VIX` fiel um `1,1 Punkte`.",
      ...Array.from({length: 40}, (_value, index) => `Zeile ${index} mit genug Text, damit die Zusammenfassung sicher gekürzt werden muss.`),
    ].join("\n");

    const recap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn: createPostWithRecap({
        sentimentTitle: "",
        summaryMarkdown: longSummary,
      }),
      readSecretFn,
    });

    expect(recap?.content).toContain("Das heutige Sentiment war: **🟢 Risk-on**");
    expect(recap?.content).not.toContain("**🟢 Risk-on** -");
    expect(recap?.content).toContain("\n...");
  });

  test("renders an empty winner section only when voter fetching succeeds", async () => {
    const votersFetch = vi.fn().mockResolvedValue(new Map());
    const recap = await getMarketCloseRecap(createPollMessage("Risk-on", votersFetch), {
      logger,
      postWithRetryFn: createPostWithRecap(),
      readSecretFn,
    });

    expect(recap?.allowedUserIds).toEqual([]);
    expect(recap?.content).toContain("Richtig gelegen hat heute niemand im Opening-Poll.");
  });

  test("limits mentions while counting additional fetched voters", async () => {
    const firstPageUsers = Array.from({length: 100}, (_value, index) => {
      const id = String(index + 1).padStart(3, "0");
      return [id, {id}] as const;
    });
    const votersFetch = vi.fn()
      .mockResolvedValueOnce(new Map(firstPageUsers))
      .mockResolvedValueOnce(new Map([["101", {id: "101"}]]));

    const recap = await getMarketCloseRecap(createPollMessage("Risk-on", votersFetch), {
      logger,
      postWithRetryFn: createPostWithRecap(),
      readSecretFn,
    }, {
      maxFetchedWinners: 101,
      maxMentionedWinners: 1,
    });

    expect(recap?.allowedUserIds).toEqual(["001"]);
    expect(recap?.content).toContain("<@001>");
    expect(recap?.content).toContain("und `100` weitere.");
    expect(votersFetch).toHaveBeenNthCalledWith(2, {
      after: "100",
      limit: 1,
    });
  });

  test("omits voter mentions when the matching answer has no fetchable voters", async () => {
    const recap = await getMarketCloseRecap({
      poll: {
        answers: [{id: 1, text: "Risk-on"}],
      },
    }, {
      logger,
      postWithRetryFn: createPostWithRecap(),
      readSecretFn,
    });

    expect(recap?.content).not.toContain("Richtig gelegen");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping market close recap voter mentions: poll answer Risk-on is not fetchable.",
    );
  });

  test("omits voter mentions when voter fetching fails", async () => {
    const votersFetch = vi.fn().mockRejectedValue(new Error("discord down"));
    const recap = await getMarketCloseRecap(createPollMessage("Risk-on", votersFetch), {
      logger,
      postWithRetryFn: createPostWithRecap(),
      readSecretFn,
    });

    expect(recap?.content).not.toContain("Richtig gelegen");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Could not fetch market close recap poll voters"),
    );
  });

  test("rejects recaps that quote VIX in percent", async () => {
    const postWithRetryFn = createPostWithRecap({
      sentimentTitle: "risk-off",
      summaryMarkdown: "`SPX` fiel vom Open. Der `VIX` stieg um `8%`.",
      winningPollAnswer: "Risk-off",
    });

    const recap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(recap).toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI market close recap failed output validation.",
    );
  });

  test("rejects invalid or incomplete AI responses", async () => {
    const invalidJsonRecap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn: vi.fn().mockResolvedValue({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: "{not-json",
              }],
            },
          }],
        },
      }),
      readSecretFn,
    });
    const missingFieldRecap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn: createPostWithRecap({
        winningPollAnswer: "Unknown",
      }),
      readSecretFn,
    });

    expect(invalidJsonRecap).toBeUndefined();
    expect(missingFieldRecap).toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI market close recap returned invalid JSON.",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI market close recap response missed required fields.",
    );
  });

  test("rejects output that mentions provider, ETF proxies, sentiment labels or omits VIX", async () => {
    const providerMentionRecap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn: createPostWithRecap({
        summaryMarkdown: "Gemini sagt: `SPX` war fest und der `VIX` fiel um `1 Punkt`.",
      }),
      readSecretFn,
    });
    const gptMentionRecap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn: createPostWithRecap({
        summaryMarkdown: "GPT sagt: `SPX` war fest und der `VIX` fiel um `1 Punkt`.",
      }),
      readSecretFn,
    });
    const forbiddenEtfRecap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn: createPostWithRecap({
        summaryMarkdown: "`SPX` und `QQQ` waren fest, der `VIX` fiel um `1 Punkt`.",
      }),
      readSecretFn,
    });
    const sentimentInSummaryRecap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn: createPostWithRecap({
        summaryMarkdown: "Risk-on dominierte den Handel, der `VIX` fiel um `1 Punkt`.",
      }),
      readSecretFn,
    });
    const missingVixRecap = await getMarketCloseRecap(undefined, {
      logger,
      postWithRetryFn: createPostWithRecap({
        summaryMarkdown: "`SPX` und `NQ` erholten sich.",
      }),
      readSecretFn,
    });

    expect(providerMentionRecap).toBeUndefined();
    expect(gptMentionRecap).toBeUndefined();
    expect(forbiddenEtfRecap).toBeUndefined();
    expect(sentimentInSummaryRecap).toBeUndefined();
    expect(missingVixRecap).toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI market close recap failed output validation.",
    );
  });

  test("recovers today's opening sentiment poll from message history", async () => {
    const yesterdayPoll = {
      createdTimestamp: new Date("2026-05-04T13:30:00Z").getTime(),
      poll: {
        answers: new Map([[1, {id: 1, text: "Risk-on"}]]),
        question: {
          text: "Opening Sentiment: Wie geht ihr in den Handel?",
        },
      },
    };
    const todayPoll = {
      createdTimestamp: new Date("2026-05-05T13:30:00Z").getTime(),
      poll: {
        answers: new Map([[1, {id: 1, text: "Risk-on"}]]),
        question: {
          text: "Opening Sentiment: Wie geht ihr in den Handel?",
        },
      },
    };
    const channel = {
      messages: {
        fetch: vi.fn().mockResolvedValue(new Map([
          ["old", yesterdayPoll],
          ["new", todayPoll],
        ])),
      },
    };

    const poll = await findMarketOpenSentimentPollMessage(channel, {
      logger,
    }, {
      date: new Date("2026-05-05T20:10:00Z"),
    });

    expect(poll).toBe(todayPoll);
    expect(channel.messages.fetch).toHaveBeenCalledWith({
      limit: 50,
    });
  });

  test("recovers an opening sentiment poll from array history with createdAt", async () => {
    const todayPoll = {
      createdAt: new Date("2026-05-05T13:30:00Z"),
      poll: {
        answers: [{id: 1, text: "Risk-on"}],
        question: {
          text: "Opening Sentiment: Wie geht ihr in den Handel?",
        },
      },
    };

    const poll = await findMarketOpenSentimentPollMessage({
      messages: {
        fetch: vi.fn().mockResolvedValue([todayPoll]),
      },
    }, {
      logger,
    }, {
      date: new Date("2026-05-05T20:10:00Z"),
    });

    expect(poll).toBe(todayPoll);
  });

  test("handles missing or failing poll history lookup", async () => {
    const missingPoll = await findMarketOpenSentimentPollMessage({}, {
      logger,
    });
    const failingPoll = await findMarketOpenSentimentPollMessage({
      messages: {
        fetch: vi.fn().mockRejectedValue(new Error("missing history")),
      },
    }, {
      logger,
    });

    expect(missingPoll).toBeUndefined();
    expect(failingPoll).toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Could not recover NYSE opening sentiment poll"),
    );
  });
});
