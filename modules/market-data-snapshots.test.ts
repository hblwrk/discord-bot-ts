import {afterEach, describe, expect, test} from "vitest";
import {type MarketDataAsset} from "./market-data-types.ts";
import {
  clearMarketDataSnapshots,
  getMarketDataSnapshots,
  recordMarketDataSnapshot,
} from "./market-data-snapshots.ts";

describe("market-data-snapshots", () => {
  const esAsset = {
    botClientId: "client-es",
    botName: "S&P500",
    botToken: "token",
    decimals: 2,
    id: 1175153,
    lastUpdate: 0,
    name: "es",
    order: 0,
    suffix: "",
    unit: "PCT",
  } satisfies MarketDataAsset;

  afterEach(() => {
    clearMarketDataSnapshots();
  });

  test("ignores assets that do not map to a market-close symbol", () => {
    recordMarketDataSnapshot({...esAsset, name: "dax"}, 100, 1, 1, "investing");
    expect(getMarketDataSnapshots()).toHaveLength(0);
  });

  test("stores the intraday session high and low passed from the stream", () => {
    recordMarketDataSnapshot(esAsset, 5225, 25, 0.48, "investing", undefined, 5230, 5175);
    const [snapshot] = getMarketDataSnapshots();
    expect(snapshot?.high).toBe(5230);
    expect(snapshot?.low).toBe(5175);
  });

  test("keeps the prior session high and low when a later tick omits them", () => {
    const firstTick = new Date("2026-05-07T18:00:00Z");
    const laterTick = new Date("2026-05-07T20:09:00Z");
    recordMarketDataSnapshot(esAsset, 5225, 25, 0.48, "investing", firstTick, 5230, 5175);
    recordMarketDataSnapshot(esAsset, 5228, 28, 0.54, "investing", laterTick);
    const [snapshot] = getMarketDataSnapshots();
    expect(snapshot?.lastNumeric).toBe(5228);
    expect(snapshot?.high).toBe(5230);
    expect(snapshot?.low).toBe(5175);
  });

  test("leaves high and low undefined when the feed never reports a range", () => {
    recordMarketDataSnapshot(esAsset, 5225, 25, 0.48, "investing");
    const [snapshot] = getMarketDataSnapshots();
    expect(snapshot?.high).toBeUndefined();
    expect(snapshot?.low).toBeUndefined();
  });
});
