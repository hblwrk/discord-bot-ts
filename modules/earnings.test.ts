import {EarningsEvent, getEarnings, getEarningsMessages, getEarningsResult, getEarningsText} from "./earnings.js";
import axios from "axios";

jest.mock("axios");
jest.useFakeTimers();
jest.setSystemTime(new Date("2024-01-02T19:30:00+01:00"));

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

describe("getEarnings/getEarningsResult", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("today loads Nasdaq earnings for the current day", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: getNasdaqResponse([
        {
          symbol: "FC",
          name: "Franklin Covey",
          time: "time-after-hours",
          marketCap: "1.2B",
          epsForecast: "0.95",
        },
      ]),
    });

    const earnings = await getEarnings(0, "today");

    expect(earnings).toEqual([
      {
        ticker: "FC",
        date: "2024-01-02",
        importance: 1,
        when: "after_close",
        companyName: "Franklin Covey",
        marketCap: 1_200_000_000,
        marketCapText: "1.2B",
        epsConsensus: "0.95",
      },
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
        {
          symbol: "CALM",
          name: "Cal-Maine Foods",
          time: "time-pre-market",
          marketCap: "3.1B",
          epsForecast: "2.05",
        },
      ]),
    });

    const earnings = await getEarnings(0, "tomorrow");

    expect(earnings).toEqual([
      {
        ticker: "CALM",
        date: "2024-01-03",
        importance: 1,
        when: "before_open",
        companyName: "Cal-Maine Foods",
        marketCap: 3_100_000_000,
        marketCapText: "3.1B",
        epsConsensus: "2.05",
      },
    ]);
  });

  test("days loads earnings for the requested date range", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>)
      .mockResolvedValueOnce({
        data: getNasdaqResponse([
          {
            symbol: "UNF",
            name: "UniFirst",
            time: "time-pre-market",
            marketCap: "6.2B",
            epsForecast: "1.21",
          },
        ]),
      })
      .mockResolvedValueOnce({
        data: getNasdaqResponse([
          {
            symbol: "RPM",
            name: "RPM International",
            time: "time-after-hours",
            marketCap: "12.4B",
            epsForecast: "0.44",
          },
        ]),
      });

    const earnings = await getEarnings(2, "today");

    expect(earnings).toEqual([
      {
        ticker: "UNF",
        date: "2024-01-03",
        importance: 1,
        when: "before_open",
        companyName: "UniFirst",
        marketCap: 6_200_000_000,
        marketCapText: "6.2B",
        epsConsensus: "1.21",
      },
      {
        ticker: "RPM",
        date: "2024-01-04",
        importance: 1,
        when: "after_close",
        companyName: "RPM International",
        marketCap: 12_400_000_000,
        marketCapText: "12.4B",
        epsConsensus: "0.44",
      },
    ]);

    const calledUrls = (axios.get as jest.MockedFunction<typeof axios.get>).mock.calls.map(call => String(call[0]));
    expect(calledUrls).toContainEqual(expect.stringContaining("date=2024-01-03"));
    expect(calledUrls).toContainEqual(expect.stringContaining("date=2024-01-04"));
  });

  test("date uses the provided date in US/Eastern", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: getNasdaqResponse([
        {
          symbol: "AAPL",
          name: "Apple",
          time: "time-after-hours",
          marketCap: "2.8T",
          epsForecast: "2.13",
        },
      ]),
    });

    const earnings = await getEarnings(0, "2024-01-04T12:00:00+05:00");

    expect(earnings).toEqual([
      {
        ticker: "AAPL",
        date: "2024-01-04",
        importance: 1,
        when: "after_close",
        companyName: "Apple",
        marketCap: 2_800_000_000_000,
        marketCapText: "2.8T",
        epsConsensus: "2.13",
      },
    ]);
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

  test("returns grouped ticker-first one-line output", () => {
    const earningEvents: EarningsEvent[] = [
      {
        ticker: "SMALL",
        date: "2024-01-03",
        importance: 1,
        when: "after_close",
        companyName: "Small Co",
        marketCap: 100_000_000,
        marketCapText: "100M",
        epsConsensus: "0.50",
      },
      {
        ticker: "BIG",
        date: "2024-01-03",
        importance: 1,
        when: "during_session",
        companyName: "Big Co",
        marketCap: 1_000_000_000,
        marketCapText: "1B",
        epsConsensus: "1.20",
      },
      {
        ticker: "NEXT",
        date: "2024-01-04",
        importance: 1,
        when: "before_open",
        companyName: "Next Co",
        marketCap: 500_000_000,
        marketCapText: "500M",
        epsConsensus: "0.75",
      },
    ];

    const text = getEarningsText(earningEvents, "all", [{symbol: "BIG"}] as any);

    expect(text).toContain("**Zeitraum:** Mittwoch, 3. Januar 2024 bis Donnerstag, 4. Januar 2024");
    expect(text).toContain("**Mittwoch, 3. Januar 2024:**");
    expect(text).toContain("**Donnerstag, 4. Januar 2024:**");

    const lines = text.split("\n").filter(line => line.includes(" | Zeitpunkt: "));
    expect(lines[0].startsWith("**`BIG`** | ")).toBe(true);
    expect(lines[1].startsWith("`SMALL` | ")).toBe(true);
    expect(lines[2].startsWith("`NEXT` | ")).toBe(true);
    expect(lines[0]).toContain("🔮 EPS: 1.20");
    expect(lines[0]).toContain("MCap: 1B");
    expect(lines[0]).toContain("Zeitpunkt: Während der Handelszeiten oder unbekannter Zeitpunkt");
  });
});

describe("getEarningsMessages", () => {
  const earningEvents: EarningsEvent[] = [
    {
      ticker: "MID",
      date: "2024-01-03",
      importance: 1,
      when: "after_close",
      companyName: "Mid Co",
      marketCap: 500_000_000,
      marketCapText: "500M",
      epsConsensus: "0.80",
    },
    {
      ticker: "BIG",
      date: "2024-01-03",
      importance: 1,
      when: "before_open",
      companyName: "Big Co",
      marketCap: 1_500_000_000,
      marketCapText: "1.5B",
      epsConsensus: "2.20",
    },
    {
      ticker: "SMALL",
      date: "2024-01-03",
      importance: 1,
      when: "during_session",
      companyName: "Small Co",
      marketCap: 100_000_000,
      marketCapText: "100M",
      epsConsensus: "0.10",
    },
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

    const lines = batch.messages[0].split("\n").filter(line => line.includes(" | Zeitpunkt: "));
    expect(lines[0].startsWith("**`BIG`** | ")).toBe(true);
    expect(lines[1].startsWith("`MID` | ")).toBe(true);
    expect(lines[2].startsWith("`SMALL` | ")).toBe(true);
    expect(lines[0]).toContain("🔮 EPS: 2.20");
  });

  test("filters by when and keeps ticker-first format", () => {
    const batch = getEarningsMessages(earningEvents, "during_session", [], {
      maxMessageLength: 1800,
      maxMessages: 6,
    });

    expect(batch.messages).toHaveLength(1);
    const lines = batch.messages[0].split("\n").filter(line => line.includes(" | Zeitpunkt: "));
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("`SMALL` | ")).toBe(true);
    expect(lines[0]).toContain("Während der Handelszeiten oder unbekannter Zeitpunkt");
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
        marketCapText: "100M",
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
        marketCapText: "1B",
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
