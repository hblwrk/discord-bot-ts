import {describe, expect, test, vi} from "vitest";
import {
  formatBoxRatesLookupResult,
  getBoxRatesLookup,
} from "./options-boxrates.ts";
import {
  type ChainExpiration,
  type OptionDeltaContract,
  type OptionSelectedContractsLookupRequest,
  OptionDeltaDataError,
  OptionDeltaInputError,
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

function createChainExpiration(
  expirationDate: string,
  daysToExpiration: number,
  strikes = [6000, 7000],
): ChainExpiration {
  return {
    daysToExpiration,
    expirationDate,
    strikes: strikes.map(strike => ({
      callStreamerSymbol: `.SPX${getOptionCode(expirationDate)}C${strike}`,
      callSymbol: `SPX ${getOptionCode(expirationDate)}C${strike}`,
      putStreamerSymbol: `.SPX${getOptionCode(expirationDate)}P${strike}`,
      putSymbol: `SPX ${getOptionCode(expirationDate)}P${strike}`,
      strike,
    })),
  };
}

function createSofrRateLookup() {
  return vi.fn(async () => ({
    effectiveDate: "2026-04-30",
    percentRate: 3.66,
  }));
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
      getSofrRateFn: createSofrRateLookup(),
      clientFactory: vi.fn(),
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
    expect(formattedResult).toContain("`Jun19'26` | `49 DTE` | `6000/7000 x1` | Mid");
    expect(formattedResult).toContain("`Jul17'26` | `77 DTE` | `6000/7000 x1` | Mid");
  });

  test("rejects invalid inputs before requesting market data", async () => {
    await expect(getBoxRatesLookup({
      credentials,
      months: 0,
    })).rejects.toThrow(OptionDeltaInputError);
    await expect(getBoxRatesLookup({
      credentials,
      notational: 0,
    })).rejects.toThrow(OptionDeltaInputError);
  });

  test("reports when no monthly strike pair can match the requested notational", async () => {
    const getSelectedOptionContractsLookupFn = vi.fn(async () => ({
      contracts: [],
      symbol: "SPX",
      underlyingPrice: null,
      underlyingPriceIsRealtime: false,
    }));

    await expect(getBoxRatesLookup({
      credentials,
      months: 1,
      notational: 100_000,
    }, {
      getOptionChainLookupFn: vi.fn(async () => ({
        expirations: [createChainExpiration("2026-06-19", 49, [6000, 6501])],
        symbol: "SPX",
      })),
      getSelectedOptionContractsLookupFn,
      getSofrRateFn: createSofrRateLookup(),
      now: () => Date.parse("2026-05-01T12:00:00Z"),
    })).rejects.toThrow(OptionDeltaDataError);
    expect(getSelectedOptionContractsLookupFn).toHaveBeenCalledTimes(1);
  });

  test("skips unavailable rows and keeps available monthly rates", async () => {
    const juneExpiration = createChainExpiration("2026-06-19", 49);
    const julyExpiration = createChainExpiration("2026-07-17", 77);
    const getSelectedOptionContractsLookupFn = vi.fn(async (request: OptionSelectedContractsLookupRequest) => {
      if (0 === request.selections.length) {
        return {
          contracts: [],
          symbol: "SPX",
          underlyingPrice: null,
          underlyingPriceIsRealtime: false,
        };
      }

      return {
        contracts: [
          createContract(6000, "call", 545, "2026-07-17"),
          createContract(6000, "put", 50, "2026-07-17"),
          createContract(7000, "call", 88, "2026-07-17"),
          createContract(7000, "put", 583, "2026-07-17"),
        ],
        symbol: "SPX",
        underlyingPrice: null,
        underlyingPriceIsRealtime: false,
      };
    });

    const result = await getBoxRatesLookup({
      credentials,
      months: 2,
    }, {
      getOptionChainLookupFn: vi.fn(async () => ({
        expirations: [juneExpiration, julyExpiration],
        symbol: "SPX",
      })),
      getSelectedOptionContractsLookupFn,
      getSofrRateFn: createSofrRateLookup(),
      now: () => Date.parse("2026-05-01T12:00:00Z"),
    });

    expect(result.notational).toBe(100_000);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.expiration).toBe("2026-07-17");
  });

  test("reports when selected legs never produce a complete rate row", async () => {
    const expiration = createChainExpiration("2026-06-19", 49);
    const getSelectedOptionContractsLookupFn = vi.fn(async (request: OptionSelectedContractsLookupRequest) => {
      return {
        contracts: 0 === request.selections.length
          ? []
          : [createContract(6000, "call", 525, "2026-06-19")],
        symbol: "SPX",
        underlyingPrice: 6500,
        underlyingPriceIsRealtime: true,
      };
    });

    await expect(getBoxRatesLookup({
      credentials,
      months: 1,
    }, {
      getOptionChainLookupFn: vi.fn(async () => ({
        expirations: [expiration],
        symbol: "SPX",
      })),
      getSelectedOptionContractsLookupFn,
      getSofrRateFn: createSofrRateLookup(),
      now: () => Date.parse("2026-05-01T12:00:00Z"),
    })).rejects.toThrow(OptionDeltaDataError);
  });

  test("skips rows whose selected legs cannot produce a positive mid rate", async () => {
    const expiration = createChainExpiration("2026-06-19", 49);
    const getSelectedOptionContractsLookupFn = vi.fn(async (request: OptionSelectedContractsLookupRequest) => {
      return {
        contracts: 0 === request.selections.length
          ? []
          : [
            createContract(6000, "call", 1, "2026-06-19"),
            createContract(6000, "put", 1, "2026-06-19"),
            createContract(7000, "call", 1, "2026-06-19"),
            createContract(7000, "put", 1, "2026-06-19"),
          ],
        symbol: "SPX",
        underlyingPrice: 6500,
        underlyingPriceIsRealtime: true,
      };
    });

    await expect(getBoxRatesLookup({
      credentials,
      months: 1,
    }, {
      getOptionChainLookupFn: vi.fn(async () => ({
        expirations: [expiration],
        symbol: "SPX",
      })),
      getSelectedOptionContractsLookupFn,
      getSofrRateFn: createSofrRateLookup(),
      now: () => Date.parse("2026-05-01T12:00:00Z"),
    })).rejects.toThrow(OptionDeltaDataError);
  });

  test("prefers the third-Friday expiration inside a month", async () => {
    const weeklyExpiration = createChainExpiration("2026-06-12", 42);
    const monthlyExpiration = createChainExpiration("2026-06-19", 49);
    const getSelectedOptionContractsLookupFn = vi.fn(async (request: OptionSelectedContractsLookupRequest) => {
      return {
        contracts: 0 === request.selections.length
          ? []
          : [
            createContract(6000, "call", 525, "2026-06-19"),
            createContract(6000, "put", 50, "2026-06-19"),
            createContract(7000, "call", 80, "2026-06-19"),
            createContract(7000, "put", 595, "2026-06-19"),
          ],
        symbol: "SPX",
        underlyingPrice: 6500,
        underlyingPriceIsRealtime: true,
      };
    });

    const result = await getBoxRatesLookup({
      credentials,
      months: 1,
    }, {
      getOptionChainLookupFn: vi.fn(async () => ({
        expirations: [weeklyExpiration, monthlyExpiration],
        symbol: "SPX",
      })),
      getSelectedOptionContractsLookupFn,
      getSofrRateFn: createSofrRateLookup(),
      now: () => Date.parse("2026-05-01T12:00:00Z"),
    });

    expect(result.rows[0]?.expiration).toBe("2026-06-19");
  });

  test("formats signed money and basis points", () => {
    const formattedResult = formatBoxRatesLookupResult({
      benchmarkName: "SOFR",
      notational: -100_000,
      rows: [{
        actualDte: 49,
        borrowRate: 0.02,
        contracts: 1,
        expiration: "2026-06-19",
        lendRate: 0.01,
        lowerStrike: 6000,
        midRate: 0.015,
        rateDeltaToBenchmark: -0.01,
        upperStrike: 7000,
      }, {
        actualDte: 77,
        borrowRate: 0.68,
        contracts: 1,
        expiration: "2026-07-17",
        lendRate: -0.57,
        lowerStrike: 6000,
        midRate: 0.04,
        rateDeltaToBenchmark: 0.004,
        upperStrike: 7000,
      }],
      sofr: {
        effectiveDate: "2026-04-30",
        percentRate: 2.5,
      },
      symbol: "SPX",
      underlyingPrice: null,
      underlyingPriceIsRealtime: false,
    });

    expect(formattedResult).toContain("Notational `-$100,000`");
    expect(formattedResult).toContain("Mkt `1.00%-2.00%`");
    expect(formattedResult).toContain("Mkt `wide`");
    expect(formattedResult).toContain("Δ `-100 bps`");
  });
});
