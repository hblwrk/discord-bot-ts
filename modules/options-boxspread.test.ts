import {describe, expect, test, vi} from "vitest";

const {
  mockGetWithRetry,
} = vi.hoisted(() => ({
  mockGetWithRetry: vi.fn(),
}));

vi.mock("./http-retry.ts", () => ({
  getWithRetry: mockGetWithRetry,
}));

import {
  formatBoxSpreadLookupResult,
  getBoxSpreadLookup,
  getSofrRate,
  type BoxSpreadDirection,
} from "./options-boxspread.ts";
import {
  type OptionContractsLookupResult,
  type OptionDeltaContract,
  OptionDeltaDataError,
  OptionDeltaInputError,
} from "./options-delta.ts";

const credentials = {
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
};

function createContract(strike: number, optionType: "call" | "put", mid: number): OptionDeltaContract {
  return {
    ask: mid + 0.5,
    askSize: 20,
    bid: mid - 0.5,
    bidSize: 20,
    delta: "call" === optionType ? 0.5 : -0.5,
    expirationDate: "2026-08-21",
    gamma: 0.01,
    iv: 0.2,
    optionType,
    streamerSymbol: `.SPX260821${"call" === optionType ? "C" : "P"}${strike}`,
    strike,
    symbol: `SPX 260821${"call" === optionType ? "C" : "P"}${strike}`,
    theta: -0.01,
    vega: 0.1,
  };
}

function createContractsLookupResult(overrides: Partial<OptionContractsLookupResult> = {}): OptionContractsLookupResult {
  return {
    actualDte: 112,
    contracts: [
      createContract(6000, "call", 560),
      createContract(6000, "put", 50),
      createContract(7000, "call", 90),
      createContract(7000, "put", 567.9),
    ],
    expiration: "2026-08-21",
    requestedDte: 112,
    requestedSide: "both",
    rolled: false,
    symbol: "SPX",
    underlyingPrice: 6500,
    underlyingPriceIsRealtime: true,
    ...overrides,
  };
}

async function getFormattedBoxSpread(direction: BoxSpreadDirection) {
  const getOptionContractsLookupFn = vi.fn(async () => createContractsLookupResult());
  const getSofrRateFn = vi.fn(async () => ({
    effectiveDate: "2026-04-30",
    percentRate: 3.66,
  }));

  const result = await getBoxSpreadLookup({
    credentials,
    direction,
    dte: 112,
    notational: 100_000,
  }, {
    getOptionContractsLookupFn,
    getSofrRateFn,
  });

  return {
    formattedResult: formatBoxSpreadLookupResult(result),
    getOptionContractsLookupFn,
    result,
  };
}

describe("options-boxspread", () => {
  test("loads, validates and caches SOFR from the New York Fed response", async () => {
    mockGetWithRetry
      .mockResolvedValueOnce({
        data: {
          refRates: [],
        },
      })
      .mockResolvedValueOnce({
        data: {
          refRates: [{
            effectiveDate: "2026-04-30",
            percentRate: "3.66",
            type: "SOFR",
          }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          refRates: [{
            effectiveDate: "2026-04-30",
            percentRate: 3.66,
            type: "SOFR",
          }],
        },
      });

    await expect(getSofrRate()).rejects.toThrow(OptionDeltaDataError);
    await expect(getSofrRate()).rejects.toThrow(OptionDeltaDataError);

    await expect(getSofrRate()).resolves.toEqual({
      effectiveDate: "2026-04-30",
      percentRate: 3.66,
    });
    await expect(getSofrRate()).resolves.toEqual({
      effectiveDate: "2026-04-30",
      percentRate: 3.66,
    });
    expect(mockGetWithRetry).toHaveBeenCalledTimes(3);
  });

  test("builds and formats an SPX borrow box from the four-leg mid", async () => {
    const {
      formattedResult,
      getOptionContractsLookupFn,
      result,
    } = await getFormattedBoxSpread("borrow");

    expect(getOptionContractsLookupFn).toHaveBeenCalledWith({
      credentials,
      dte: 112,
      side: "both",
      symbol: "SPX",
    }, expect.any(Object));
    expect(result.limitPrice).toBeCloseTo(987.9);
    expect(result.cashToday).toBeCloseTo(98_790);
    expect(result.financingAmount).toBeCloseTo(1_210);
    expect(formattedResult).toContain("Borrow `$98,790` today, repay `$100,000` for a cost of `$1,210` on August 21st, 2026");
    expect(formattedResult).toContain("Implied borrow rate: `3.94%` | SOFR: `3.66%` (2026-04-30) | Δ: `+28 bps`");
    expect(formattedResult).toContain("Limit: mid credit `987.90` (`$98,790`)");
    expect(formattedResult).toContain("Market: natural credit `985.90` / mid `987.90` / natural debit `989.90`");
    expect(formattedResult).toContain("Sell 1 Aug21'26 6000 Call");
    expect(formattedResult).toContain("Buy 1 Aug21'26 6000 Put");
    expect(formattedResult).toContain("Buy 1 Aug21'26 7000 Call");
    expect(formattedResult).toContain("Sell 1 Aug21'26 7000 Put");
  });

  test("flips the trade and wording for an SPX lending box", async () => {
    const {formattedResult} = await getFormattedBoxSpread("lend");

    expect(formattedResult).toContain("Lend `$98,790` today, receive `$100,000` for interest of `$1,210` on August 21st, 2026");
    expect(formattedResult).toContain("Implied lending rate: `3.94%`");
    expect(formattedResult).toContain("Limit: mid debit `987.90` (`$98,790`)");
    expect(formattedResult).toContain("Buy 1 Aug21'26 6000 Call");
    expect(formattedResult).toContain("Sell 1 Aug21'26 6000 Put");
    expect(formattedResult).toContain("Sell 1 Aug21'26 7000 Call");
    expect(formattedResult).toContain("Buy 1 Aug21'26 7000 Put");
  });

  test("uses more contracts instead of widening far beyond the preferred SPX box width", async () => {
    const getOptionContractsLookupFn = vi.fn(async () => createContractsLookupResult({
      contracts: [
        createContract(5500, "call", 1050),
        createContract(5500, "put", 25),
        createContract(6000, "call", 560),
        createContract(6000, "put", 50),
        createContract(7000, "call", 90),
        createContract(7000, "put", 567.9),
        createContract(7500, "call", 20),
        createContract(7500, "put", 1040),
      ],
    }));
    const result = await getBoxSpreadLookup({
      credentials,
      direction: "borrow",
      dte: 112,
      notational: 1_000_000,
    }, {
      getOptionContractsLookupFn,
      getSofrRateFn: vi.fn(async () => ({
        effectiveDate: "2026-04-30",
        percentRate: 3.66,
      })),
    });

    expect(result.width).toBe(1000);
    expect(result.contracts).toBe(10);
    expect(formatBoxSpreadLookupResult(result)).toContain("Sell 10 Aug21'26 6000 Call");
  });

  test("rejects invalid direction and notational before market data is used", async () => {
    const getOptionContractsLookupFn = vi.fn(async () => createContractsLookupResult());
    const getSofrRateFn = vi.fn(async () => ({
      effectiveDate: "2026-04-30",
      percentRate: 3.66,
    }));

    await expect(getBoxSpreadLookup({
      credentials,
      direction: "hold" as BoxSpreadDirection,
      dte: 112,
      notational: 100_000,
    }, {
      getOptionContractsLookupFn,
      getSofrRateFn,
    })).rejects.toThrow(OptionDeltaInputError);
    await expect(getBoxSpreadLookup({
      credentials,
      direction: "borrow",
      dte: 112,
      notational: 0,
    }, {
      getOptionContractsLookupFn,
      getSofrRateFn,
    })).rejects.toThrow(OptionDeltaInputError);
    expect(getOptionContractsLookupFn).not.toHaveBeenCalled();
  });

  test("reports unavailable box pairs and non-finite market prices", async () => {
    await expect(getBoxSpreadLookup({
      credentials,
      direction: "borrow",
      dte: 112,
      notational: 100_000,
    }, {
      getOptionContractsLookupFn: vi.fn(async () => createContractsLookupResult({
        contracts: [
          createContract(6000, "call", 560),
          createContract(6501, "put", 567),
        ],
      })),
      getSofrRateFn: vi.fn(async () => ({
        effectiveDate: "2026-04-30",
        percentRate: 3.66,
      })),
    })).rejects.toThrow(OptionDeltaDataError);

    await expect(getBoxSpreadLookup({
      credentials,
      direction: "borrow",
      dte: 112,
      notational: 100_000,
    }, {
      getOptionContractsLookupFn: vi.fn(async () => createContractsLookupResult({
        contracts: [
          {...createContract(6000, "call", 560), bid: Number.NaN},
          createContract(6000, "put", 50),
          createContract(7000, "call", 90),
          createContract(7000, "put", 567.9),
        ],
      })),
      getSofrRateFn: vi.fn(async () => ({
        effectiveDate: "2026-04-30",
        percentRate: 3.66,
      })),
    })).rejects.toThrow("Box spread limit price is unavailable.");
  });

  test("formats rolled expirations, closed markets, ordinal suffixes and negative rate delta", () => {
    const baseResult = {
      actualDte: 113,
      benchmarkName: "SOFR",
      cashToday: 98_790,
      contracts: 1,
      currency: "USD",
      direction: "borrow" as const,
      expiration: "2026-08-01",
      financingAmount: 1_210,
      impliedRate: 0.03,
      legs: [
        {action: "Sell" as const, contract: createContract(6000.5, "call", 560), quantity: 1},
        {action: "Buy" as const, contract: createContract(6000.5, "put", 50), quantity: 1},
      ],
      limitPrice: 987.9,
      naturalCredit: 985.9,
      naturalDebit: 989.9,
      notational: 100_000,
      rateDeltaToBenchmark: -0.0066,
      requestedDte: 112,
      rolled: true,
      sofr: {
        effectiveDate: "2026-04-30",
        percentRate: 3.66,
      },
      symbol: "SPX",
      underlyingPrice: null,
      underlyingPriceIsRealtime: false,
      width: 1000.5,
    };

    const first = formatBoxSpreadLookupResult(baseResult);
    expect(first).toContain("`SPX` @ `n/a` (market closed)");
    expect(first).toContain("Expiry `2026-08-01` (`113` DTE, requested `112`)");
    expect(first).toContain("August 1st, 2026");
    expect(first).toContain("Δ: `-66 bps`");
    expect(first).toContain("Sell 1 Aug21'26 6000.50 Call");

    expect(formatBoxSpreadLookupResult({...baseResult, expiration: "2026-08-02"})).toContain("August 2nd, 2026");
    expect(formatBoxSpreadLookupResult({...baseResult, expiration: "2026-08-03"})).toContain("August 3rd, 2026");
    expect(formatBoxSpreadLookupResult({...baseResult, expiration: "2026-08-11"})).toContain("August 11th, 2026");
    expect(() => formatBoxSpreadLookupResult({...baseResult, expiration: "not-a-date"})).toThrow(OptionDeltaDataError);
  });
});
