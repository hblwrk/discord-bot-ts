import {describe, expect, test} from "vitest";
import type {OptionDeltaContract} from "./options-delta.ts";
import {
  formatOptionDeltaLookupResult,
  getClosestDeltaContract,
  getOptionContractSpreadPercent,
} from "./options-format.ts";

function createContract(strike: number, delta: number, optionType: "call" | "put", bid = 1, ask = 1.2): OptionDeltaContract {
  return {
    ask,
    askSize: 10,
    bid,
    bidSize: 10,
    delta,
    expirationDate: "2026-06-19",
    gamma: null,
    iv: null,
    optionType,
    streamerSymbol: `.SPX260619${"call" === optionType ? "C" : "P"}${strike}`,
    strike,
    symbol: `SPX 260619${"call" === optionType ? "C" : "P"}${strike}`,
    theta: null,
    vega: null,
  };
}

describe("options-format", () => {
  test("selects closest delta contracts and marks wide spreads", () => {
    const below = createContract(6000, 0.25, "call");
    const above = createContract(6100, 0.35, "call", 1, 2);

    expect(getClosestDeltaContract({below, above: null}, 0.3)).toBe(below);
    expect(getClosestDeltaContract({below, above}, 0.34)).toBe(above);
    expect(getOptionContractSpreadPercent({...above, bid: 0, ask: 0})).toBeNull();

    const formatted = formatOptionDeltaLookupResult({
      actualDte: 49,
      expiration: "2026-06-19",
      requestedDte: 49,
      requestedSide: "call",
      rolled: false,
      sideResults: [{
        brackets: {
          above,
          below,
        },
        contractsConsidered: 2,
        side: "call",
      }],
      symbol: "SPX",
      targetDelta: 0.3,
      underlyingPrice: 6500,
      underlyingPriceIsRealtime: true,
    });

    expect(formatted).toContain("`wide spread`");
  });
});
