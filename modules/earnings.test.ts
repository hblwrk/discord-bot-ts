import {EarningsEvent, getEarnings, getEarningsMessages, getEarningsResult, getEarningsText} from "./earnings.js";
import axios from "axios";

jest.mock("axios");
jest.useFakeTimers();
const defaultNow = new Date("2024-01-02T19:30:00+01:00");
jest.setSystemTime(defaultNow);

function getNasdaqResponse(rows: any[] = []) {
  return {
    data: {
      rows,
    },
    status: {
      rCode: 200,
    },
  };
}

function getNasdaqRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "AAPL",
    name: "Apple",
    time: "time-after-hours",
    marketCap: "2.8T",
    epsForecast: "2.13",
    ...overrides,
  };
}

function getEarningsEvent(overrides: Partial<EarningsEvent> = {}): EarningsEvent {
  return {
    ticker: "AAPL",
    date: "2024-01-03",
    importance: 1,
    when: "during_session",
    companyName: "Apple",
    marketCap: 2_800_000_000_000,
    marketCapText: "$2.8T",
    epsConsensus: "2.13",
    ...overrides,
  };
}

describe("getEarnings/getEarningsResult", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.setSystemTime(defaultNow);
  });

  test("today loads Nasdaq earnings for the current day", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: getNasdaqResponse([
        getNasdaqRow({
          symbol: "FC",
          name: "Franklin Covey",
          marketCap: "1.2B",
          epsForecast: "0.95",
        }),
      ]),
    });

    const earnings = await getEarnings(0, "today");

    expect(earnings).toEqual([
      getEarningsEvent({
        ticker: "FC",
        date: "2024-01-02",
        when: "after_close",
        companyName: "Franklin Covey",
        marketCap: 1_200_000_000,
        marketCapText: "$1.2B",
        epsConsensus: "0.95",
      }),
    ]);

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining("api.nasdaq.com/api/calendar/earnings?date=2024-01-02"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.any(String),
          "Accept": expect.any(String),
          "Referer": expect.any(String),
        }),
      })
    );
  });

  test("tomorrow loads Nasdaq earnings for the next day", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: getNasdaqResponse([
        getNasdaqRow({
          symbol: "CALM",
          name: "Cal-Maine Foods",
          time: "time-pre-market",
          marketCap: "3.1B",
          epsForecast: "2.05",
        }),
      ]),
    });

    const earnings = await getEarnings(0, "tomorrow");

    expect(earnings).toEqual([
      getEarningsEvent({
        ticker: "CALM",
        date: "2024-01-03",
        when: "before_open",
        companyName: "Cal-Maine Foods",
        marketCap: 3_100_000_000,
        marketCapText: "$3.1B",
        epsConsensus: "2.05",
      }),
    ]);
  });

  test("days loads earnings for the requested date range", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>)
      .mockResolvedValueOnce({
        data: getNasdaqResponse([
          getNasdaqRow({
            symbol: "UNF",
            name: "UniFirst",
            time: "time-pre-market",
            marketCap: "6.2B",
            epsForecast: "1.21",
          }),
        ]),
      })
      .mockResolvedValueOnce({
        data: getNasdaqResponse([
          getNasdaqRow({
            symbol: "RPM",
            name: "RPM International",
            marketCap: "12400000000",
            epsForecast: "0.44",
          }),
        ]),
      });

    const earnings = await getEarnings(2, "today");

    expect(earnings).toEqual([
      getEarningsEvent({
        ticker: "UNF",
        date: "2024-01-03",
        when: "before_open",
        companyName: "UniFirst",
        marketCap: 6_200_000_000,
        marketCapText: "$6.2B",
        epsConsensus: "1.21",
      }),
      getEarningsEvent({
        ticker: "RPM",
        date: "2024-01-04",
        when: "after_close",
        companyName: "RPM International",
        marketCap: 12_400_000_000,
        marketCapText: "$12.4B",
        epsConsensus: "0.44",
      }),
    ]);

    const calledUrls = (axios.get as jest.MockedFunction<typeof axios.get>).mock.calls.map(call => String(call[0]));
    expect(calledUrls).toContainEqual(expect.stringContaining("date=2024-01-03"));
    expect(calledUrls).toContainEqual(expect.stringContaining("date=2024-01-04"));
  });

  test("date uses the provided date in US/Eastern", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: getNasdaqResponse([
        getNasdaqRow({
          marketCap: 2_800_000_000_000,
        }),
      ]),
    });

    const earnings = await getEarnings(0, "2024-01-04T12:00:00+05:00");

    expect(earnings).toEqual([
      getEarningsEvent({
        date: "2024-01-04",
        when: "after_close",
        marketCap: 2_800_000_000_000,
        marketCapText: "$2.8T",
      }),
    ]);
  });

  test("date-only input keeps the requested US/Eastern calendar date", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: getNasdaqResponse([
        getNasdaqRow(),
      ]),
    });

    const earnings = await getEarnings(0, "2026-02-25");

    expect(earnings).toEqual([
      expect.objectContaining({
        date: "2026-02-25",
      }),
    ]);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining("api.nasdaq.com/api/calendar/earnings?date=2026-02-25"),
      expect.any(Object)
    );
  });

  test("explicit Europe/Berlin timestamp maps to the corresponding US/Eastern date", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: getNasdaqResponse([
        getNasdaqRow(),
      ]),
    });

    await getEarnings(0, "2026-02-25T00:30:00+01:00");

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining("api.nasdaq.com/api/calendar/earnings?date=2026-02-24"),
      expect.any(Object)
    );
  });

  test("clamps multi-day range to 10 days", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: getNasdaqResponse([]),
    });

    const result = await getEarningsResult(30, "today");

    expect(result).toEqual({
      events: [],
      status: "ok",
    });
    expect(axios.get).toHaveBeenCalledTimes(10);

    const calledUrls = (axios.get as jest.MockedFunction<typeof axios.get>).mock.calls.map(call => String(call[0]));
    expect(calledUrls).toContainEqual(expect.stringContaining("date=2024-01-03"));
    expect(calledUrls).toContainEqual(expect.stringContaining("date=2024-01-12"));
    expect(calledUrls).not.toContainEqual(expect.stringContaining("date=2024-01-13"));
  });

  test("days range starts from the next trading day on a weekend", async () => {
    jest.setSystemTime(new Date("2026-02-22T12:00:00-05:00"));
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: getNasdaqResponse([]),
    });

    await getEarningsResult(2, "today");

    const calledUrls = (axios.get as jest.MockedFunction<typeof axios.get>).mock.calls.map(call => String(call[0]));
    expect(calledUrls).toContainEqual(expect.stringContaining("date=2026-02-23"));
    expect(calledUrls).toContainEqual(expect.stringContaining("date=2026-02-24"));
    expect(calledUrls).not.toContainEqual(expect.stringContaining("date=2026-02-25"));
  });

  test("maps Nasdaq time tokens and skips malformed rows", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: getNasdaqResponse([
        {
          symbol: "PRE",
          time: "time-pre-market",
        },
        {
          symbol: "AFT",
          time: "time-after-hours",
        },
        {
          symbol: "NOS",
          time: "time-not-supplied",
        },
        {
          symbol: "UNK",
          time: "time-unknown",
        },
        {
          symbol: "   ",
          time: "time-after-hours",
        },
      ]),
    });

    const earnings = await getEarnings(0, "today");

    expect(earnings).toEqual([
      expect.objectContaining({ticker: "PRE", when: "before_open"}),
      expect.objectContaining({ticker: "AFT", when: "after_close"}),
      expect.objectContaining({ticker: "NOS", when: "during_session"}),
      expect.objectContaining({ticker: "UNK", when: "during_session"}),
    ]);
    expect(earnings).toHaveLength(4);
  });

  test("returns error when all Nasdaq requests fail", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockRejectedValue({
      response: {
        status: 400,
      },
    });

    const result = await getEarningsResult(0, "today");

    expect(result).toEqual({
      events: [],
      status: "error",
    });
  });
});

describe("getEarningsText", () => {
  test("returns none when no events are available", () => {
    const text = getEarningsText([], "all", []);
    expect(text).toBe("none");
  });

  test("single-day output omits generic 'Earnings am' title line", () => {
    const text = getEarningsText([
      getEarningsEvent({
        ticker: "AAPL",
        when: "before_open",
      }),
      getEarningsEvent({
        ticker: "MSFT",
        when: "after_close",
        companyName: "Microsoft",
        marketCap: 3_000_000_000_000,
        marketCapText: "$3T",
        epsConsensus: "2.95",
      }),
    ], "all", []);

    expect(text).not.toContain("Earnings am");
    expect(text).toContain("**Mittwoch, 3. Januar 2024:**");
  });

  test("returns grouped ticker-first one-line output", () => {
    const earningEvents: EarningsEvent[] = [
      getEarningsEvent({
        ticker: "SMALL",
        when: "after_close",
        companyName: "Small Co",
        marketCap: 100_000_000,
        marketCapText: "$100M",
        epsConsensus: "0.50",
      }),
      getEarningsEvent({
        ticker: "BIG",
        when: "during_session",
        companyName: "Big Co",
        marketCap: 1_000_000_000,
        marketCapText: "$1B",
        epsConsensus: "1.20",
      }),
      getEarningsEvent({
        ticker: "NEXT",
        date: "2024-01-04",
        when: "before_open",
        companyName: "Next Co",
        marketCap: 500_000_000,
        marketCapText: "$500M",
        epsConsensus: "0.75",
      }),
    ];

    const text = getEarningsText(earningEvents, "all", [{symbol: "BIG"}] as any);

    expect(text).toContain("**Zeitraum:** Mittwoch, 3. Januar 2024 bis Donnerstag, 4. Januar 2024");
    expect(text).toContain("**Mittwoch, 3. Januar 2024:**");
    expect(text).toContain("**Donnerstag, 4. Januar 2024:**");
    expect(text).toContain("**Während der Handelszeiten oder unbekannter Zeitpunkt:**");
    expect(text).toContain("**Nach Handelsschluss:**");
    expect(text).toContain("**Vor Handelsbeginn:**");

    const lines = text.split("\n").filter(line => line.includes(" | MCap: "));
    expect(lines[0].startsWith("**`BIG`** Big Co | ")).toBe(true);
    expect(lines[1].startsWith("`SMALL` Small Co | ")).toBe(true);
    expect(lines[2].startsWith("`NEXT` Next Co | ")).toBe(true);
    expect(lines[0]).toContain("🔮 EPS: 1.20");
    expect(lines[0]).toContain("MCap: $1B");
    expect(lines[0]).not.toContain("Während der Handelszeiten oder unbekannter Zeitpunkt");
  });
});

describe("getEarningsMessages", () => {
  const earningEvents: EarningsEvent[] = [
    getEarningsEvent({
      ticker: "MID",
      when: "after_close",
      companyName: "Mid Co",
      marketCap: 500_000_000,
      marketCapText: "$500M",
      epsConsensus: "0.80",
    }),
    getEarningsEvent({
      ticker: "BIG",
      when: "before_open",
      companyName: "Big Co",
      marketCap: 1_500_000_000,
      marketCapText: "$1.5B",
      epsConsensus: "2.20",
    }),
    getEarningsEvent({
      ticker: "SMALL",
      when: "during_session",
      companyName: "Small Co",
      marketCap: 100_000_000,
      marketCapText: "$100M",
      epsConsensus: "0.10",
    }),
  ];

  test("returns one message with one line per earning and ticker first", () => {
    const batch = getEarningsMessages(earningEvents, "all", [{symbol: "BIG"}] as any, {
      maxMessageLength: 1800,
      maxMessages: 6,
    });

    expect(batch.messages).toHaveLength(1);
    expect(batch.truncated).toBe(false);
    expect(batch.totalEvents).toBe(3);
    expect(batch.includedEvents).toBe(3);
    expect(batch.messages[0]).toContain("**Vor Handelsbeginn:**");
    expect(batch.messages[0]).toContain("**Während der Handelszeiten oder unbekannter Zeitpunkt:**");
    expect(batch.messages[0]).toContain("**Nach Handelsschluss:**");
    expect(batch.messages[0]).not.toContain("Earnings am");

    const lines = batch.messages[0].split("\n").filter(line => line.includes(" | MCap: "));
    expect(lines[0].startsWith("**`BIG`** Big Co | ")).toBe(true);
    expect(lines[1].startsWith("`SMALL` Small Co | ")).toBe(true);
    expect(lines[2].startsWith("`MID` Mid Co | ")).toBe(true);
    expect(lines[0]).toContain("🔮 EPS: 2.20");
  });

  test("sub-sorts a day by time bucket before market cap", () => {
    const batch = getEarningsMessages([
      getEarningsEvent({
        ticker: "AFTER",
        when: "after_close",
        companyName: "After Co",
        marketCap: 9_000_000_000,
        marketCapText: "$9B",
        epsConsensus: "1.00",
      }),
      getEarningsEvent({
        ticker: "BEFORE",
        when: "before_open",
        companyName: "Before Co",
        marketCap: 1_000_000_000,
        marketCapText: "$1B",
        epsConsensus: "0.50",
      }),
      getEarningsEvent({
        ticker: "DURING",
        when: "during_session",
        companyName: "During Co",
        marketCap: 500_000_000,
        marketCapText: "$500M",
        epsConsensus: "0.25",
      }),
    ], "all", [], {
      maxMessageLength: 1800,
      maxMessages: 6,
    });

    const lines = batch.messages[0].split("\n").filter(line => line.includes(" | MCap: "));
    expect(lines[0].startsWith("`BEFORE` Before Co | ")).toBe(true);
    expect(lines[1].startsWith("`DURING` During Co | ")).toBe(true);
    expect(lines[2].startsWith("`AFTER` After Co | ")).toBe(true);
    const text = batch.messages[0];
    expect(text.indexOf("**Vor Handelsbeginn:**")).toBeLessThan(text.indexOf("**Während der Handelszeiten oder unbekannter Zeitpunkt:**"));
    expect(text.indexOf("**Während der Handelszeiten oder unbekannter Zeitpunkt:**")).toBeLessThan(text.indexOf("**Nach Handelsschluss:**"));
  });

  test("filters by when and keeps ticker-first format", () => {
    const batch = getEarningsMessages(earningEvents, "during_session", [], {
      maxMessageLength: 1800,
      maxMessages: 6,
    });

    expect(batch.messages).toHaveLength(1);
    const lines = batch.messages[0].split("\n").filter(line => line.includes(" | MCap: "));
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("`SMALL` Small Co | ")).toBe(true);
    expect(batch.messages[0]).toContain("**Während der Handelszeiten oder unbekannter Zeitpunkt:**");
  });

  test("splits oversized date section into multiple messages", () => {
    const manyEvents: EarningsEvent[] = [];
    for (let index = 0; index < 20; index++) {
      manyEvents.push({
        ticker: `TICKER${index}`,
        date: "2024-01-03",
        importance: 1,
        when: "after_close",
        companyName: `Company ${index}`,
        marketCap: 100_000_000 - index,
        marketCapText: "$100M",
        epsConsensus: "0.01",
      });
    }

    const batch = getEarningsMessages(manyEvents, "all", [], {
      maxMessageLength: 200,
      maxMessages: 10,
    });

    expect(batch.messages.length).toBeGreaterThan(1);
    expect(batch.messages[1]).toContain("(Fortsetzung)");
    for (const message of batch.messages) {
      expect(message.length).toBeLessThanOrEqual(200);
    }
  });

  test("adds truncation note when maxMessages is reached", () => {
    const manyEvents: EarningsEvent[] = [];
    for (let index = 0; index < 40; index++) {
      manyEvents.push({
        ticker: `E${index}`,
        date: "2024-01-03",
        importance: 1,
        when: "after_close",
        companyName: `Company ${index}`,
        marketCap: 1_000_000_000 - index,
        marketCapText: "$1B",
        epsConsensus: "0.11",
      });
    }

    const batch = getEarningsMessages(manyEvents, "all", [], {
      maxMessageLength: 180,
      maxMessages: 2,
    });

    expect(batch.truncated).toBe(true);
    expect(batch.messages).toHaveLength(2);
    expect(batch.includedEvents).toBeLessThan(batch.totalEvents);
    expect(batch.messages[1]).toContain("... weitere Earnings konnten wegen Discord-Limits nicht angezeigt werden.");
  });
});
