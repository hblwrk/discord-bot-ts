import {describe, expect, test, vi} from "vitest";
import {
  formatBoxSpreadLookupResult,
  getBoxSpreadLookup,
  type BoxSpreadDirection,
} from "./options-boxspread.ts";
import {type OptionContractsLookupResult, type OptionDeltaContract} from "./options-delta.ts";

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
});
