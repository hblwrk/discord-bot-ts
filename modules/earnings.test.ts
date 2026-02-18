import { EarningsEvent, getEarnings, getEarningsMessages, getEarningsText } from "./earnings.js";
import axios from "axios";

jest.mock("axios");
jest.useFakeTimers();
jest.setSystemTime(new Date("2024-01-02T19:30:00+01:00"));

describe("getEarnings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const apiResponse = {
    earnings: {
      "2024-01-02": {
        stocks: [
          {
            importance: 2,
            symbol: "FC",
            date: "2024-01-02",
            time: "16:05:00",
            title: "Franklin Covey",
          },
        ],
      },
      "2024-01-03": {
        stocks: [
          {
            importance: 4,
            symbol: "CALM",
            date: "2024-01-03",
            time: "16:05:00",
            title: "Cal-Maine Foods",
          },
          {
            importance: 3,
            symbol: "UNF",
            date: "2024-01-03",
            time: "08:00:00",
            title: "UniFirst",
          },
          {
            importance: 1,
            symbol: "LW",
            date: "2024-01-03",
            time: "10:30:00",
            title: "Lamb Weston Holdings",
          },
        ],
      },
      "2024-01-04": {
        stocks: [
          {
            importance: 3,
            symbol: "RPM",
            date: "2024-01-04",
            time: "06:45:00",
            title: "RPM International",
          },
        ],
      },
    },
  };

  test("today", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: apiResponse,
    });

    const earnings = await getEarnings(0, "today", "all");

    expect(earnings).toEqual([
      {
        importance: 2,
        date: "2024-01-02",
        ticker: "FC",
        when: "after_close",
      },
    ]);

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining("date_from=2024-01-02"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.any(String),
        }),
      })
    );
  });
  test("tomorrow", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: apiResponse,
    });

    const earnings = await getEarnings(0, "tomorrow", "all");

    expect(earnings).toEqual([
      {
        ticker: "CALM",
        date: "2024-01-03",
        importance: 4,
        when: "after_close",
      },
      {
        ticker: "UNF",
        date: "2024-01-03",
        importance: 3,
        when: "before_open",
      },
      {
        ticker: "LW",
        date: "2024-01-03",
        importance: 1,
        when: "during_session",
      },
    ]);
  });
  test("date", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: apiResponse,
    });

    const earnings = await getEarnings(0, "2024-01-04T12:00:00+05:00", "all");

    expect(earnings).toEqual([
      {
        date: "2024-01-04",
        importance: 3,
        ticker: "RPM",
        when: "before_open",
      },
    ]);
  });

  test("passes watchlist filter to stocktwits request", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>).mockResolvedValue({
      data: apiResponse,
    });

    await getEarnings(0, "today", "5666c5fa-80dc-4e16-8bcc-12a8314d0b07");

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining("watchlist=5666c5fa-80dc-4e16-8bcc-12a8314d0b07"),
      expect.any(Object)
    );
  });

  test("retries without watchlist when stocktwits responds 403", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>)
      .mockRejectedValueOnce({
        response: {
          status: 403,
        },
      })
      .mockResolvedValueOnce({
        data: apiResponse,
      });

    const earnings = await getEarnings(
      0,
      "today",
      "5666c5fa-80dc-4e16-8bcc-12a8314d0b07"
    );

    expect(earnings).toEqual([
      {
        importance: 2,
        date: "2024-01-02",
        ticker: "FC",
        when: "after_close",
      },
    ]);

    expect(axios.get).toHaveBeenCalledTimes(2);
    expect((axios.get as jest.MockedFunction<typeof axios.get>).mock.calls[0][0]).toEqual(
      expect.stringContaining("watchlist=5666c5fa-80dc-4e16-8bcc-12a8314d0b07")
    );
    expect((axios.get as jest.MockedFunction<typeof axios.get>).mock.calls[1][0]).toEqual(
      expect.not.stringContaining("watchlist=")
    );
  });

  test("returns no events when stocktwits fails with 403", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>)
      .mockRejectedValueOnce({
        response: {
          status: 403,
        },
      });

    const earnings = await getEarnings(0, "today", "all");

    expect(earnings).toEqual([]);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect((axios.get as jest.MockedFunction<typeof axios.get>).mock.calls[0][0]).toEqual(
      expect.stringContaining("api.stocktwits.com/api/2/discover/earnings_calendar")
    );
  });

  test("returns no events when stocktwits returns cloudflare challenge page", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>)
      .mockResolvedValueOnce({
        data: "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>",
        headers: {
          "content-type": "text/html; charset=UTF-8",
        },
      });

    const earnings = await getEarnings(0, "today", "all");

    expect(earnings).toEqual([]);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect((axios.get as jest.MockedFunction<typeof axios.get>).mock.calls[0][0]).toEqual(
      expect.stringContaining("api.stocktwits.com/api/2/discover/earnings_calendar")
    );
  });

  test("retries without watchlist when stocktwits returns cloudflare challenge page", async () => {
    (axios.get as jest.MockedFunction<typeof axios.get>)
      .mockResolvedValueOnce({
        data: "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>",
        headers: {
          "content-type": "text/html; charset=UTF-8",
        },
      })
      .mockResolvedValueOnce({
        data: apiResponse,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      });

    const earnings = await getEarnings(
      0,
      "today",
      "5666c5fa-80dc-4e16-8bcc-12a8314d0b07"
    );

    expect(earnings).toEqual([
      {
        importance: 2,
        date: "2024-01-02",
        ticker: "FC",
        when: "after_close",
      },
    ]);

    expect(axios.get).toHaveBeenCalledTimes(2);
    expect((axios.get as jest.MockedFunction<typeof axios.get>).mock.calls[0][0]).toEqual(
      expect.stringContaining("watchlist=5666c5fa-80dc-4e16-8bcc-12a8314d0b07")
    );
    expect((axios.get as jest.MockedFunction<typeof axios.get>).mock.calls[1][0]).toEqual(
      expect.not.stringContaining("watchlist=")
    );
  });

});

describe("getEarningsText", () => {
  const earningEvents: EarningsEvent[] = [
    {
      ticker: "CALM",
      date: "2024-01-03",
      importance: 4,
      when: "after_close",
    },
    {
      ticker: "UNF",
      date: "2024-01-03",
      importance: 3,
      when: "before_open",
    },
    {
      importance: 1,
      ticker: "RDUS",
      date: "2024-01-03",
      when: "after_close",
    },
    {
      ticker: "LW",
      date: "2024-01-03",
      importance: 1,
      when: "during_session",
    },
  ];

  test("all", () => {
    const text = getEarningsText(earningEvents, "all", []);
    expect(text).toBe(`Earnings am Mittwoch, 3. Januar 2024:
**Vor open:**
UNF

**Während der Handelszeiten:**
LW

**Nach close:**
RDUS, CALM`);
  });

  test("before_open", () => {
    const text = getEarningsText(earningEvents, "before_open", []);
    expect(text).toBe(`Earnings am Mittwoch, 3. Januar 2024:
**Vor open:**
UNF

`);
  });

  test("during_session", () => {
    const text = getEarningsText(earningEvents, "during_session", []);
    expect(text).toBe(`Earnings am Mittwoch, 3. Januar 2024:
**Während der Handelszeiten:**
LW

`);
  });

  test("after_close", () => {
    const text = getEarningsText(earningEvents, "after_close", []);
    expect(text).toBe(`Earnings am Mittwoch, 3. Januar 2024:
**Nach close:**
RDUS, CALM`);
  });

  test("single event", () => {
    const text = getEarningsText([{
      ticker: "AAPL",
      date: "2024-01-03",
      importance: 1,
      when: "after_close",
    }], "all", []);

    expect(text).toBe(`Earnings am Mittwoch, 3. Januar 2024:
**Nach close:**
AAPL`);
  });
});

describe("getEarningsMessages", () => {
  const earningEvents: EarningsEvent[] = [
    {
      ticker: "CALM",
      date: "2024-01-03",
      importance: 4,
      when: "after_close",
    },
    {
      ticker: "UNF",
      date: "2024-01-03",
      importance: 3,
      when: "before_open",
    },
    {
      importance: 1,
      ticker: "RDUS",
      date: "2024-01-03",
      when: "after_close",
    },
    {
      ticker: "LW",
      date: "2024-01-03",
      importance: 1,
      when: "during_session",
    },
  ];

  test("returns one message with all sections when content fits", () => {
    const batch = getEarningsMessages(earningEvents, "all", [], {
      maxMessageLength: 1800,
      maxMessages: 6,
    });

    expect(batch.messages).toHaveLength(1);
    expect(batch.truncated).toBe(false);
    expect(batch.totalEvents).toBe(4);
    expect(batch.includedEvents).toBe(4);
    expect(batch.messages[0]).toContain("**Vor open:**");
    expect(batch.messages[0]).toContain("**Während der Handelszeiten:**");
    expect(batch.messages[0]).toContain("**Nach close:**");
  });

  test("returns one message when a single event exists", () => {
    const batch = getEarningsMessages([{
      ticker: "AAPL",
      date: "2024-01-03",
      importance: 1,
      when: "after_close",
    }], "all", [], {
      maxMessageLength: 1800,
      maxMessages: 6,
    });

    expect(batch.messages).toHaveLength(1);
    expect(batch.truncated).toBe(false);
    expect(batch.totalEvents).toBe(1);
    expect(batch.includedEvents).toBe(1);
    expect(batch.messages[0]).toContain("AAPL");
  });

  test("splits oversized section into multiple messages", () => {
    const manyAfterCloseEvents: EarningsEvent[] = [];
    for (let index = 0; index < 20; index++) {
      manyAfterCloseEvents.push({
        ticker: `TICKER${index}`,
        date: "2024-01-03",
        importance: 1,
        when: "after_close",
      });
    }

    const batch = getEarningsMessages(manyAfterCloseEvents, "all", [], {
      maxMessageLength: 120,
      maxMessages: 10,
    });

    expect(batch.messages.length).toBeGreaterThan(1);
    expect(batch.messages[0]).toContain("**Nach close:**");
    expect(batch.messages[1]).toContain("(Fortsetzung)");
    for (const message of batch.messages) {
      expect(message.length).toBeLessThanOrEqual(120);
    }
  });

  test("adds truncation note when maxMessages is reached", () => {
    const manyAfterCloseEvents: EarningsEvent[] = [];
    for (let index = 0; index < 30; index++) {
      manyAfterCloseEvents.push({
        ticker: `E${index}`,
        date: "2024-01-03",
        importance: 1,
        when: "after_close",
      });
    }

    const batch = getEarningsMessages(manyAfterCloseEvents, "all", [], {
      maxMessageLength: 100,
      maxMessages: 2,
    });

    expect(batch.truncated).toBe(true);
    expect(batch.messages).toHaveLength(2);
    expect(batch.includedEvents).toBeLessThan(batch.totalEvents);
    expect(batch.messages[1]).toContain("... weitere Earnings konnten wegen Discord-Limits nicht angezeigt werden.");
  });
});
