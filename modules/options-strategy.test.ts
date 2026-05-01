import {describe, expect, test, vi} from "vitest";
import {BoundedTtlCache} from "./bounded-ttl-cache.ts";
import {
  type ChainExpiration,
  type OptionDeltaLookupDependencies,
  type OptionMarketDataSnapshot,
} from "./options-delta.ts";
import {
  formatExpectedMoveLookupResult,
  formatOptionStraddleLookupResult,
  formatOptionStrangleLookupResult,
  getOptionStraddleLookup,
  getOptionStrangleLookup,
} from "./options-strategy.ts";

const immediateRateLimiter = {
  run: <T>(operation: () => Promise<T>) => operation(),
};

function createLookupDependencies(): Pick<OptionDeltaLookupDependencies, "chainCache" | "contractCache" | "rateLimiter"> {
  return {
    chainCache: new BoundedTtlCache<ChainExpiration[]>({
      maxEntries: 10,
      ttlMs: 60_000,
    }),
    contractCache: new BoundedTtlCache<OptionMarketDataSnapshot>({
      maxEntries: 10,
      ttlMs: 60_000,
    }),
    rateLimiter: immediateRateLimiter,
  };
}

function createNestedOptionChainItems() {
  return [{
    expirations: [{
      "expiration-date": "2026-06-19",
      "days-to-expiration": 49,
      strikes: [
        {
          "strike-price": "440",
          call: "AAPL 260619C00440000",
          "call-streamer-symbol": ".AAPL260619C440",
          put: "AAPL 260619P00440000",
          "put-streamer-symbol": ".AAPL260619P440",
        },
        {
          "strike-price": "445",
          call: "AAPL 260619C00445000",
          "call-streamer-symbol": ".AAPL260619C445",
          put: "AAPL 260619P00445000",
          "put-streamer-symbol": ".AAPL260619P445",
        },
      ],
    }],
  }];
}

function createFakeClient() {
  let listener: ((events: Record<string, unknown>[]) => void) | undefined;
  const marketDataBySymbol = new Map<string, {
    ask: number;
    bid: number;
    delta: number;
  }>([
    ["AAPL", {ask: 442.02, bid: 441.98, delta: 0}],
    [".AAPL260619C440", {ask: 6.2, bid: 6.0, delta: 0.52}],
    [".AAPL260619C445", {ask: 2.2, bid: 2.0, delta: 0.17}],
    [".AAPL260619P440", {ask: 2.4, bid: 2.2, delta: -0.18}],
    [".AAPL260619P445", {ask: 6.4, bid: 6.2, delta: -0.51}],
  ]);

  return {
    instrumentsService: {
      getNestedOptionChain: vi.fn(async () => createNestedOptionChainItems()),
    },
    quoteStreamer: {
      addEventListener: vi.fn((nextListener: (events: Record<string, unknown>[]) => void) => {
        listener = nextListener;
        return vi.fn();
      }),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(),
      subscribe: vi.fn((streamerSymbols: string[]) => {
        listener?.(streamerSymbols.flatMap(streamerSymbol => {
          const marketData = marketDataBySymbol.get(streamerSymbol);
          if (undefined === marketData) {
            return [];
          }

          return [
            {
              eventSymbol: streamerSymbol,
              eventType: "Quote",
              askPrice: marketData.ask,
              bidPrice: marketData.bid,
            },
            ...("AAPL" === streamerSymbol ? [] : [{
              eventSymbol: streamerSymbol,
              eventType: "Greeks",
              delta: marketData.delta,
              volatility: 0.45,
            }]),
          ];
        }));
      }),
    },
  };
}

const marketOpenLookupDependencies = {
  ...createLookupDependencies(),
  now: () => new Date("2026-05-01T10:00:00-04:00").valueOf(),
};

describe("options-strategy", () => {
  test("builds and formats a default-delta strangle", async () => {
    const fakeClient = createFakeClient();
    const result = await getOptionStrangleLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      dte: 49,
      symbol: "AAPL",
    }, {
      ...marketOpenLookupDependencies,
      clientFactory: () => fakeClient,
      marketDataTimeoutMs: 20,
    });

    expect(result.targetDelta).toBe(0.16);
    expect(result.call?.strike).toBe(445);
    expect(result.put?.strike).toBe(440);
    expect(result.midTotal).toBe(4.4);
    expect(result.underlyingPrice).toBe(442);
    const formattedResult = formatOptionStrangleLookupResult(result);
    expect(formattedResult.split("\n")[0]).toBe("`AAPL` @ `442.00` | Strangle | Δ target `0.16` | Expiry `2026-06-19` (`49` DTE)");
    expect(formattedResult).toContain("Breakevens: `435.60 / 449.40`");
  });

  test("builds an ATM straddle and expected-move output with monospace market values", async () => {
    const fakeClient = createFakeClient();
    const result = await getOptionStraddleLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      dte: 49,
      symbol: "AAPL",
    }, {
      ...marketOpenLookupDependencies,
      clientFactory: () => fakeClient,
      marketDataTimeoutMs: 20,
    });

    const formattedStraddleResult = formatOptionStraddleLookupResult(result);
    const formattedResult = formatExpectedMoveLookupResult(result);
    expect(result.targetDelta).toBe(0.5);
    expect(result.call?.strike).toBe(440);
    expect(result.put?.strike).toBe(445);
    expect(result.midTotal).toBe(12.4);
    expect(formattedStraddleResult.split("\n")[0]).toBe("`AAPL` @ `442.00` | ATM Straddle | Expiry `2026-06-19` (`49` DTE)");
    expect(formattedResult.split("\n")[0]).toBe("`AAPL` @ `442.00` | Expected Move | Expiry `2026-06-19` (`49` DTE)");
    expect(formattedResult).toContain("ATM straddle mid `12.40`");
    expect(formattedResult).toContain("Move proxy: `+/- 12.40`");
  });
});
