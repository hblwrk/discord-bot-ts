const getWithRetryMock = jest.fn();
const loggerMock = {
  log: jest.fn(),
};

jest.mock("./http-retry.js", () => ({
  getWithRetry: getWithRetryMock,
}));

jest.mock("./logging.js", () => ({
  getLogger: () => loggerMock,
}));

import {getTickers} from "./tickers.js";

describe("getTickers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("loads and maps sp500 tickers", async () => {
    getWithRetryMock.mockResolvedValue({
      data: [
        {Symbol: "AAPL", Name: "Apple"},
        {Symbol: "MSFT", Name: "Microsoft"},
      ],
    });

    const tickers = await getTickers("sp500");

    expect(getWithRetryMock).toHaveBeenCalledTimes(1);
    expect(getWithRetryMock).toHaveBeenCalledWith(expect.stringContaining("s-and-p-500-companies"));
    expect(tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({symbol: "AAPL", name: "Apple", exchange: "sp500"}),
      expect.objectContaining({symbol: "MSFT", name: "Microsoft", exchange: "sp500"}),
      expect.objectContaining({symbol: "VIRT", exchange: "russell1000"}),
    ]));
  });

  test("loads and maps nasdaq100 tickers", async () => {
    getWithRetryMock.mockResolvedValue({
      data: [
        {Symbol: "NVDA", Name: "NVIDIA"},
        {Symbol: "TSLA", Name: "Tesla"},
      ],
    });

    const tickers = await getTickers("nasdaq100");

    expect(getWithRetryMock).toHaveBeenCalledTimes(1);
    expect(getWithRetryMock).toHaveBeenCalledWith(expect.stringContaining("constituents-nasdaq100.json"));
    expect(tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({symbol: "NVDA", name: "NVIDIA", exchange: "nasdaq100"}),
      expect.objectContaining({symbol: "TSLA", name: "Tesla", exchange: "nasdaq100"}),
      expect.objectContaining({symbol: "VIRT", exchange: "russell1000"}),
    ]));
  });

  test("loads both sources when index is all", async () => {
    getWithRetryMock
      .mockResolvedValueOnce({
        data: [
          {Symbol: "AAPL", Name: "Apple"},
          {Symbol: "MSFT", Name: "Microsoft"},
        ],
      })
      .mockResolvedValueOnce({
        data: [
          {Symbol: "NVDA", Name: "NVIDIA"},
          {Symbol: "TSLA", Name: "Tesla"},
        ],
      });

    const tickers = await getTickers("all");

    expect(getWithRetryMock).toHaveBeenCalledTimes(2);
    expect(tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({symbol: "AAPL", exchange: "sp500"}),
      expect.objectContaining({symbol: "NVDA", exchange: "nasdaq100"}),
      expect.objectContaining({symbol: "VIRT", exchange: "russell1000"}),
    ]));
  });

  test("logs and continues when one source fails", async () => {
    getWithRetryMock
      .mockRejectedValueOnce(new Error("sp500 down"))
      .mockResolvedValueOnce({
        data: [
          {Symbol: "NVDA", Name: "NVIDIA"},
          {Symbol: "TSLA", Name: "Tesla"},
        ],
      });

    const tickers = await getTickers("all");

    expect(getWithRetryMock).toHaveBeenCalledTimes(2);
    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Loading tickers failed:"),
    );
    expect(tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({symbol: "NVDA", exchange: "nasdaq100"}),
      expect.objectContaining({symbol: "VIRT", exchange: "russell1000"}),
    ]));
  });

  test("returns only fallback ticker for unsupported index", async () => {
    const tickers = await getTickers("dax");

    expect(getWithRetryMock).not.toHaveBeenCalled();
    expect(tickers).toEqual([
      expect.objectContaining({
        symbol: "VIRT",
        name: "Virtu Financial, Inc.",
        exchange: "russell1000",
      }),
    ]);
  });

  test("ignores sources with one or fewer entries", async () => {
    getWithRetryMock.mockResolvedValue({
      data: [{Symbol: "AAPL", Name: "Apple"}],
    });

    const tickers = await getTickers("sp500");

    expect(tickers).toEqual([
      expect.objectContaining({symbol: "VIRT", exchange: "russell1000"}),
    ]);
  });
});
