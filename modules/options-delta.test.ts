import {MarketDataSubscriptionType} from "@tastytrade/api";
import {describe, expect, test, vi} from "vitest";
import {BoundedTtlCache} from "./bounded-ttl-cache.ts";
import {
  type ChainExpiration,
  findDeltaBrackets,
  formatOptionDeltaLookupResult,
  getOptionDeltaLookup,
  normalizeOptionSymbol,
  normalizeTargetDelta,
  OptionDeltaConfigurationError,
  OptionDeltaDataError,
  OptionDeltaInputError,
  parseTastytradeNestedOptionChain,
  selectExpirationForDte,
  type OptionDeltaContract,
  type OptionDeltaLookupDependencies,
} from "./options-delta.ts";

const immediateRateLimiter = {
  run: <T>(operation: () => Promise<T>) => operation(),
};

function createLookupDependencies(): Pick<OptionDeltaLookupDependencies, "chainCache" | "contractCache" | "rateLimiter"> {
  return {
    chainCache: new BoundedTtlCache<ChainExpiration[]>({
      maxEntries: 10,
      ttlMs: 60_000,
    }),
    contractCache: new BoundedTtlCache<OptionDeltaContract[]>({
      maxEntries: 10,
      ttlMs: 60_000,
    }),
    rateLimiter: immediateRateLimiter,
  };
}

function createNestedOptionChainItems() {
  return [{
    expirations: [
      {
        "expiration-date": "2026-06-12",
        "days-to-expiration": 42,
        strikes: [],
      },
      {
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
          {
            "strike-price": "450",
            call: "AAPL 260619C00450000",
            "call-streamer-symbol": ".AAPL260619C450",
            put: "AAPL 260619P00450000",
            "put-streamer-symbol": ".AAPL260619P450",
          },
        ],
      },
    ],
  }];
}

function createOptionContract(strike: number, delta: number, optionType: "call" | "put"): OptionDeltaContract {
  return {
    ask: 1.4,
    askSize: 20,
    bid: 1.2,
    bidSize: 10,
    delta,
    expirationDate: "2026-06-19",
    gamma: 0.02,
    iv: 0.555,
    optionType,
    streamerSymbol: `.AAPL260619${"call" === optionType ? "C" : "P"}${strike}`,
    strike,
    symbol: `AAPL 260619${"call" === optionType ? "C" : "P"}${strike}`,
    theta: -0.04,
    vega: 0.08,
  };
}

describe("options-delta", () => {
  test("normalizes symbols and rejects unsupported input", () => {
    expect(normalizeOptionSymbol("brk.b")).toBe("BRK/B");
    expect(() => normalizeOptionSymbol("AAPL$")).toThrow(OptionDeltaInputError);
    expect(normalizeTargetDelta(0.4)).toBe(0.4);
    expect(() => normalizeTargetDelta(1)).toThrow(OptionDeltaInputError);
  });

  test("parses sdk and raw option-chain shapes and rolls to the next expiration", () => {
    const sdkExpirations = parseTastytradeNestedOptionChain(createNestedOptionChainItems());
    const rawExpirations = parseTastytradeNestedOptionChain({
      data: {
        items: createNestedOptionChainItems(),
      },
    });

    expect(sdkExpirations).toHaveLength(2);
    expect(rawExpirations).toHaveLength(2);
    expect(selectExpirationForDte(sdkExpirations, 42)).toMatchObject({
      expiration: {
        expirationDate: "2026-06-12",
        daysToExpiration: 42,
      },
      rolled: false,
    });
    expect(selectExpirationForDte(sdkExpirations, 45)).toMatchObject({
      expiration: {
        expirationDate: "2026-06-19",
        daysToExpiration: 49,
      },
      rolled: true,
    });
  });

  test("finds contracts below and above an absolute target delta", () => {
    const brackets = findDeltaBrackets([
      createOptionContract(440, 0.38, "call"),
      createOptionContract(445, 0.32, "call"),
      createOptionContract(450, 0.25, "call"),
    ], 0.3);

    expect(brackets.below?.strike).toBe(450);
    expect(brackets.above?.strike).toBe(445);
  });

  test("fetches the selected expiration and brackets calls and puts from streamed greeks", async () => {
    let listener: ((events: Record<string, unknown>[]) => void) | undefined;
    const marketDataBySymbol = new Map<string, {
      ask: number;
      askSize: number;
      bid: number;
      bidSize: number;
      delta: number;
      volatility: number;
    }>([
      [".AAPL260619C440", {ask: 3.2, askSize: 12, bid: 3.0, bidSize: 8, delta: 0.38, volatility: 0.51}],
      [".AAPL260619C445", {ask: 2.3, askSize: 10, bid: 2.1, bidSize: 7, delta: 0.32, volatility: 0.53}],
      [".AAPL260619C450", {ask: 1.4, askSize: 20, bid: 1.2, bidSize: 10, delta: 0.25, volatility: 0.555}],
      [".AAPL260619P440", {ask: 1.1, askSize: 9, bid: 0.9, bidSize: 6, delta: -0.24, volatility: 0.54}],
      [".AAPL260619P445", {ask: 1.7, askSize: 11, bid: 1.5, bidSize: 7, delta: -0.27, volatility: 0.56}],
      [".AAPL260619P450", {ask: 2.6, askSize: 14, bid: 2.4, bidSize: 8, delta: -0.34, volatility: 0.58}],
    ]);
    const quoteStreamer = {
      addEventListener: vi.fn((nextListener: (events: Record<string, unknown>[]) => void) => {
        listener = nextListener;
        return vi.fn();
      }),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(),
      subscribe: vi.fn((streamerSymbols: string[]) => {
        const events: Record<string, unknown>[] = [];
        for (const streamerSymbol of streamerSymbols) {
          const marketData = marketDataBySymbol.get(streamerSymbol);
          if (undefined === marketData) {
            continue;
          }

          events.push({
            eventSymbol: streamerSymbol,
            eventType: "Quote",
            askPrice: marketData.ask,
            askSize: marketData.askSize,
            bidPrice: marketData.bid,
            bidSize: marketData.bidSize,
          });
          events.push({
            eventSymbol: streamerSymbol,
            eventType: "Greeks",
            delta: marketData.delta,
            gamma: 0.02,
            theta: -0.04,
            vega: 0.08,
            volatility: marketData.volatility,
          });
        }

        listener?.(events);
      }),
    };
    const fakeClient = {
      instrumentsService: {
        getNestedOptionChain: vi.fn(async () => createNestedOptionChainItems()),
      },
      quoteStreamer,
    };

    const result = await getOptionDeltaLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      delta: 0.3,
      dte: 45,
      side: "both",
      symbol: "aapl",
    }, {
      ...createLookupDependencies(),
      clientFactory: () => fakeClient,
      marketDataTimeoutMs: 20,
    });

    const callResult = result.sideResults.find(sideResult => "call" === sideResult.side);
    const putResult = result.sideResults.find(sideResult => "put" === sideResult.side);
    expect(fakeClient.instrumentsService.getNestedOptionChain).toHaveBeenCalledWith("AAPL");
    expect(quoteStreamer.subscribe).toHaveBeenCalledWith(expect.arrayContaining([
      ".AAPL260619C440",
      ".AAPL260619C445",
      ".AAPL260619C450",
      ".AAPL260619P440",
      ".AAPL260619P445",
      ".AAPL260619P450",
    ]), [
      MarketDataSubscriptionType.Greeks,
      MarketDataSubscriptionType.Quote,
    ]);
    expect(quoteStreamer.disconnect).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      actualDte: 49,
      expiration: "2026-06-19",
      requestedDte: 45,
      requestedSide: "both",
      rolled: true,
      symbol: "AAPL",
      targetDelta: 0.3,
    });
    expect(callResult?.contractsConsidered).toBe(3);
    expect(callResult?.brackets.below?.strike).toBe(450);
    expect(callResult?.brackets.above?.strike).toBe(445);
    expect(putResult?.contractsConsidered).toBe(3);
    expect(putResult?.brackets.below?.strike).toBe(445);
    expect(putResult?.brackets.above?.strike).toBe(450);

    const formattedResult = formatOptionDeltaLookupResult(result);
    expect(formattedResult).toContain("Expiry `2026-06-19` (`49` DTE, requested `45`)");
    expect(formattedResult).toContain("`450C` | strike `450` | delta `0.250`");
    expect(formattedResult).toContain("bid/mid/ask `1.20 / 1.30 / 1.40`");
    expect(formattedResult).toContain("spread `15.4%`");
    expect(formattedResult).toContain("IV `55.5%`");
    expect(formattedResult).toContain("`450P` | strike `450` | delta `0.340`");
  });

  test("supports single-side lookups and hyphenated dxlink event fields", async () => {
    let listener: ((events: Record<string, unknown>[]) => void) | undefined;
    const quoteStreamer = {
      addEventListener: vi.fn((nextListener: (events: Record<string, unknown>[]) => void) => {
        listener = nextListener;
        return vi.fn();
      }),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(),
      subscribe: vi.fn((streamerSymbols: string[]) => {
        listener?.(streamerSymbols.flatMap(streamerSymbol => [
          {
            "event-symbol": streamerSymbol,
            "event-type": "Quote",
            "ask-price": 2.2,
            "ask-size": 12,
            "bid-price": 2.0,
            "bid-size": 8,
          },
          {
            "event-symbol": streamerSymbol,
            "event-type": "Greeks",
            delta: -0.31,
            volatility: 0.45,
          },
        ]));
      }),
    };

    const result = await getOptionDeltaLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      delta: 0.3,
      dte: 49,
      side: "put",
      symbol: "aapl",
    }, {
      ...createLookupDependencies(),
      clientFactory: () => ({
        instrumentsService: {
          getNestedOptionChain: vi.fn(async () => createNestedOptionChainItems()),
        },
        quoteStreamer,
      }),
      marketDataTimeoutMs: 20,
    });

    expect(result.requestedSide).toBe("put");
    expect(result.sideResults).toHaveLength(1);
    expect(result.sideResults[0]).toMatchObject({
      side: "put",
      contractsConsidered: 3,
    });
    expect(quoteStreamer.subscribe).toHaveBeenCalledWith(expect.arrayContaining([
      ".AAPL260619P440",
      ".AAPL260619P445",
      ".AAPL260619P450",
    ]), [
      MarketDataSubscriptionType.Greeks,
      MarketDataSubscriptionType.Quote,
    ]);
    expect(quoteStreamer.subscribe.mock.calls[0]![0]).not.toContain(".AAPL260619C440");
  });

  test("reuses cached chain and contract snapshots without another broker call", async () => {
    let listener: ((events: Record<string, unknown>[]) => void) | undefined;
    const lookupDependencies = createLookupDependencies();
    const quoteStreamer = {
      addEventListener: vi.fn((nextListener: (events: Record<string, unknown>[]) => void) => {
        listener = nextListener;
        return vi.fn();
      }),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(),
      subscribe: vi.fn((streamerSymbols: string[]) => {
        listener?.(streamerSymbols.flatMap(streamerSymbol => [
          {
            eventSymbol: streamerSymbol,
            eventType: "Quote",
            askPrice: 1.2,
            bidPrice: 1.0,
          },
          {
            eventSymbol: streamerSymbol,
            eventType: "Greeks",
            delta: streamerSymbol.includes("P") ? -0.31 : 0.31,
            volatility: 0.45,
          },
        ]));
      }),
    };
    const fakeClient = {
      instrumentsService: {
        getNestedOptionChain: vi.fn(async () => createNestedOptionChainItems()),
      },
      quoteStreamer,
    };
    const request = {
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      delta: 0.3,
      dte: 49,
      side: "both" as const,
      symbol: "AAPL",
    };

    await getOptionDeltaLookup(request, {
      ...lookupDependencies,
      clientFactory: () => fakeClient,
      marketDataTimeoutMs: 20,
    });
    const cachedResult = await getOptionDeltaLookup({
      ...request,
      delta: 0.2,
      side: "call",
    }, {
      ...lookupDependencies,
      clientFactory: () => fakeClient,
      marketDataTimeoutMs: 20,
    });

    expect(fakeClient.instrumentsService.getNestedOptionChain).toHaveBeenCalledTimes(1);
    expect(quoteStreamer.subscribe).toHaveBeenCalledTimes(1);
    expect(cachedResult.sideResults).toHaveLength(1);
    expect(cachedResult.sideResults[0]?.side).toBe("call");
  });

  test("reports missing credentials, expirations and streamer symbols as lookup errors", async () => {
    const emptyQuoteStreamer = {
      addEventListener: vi.fn(() => vi.fn()),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
    };
    const baseRequest = {
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      delta: 0.3,
      dte: 45,
      side: "call" as const,
      symbol: "AAPL",
    };

    await expect(getOptionDeltaLookup({
      ...baseRequest,
      credentials: {
        clientSecret: " ",
        refreshToken: "refresh-token",
      },
    }, createLookupDependencies())).rejects.toThrow(OptionDeltaConfigurationError);
    await expect(getOptionDeltaLookup({
      ...baseRequest,
      dte: 45.5,
    }, createLookupDependencies())).rejects.toThrow(OptionDeltaInputError);
    await expect(getOptionDeltaLookup(baseRequest, {
      ...createLookupDependencies(),
      clientFactory: () => ({
        instrumentsService: {
          getNestedOptionChain: vi.fn(async () => []),
        },
        quoteStreamer: emptyQuoteStreamer,
      }),
    })).rejects.toThrow(OptionDeltaDataError);
    await expect(getOptionDeltaLookup(baseRequest, {
      ...createLookupDependencies(),
      clientFactory: () => ({
        instrumentsService: {
          getNestedOptionChain: vi.fn(async () => [{
            expirations: [{
              "expiration-date": "2026-06-19",
              "days-to-expiration": 49,
              strikes: [{
                "strike-price": "450",
              }],
            }],
          }]),
        },
        quoteStreamer: emptyQuoteStreamer,
      }),
    })).rejects.toThrow(OptionDeltaDataError);
  });

  test("formats unavailable quotes and missing brackets", () => {
    const formattedResult = formatOptionDeltaLookupResult({
      actualDte: 49,
      expiration: "2026-06-19",
      requestedDte: 49,
      requestedSide: "put",
      rolled: false,
      sideResults: [{
        brackets: {
          above: {
            ...createOptionContract(450, -0.34, "put"),
            ask: null,
            askSize: null,
            bid: null,
            bidSize: null,
            iv: null,
          },
          below: null,
        },
        contractsConsidered: 1,
        side: "put",
      }],
      symbol: "AAPL",
      targetDelta: 0.3,
    });

    expect(formattedResult).toContain("Expiry `2026-06-19` (`49` DTE)");
    expect(formattedResult).toContain("Below target: Keine passende Option gefunden.");
    expect(formattedResult).toContain("bid/mid/ask `n/a / n/a / n/a`");
    expect(formattedResult).toContain("size `n/a x n/a`");
    expect(formattedResult).toContain("IV `n/a`");
  });
});
