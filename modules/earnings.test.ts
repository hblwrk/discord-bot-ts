import { EarningsEvent, getEarnings, getEarningsText } from "./earnings.js";
import axios from "axios";

jest.mock("axios");
jest.useFakeTimers();
jest.setSystemTime(new Date("2024-01-02T19:30:00+01:00"));

describe("getEarnings", () => {
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
});
