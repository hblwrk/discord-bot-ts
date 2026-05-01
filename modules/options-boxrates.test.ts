import {describe, expect, test, vi} from "vitest";
import {
  formatBoxRatesLookupResult,
  getBoxRatesLookup,
} from "./options-boxrates.ts";
import {
  type ChainExpiration,
  type OptionDeltaContract,
  type OptionSelectedContractsLookupRequest,
} from "./options-delta.ts";

const credentials = {
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
};

function getOptionCode(expirationDate: string): string {
  return expirationDate.replaceAll("-", "").slice(2);
}

function createContract(
  strike: number,
  optionType: "call" | "put",
  mid: number,
  expirationDate: string,
): OptionDeltaContract {
  return {
    ask: mid + 0.5,
    askSize: 20,
    bid: mid - 0.5,
    bidSize: 20,
    delta: "call" === optionType ? 0.5 : -0.5,
    expirationDate,
    gamma: 0.01,
    iv: 0.2,
    optionType,
    streamerSymbol: `.SPX${getOptionCode(expirationDate)}${"call" === optionType ? "C" : "P"}${strike}`,
    strike,
    symbol: `SPX ${getOptionCode(expirationDate)}${"call" === optionType ? "C" : "P"}${strike}`,
    theta: -0.01,
    vega: 0.1,
  };
}

function createChainExpiration(expirationDate: string, daysToExpiration: number): ChainExpiration {
  return {
    daysToExpiration,
    expirationDate,
    strikes: [6000, 7000].map(strike => ({
      callStreamerSymbol: `.SPX${getOptionCode(expirationDate)}C${strike}`,
      callSymbol: `SPX ${getOptionCode(expirationDate)}C${strike}`,
      putStreamerSymbol: `.SPX${getOptionCode(expirationDate)}P${strike}`,
      putSymbol: `SPX ${getOptionCode(expirationDate)}P${strike}`,
      strike,
    })),
  };
}

describe("options-boxrates", () => {
  test("builds and formats monthly SPX box rates from selected legs only", async () => {
    const juneExpiration = createChainExpiration("2026-06-19", 49);
    const julyExpiration = createChainExpiration("2026-07-17", 77);
    const getOptionChainLookupFn = vi.fn(async () => ({
      expirations: [juneExpiration, julyExpiration],
      symbol: "SPX",
    }));
    const getSelectedOptionContractsLookupFn = vi.fn(async (request: OptionSelectedContractsLookupRequest) => {
      if (0 === request.selections.length) {
        return {
          contracts: [],
          symbol: "SPX",
          underlyingPrice: 6500,
          underlyingPriceIsRealtime: true,
        };
      }

      return {
        contracts: [
          createContract(6000, "call", 525, "2026-06-19"),
          createContract(6000, "put", 50, "2026-06-19"),
          createContract(7000, "call", 80, "2026-06-19"),
          createContract(7000, "put", 595, "2026-06-19"),
          createContract(6000, "call", 545, "2026-07-17"),
          createContract(6000, "put", 50, "2026-07-17"),
          createContract(7000, "call", 88, "2026-07-17"),
          createContract(7000, "put", 583, "2026-07-17"),
        ],
        symbol: "SPX",
        underlyingPrice: 6501,
        underlyingPriceIsRealtime: true,
      };
    });

    const result = await getBoxRatesLookup({
      credentials,
      months: 2,
      notational: 100_000,
    }, {
      getOptionChainLookupFn,
      getSelectedOptionContractsLookupFn,
      getSofrRateFn: vi.fn(async () => ({
        effectiveDate: "2026-04-30",
        percentRate: 3.66,
      })),
      now: () => Date.parse("2026-05-01T12:00:00Z"),
    });
    const formattedResult = formatBoxRatesLookupResult(result);

    expect(getOptionChainLookupFn).toHaveBeenCalledWith({
      credentials,
      symbol: "SPX",
    }, expect.any(Object));
    expect(getSelectedOptionContractsLookupFn).toHaveBeenCalledTimes(2);
    expect(getSelectedOptionContractsLookupFn.mock.calls[1]?.[0].selections).toHaveLength(8);
    expect(result.rows).toHaveLength(2);
    expect(formattedResult.split("\n")[0]).toBe("Boxspread rates für die nächsten 12 Monate");
    expect(formattedResult).toContain("`SPX` @ `6,501.00` | Notational `$100,000` | SOFR: `3.66%` (2026-04-30)");
    expect(formattedResult).toContain("`Jun26` | `49 DTE` | `6000/7000 x1` | Lend");
    expect(formattedResult).toContain("`Jul26` | `77 DTE` | `6000/7000 x1` | Lend");
  });
});
