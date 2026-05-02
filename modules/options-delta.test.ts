import {MarketDataSubscriptionType} from "@tastytrade/api";
import {describe, expect, test, vi} from "vitest";
import {BoundedTtlCache} from "./bounded-ttl-cache.ts";
import {
  type ChainExpiration,
  findDeltaBrackets,
  getOptionChainLookup,
  formatOptionDeltaLookupResult,
  getOptionDeltaLookup,
  getSelectedOptionContractsLookup,
  getOptionContractsLookup,
  normalizeOptionSymbol,
  normalizeDte,
  normalizeTargetDelta,
  OptionDeltaConfigurationError,
  OptionDeltaDataError,
  OptionDeltaInputError,
  parseTastytradeNestedOptionChain,
  selectExpirationForDte,
  type OptionDeltaContract,
  type OptionDeltaLookupDependencies,
  type OptionMarketDataSnapshot,
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
    contractCache: new BoundedTtlCache<OptionMarketDataSnapshot>({
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
    expect(normalizeDte(0)).toBe(0);
    expect(() => normalizeDte(-1)).toThrow(OptionDeltaInputError);
    expect(() => normalizeDte(3651)).toThrow(OptionDeltaInputError);
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
    expect(selectExpirationForDte(sdkExpirations, 3650)).toBeNull();
  });

  test("ignores malformed option-chain items while preserving valid strikes", () => {
    expect(parseTastytradeNestedOptionChain(null)).toEqual([]);
    expect(parseTastytradeNestedOptionChain({
      items: [
        null,
        {
          expirations: [
            null,
            {
              "expiration-date": "2026-06-19",
              "days-to-expiration": "49",
              strikes: [
                null,
                {"strike-price": "bad"},
                {
                  "strike-price": "450",
                  call: "AAPL 260619C00450000",
                  "call-streamer-symbol": ".AAPL260619C450",
                  put: " ",
                },
              ],
            },
            {
              "expiration-date": " ",
              "days-to-expiration": 56,
              strikes: [],
            },
          ],
        },
      ],
    })).toEqual([{
      daysToExpiration: 49,
      expirationDate: "2026-06-19",
      strikes: [{
        callStreamerSymbol: ".AAPL260619C450",
        callSymbol: "AAPL 260619C00450000",
        putStreamerSymbol: null,
        putSymbol: null,
        strike: 450,
      }],
    }]);
  });

  test("finds contracts below and above an absolute target delta", () => {
    const brackets = findDeltaBrackets([
      createOptionContract(440, 0.38, "call"),
      createOptionContract(445, 0.32, "call"),
      createOptionContract(450, 0.25, "call"),
    ], 0.3);

    expect(brackets.below?.strike).toBe(450);
    expect(brackets.above?.strike).toBe(445);

    expect(findDeltaBrackets([
      createOptionContract(430, 0, "call"),
      createOptionContract(435, Number.NaN, "call"),
      createOptionContract(440, 1.2, "call"),
    ], 0.3)).toEqual({
      above: null,
      below: null,
    });
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
      ["AAPL", {ask: 190.44, askSize: 100, bid: 190.40, bidSize: 100, delta: 0, volatility: 0}],
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
          if ("AAPL" === streamerSymbol) {
            continue;
          }

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
      now: () => new Date("2026-05-01T10:00:00-04:00").valueOf(),
    });

    const callResult = result.sideResults.find(sideResult => "call" === sideResult.side);
    const putResult = result.sideResults.find(sideResult => "put" === sideResult.side);
    expect(fakeClient.instrumentsService.getNestedOptionChain).toHaveBeenCalledWith("AAPL");
    expect(quoteStreamer.subscribe).toHaveBeenNthCalledWith(1, expect.arrayContaining([
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
    expect(quoteStreamer.subscribe).toHaveBeenNthCalledWith(2, ["AAPL"], [
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
      underlyingPriceIsRealtime: true,
    });
    expect(result.underlyingPrice).toBeCloseTo(190.42);
    expect(callResult?.contractsConsidered).toBe(3);
    expect(callResult?.brackets.below?.strike).toBe(450);
    expect(callResult?.brackets.above?.strike).toBe(445);
    expect(putResult?.contractsConsidered).toBe(3);
    expect(putResult?.brackets.below?.strike).toBe(445);
    expect(putResult?.brackets.above?.strike).toBe(450);

    const formattedResult = formatOptionDeltaLookupResult(result);
    expect(formattedResult.split("\n")[0]).toBe("`AAPL` @ `190.42` | Δ target `0.30` | Expiry `2026-06-19` (`49` DTE, requested `45`)");
    expect(formattedResult).toContain("Expiry `2026-06-19` (`49` DTE, requested `45`)");
    expect(formattedResult).toContain("• Δ ≤ target: `450C` | Δ `0.250` | mid `1.30`");
    expect(formattedResult).toContain("bid/ask `1.20 / 1.40`");
    expect(formattedResult).toContain("spread `15.4%`");
    expect(formattedResult).toContain("IV `55.5%`");
    expect(formattedResult).toContain("• Δ ≥ target: `450P` | Δ `0.340` | mid `2.50`");
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
    expect(quoteStreamer.subscribe).toHaveBeenCalledTimes(2);
    expect(cachedResult.sideResults).toHaveLength(1);
    expect(cachedResult.sideResults[0]?.side).toBe("call");
  });

  test("fetches chain and selected contract market data without subscribing to every strike", async () => {
    let listener: ((events: Record<string, unknown>[]) => void) | undefined;
    const quoteStreamer = {
      addEventListener: vi.fn((nextListener: (events: Record<string, unknown>[]) => void) => {
        listener = nextListener;
        return vi.fn();
      }),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(),
      subscribe: vi.fn((streamerSymbols: string[]) => {
        listener?.(streamerSymbols.flatMap(streamerSymbol => {
          const quoteEvent = {
            eventSymbol: streamerSymbol,
            eventType: "Quote",
            askPrice: "AAPL" === streamerSymbol ? 190.5 : 2.2,
            askSize: 10,
            bidPrice: "AAPL" === streamerSymbol ? 190.3 : 2.0,
            bidSize: 8,
          };
          if ("AAPL" === streamerSymbol) {
            return [quoteEvent];
          }

          return [
            quoteEvent,
            {
              eventSymbol: streamerSymbol,
              eventType: "Greeks",
              delta: streamerSymbol.includes("P") ? -0.31 : 0.31,
              gamma: 0.02,
              theta: -0.04,
              vega: 0.08,
              volatility: 0.45,
            },
          ];
        }));
      }),
    };
    const fakeClient = {
      instrumentsService: {
        getNestedOptionChain: vi.fn(async () => createNestedOptionChainItems()),
      },
      quoteStreamer,
    };
    const dependencies = {
      ...createLookupDependencies(),
      clientFactory: () => fakeClient,
      marketDataTimeoutMs: 20,
      now: () => new Date("2026-05-01T10:00:00-04:00").valueOf(),
    };

    const chainResult = await getOptionChainLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      symbol: "aapl",
    }, dependencies);
    const selectedExpiration = chainResult.expirations.find(expiration => "2026-06-19" === expiration.expirationDate);
    if (undefined === selectedExpiration) {
      throw new Error("Expected test expiration.");
    }

    const result = await getSelectedOptionContractsLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      selections: [
        {expiration: selectedExpiration, side: "call", strike: 440},
        {expiration: selectedExpiration, side: "put", strike: 450},
      ],
      symbol: "aapl",
    }, dependencies);

    expect(fakeClient.instrumentsService.getNestedOptionChain).toHaveBeenCalledTimes(1);
    expect(quoteStreamer.subscribe).toHaveBeenNthCalledWith(1, [
      ".AAPL260619C440",
      ".AAPL260619P450",
    ], [
      MarketDataSubscriptionType.Greeks,
      MarketDataSubscriptionType.Quote,
    ]);
    expect(quoteStreamer.subscribe).toHaveBeenNthCalledWith(2, ["AAPL"], [
      MarketDataSubscriptionType.Quote,
    ]);
    expect(result.symbol).toBe("AAPL");
    expect(result.underlyingPrice).toBeCloseTo(190.4);
    expect(result.underlyingPriceIsRealtime).toBe(true);
    expect(result.contracts.map(contract => `${contract.strike}${contract.optionType}`)).toEqual(["440call", "450put"]);
  });

  test("supports selected underlying-only quotes and selection validation errors", async () => {
    let listener: ((events: Record<string, unknown>[]) => void) | undefined;
    const selectedExpiration = parseTastytradeNestedOptionChain(createNestedOptionChainItems())[1]!;
    const quoteStreamer = {
      addEventListener: vi.fn((nextListener: (events: Record<string, unknown>[]) => void) => {
        listener = nextListener;
        return vi.fn();
      }),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(),
      subscribe: vi.fn((streamerSymbols: string[]) => {
        listener?.(streamerSymbols.map(streamerSymbol => ({
          eventSymbol: streamerSymbol,
          eventType: "Quote",
          askPrice: 190.5,
          bidPrice: 190.3,
        })));
      }),
    };
    const fakeClient = {
      instrumentsService: {
        getNestedOptionChain: vi.fn(async () => createNestedOptionChainItems()),
      },
      quoteStreamer,
    };
    const dependencies = {
      ...createLookupDependencies(),
      clientFactory: () => fakeClient,
      marketDataTimeoutMs: 20,
    };

    const underlyingResult = await getSelectedOptionContractsLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      selections: [],
      symbol: "aapl",
    }, dependencies);

    expect(underlyingResult.contracts).toEqual([]);
    expect(underlyingResult.underlyingPrice).toBeCloseTo(190.4);
    expect(quoteStreamer.subscribe).toHaveBeenCalledTimes(1);
    expect(quoteStreamer.subscribe).toHaveBeenCalledWith(["AAPL"], [
      MarketDataSubscriptionType.Quote,
    ]);

    await expect(getSelectedOptionContractsLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      selections: [{expiration: selectedExpiration, side: "call", strike: 999}],
      symbol: "aapl",
    }, dependencies)).rejects.toThrow(OptionDeltaDataError);

    await expect(getSelectedOptionContractsLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      selections: [{
        expiration: {
          ...selectedExpiration,
          strikes: [{
            callStreamerSymbol: null,
            callSymbol: "AAPL 260619C00440000",
            putStreamerSymbol: ".AAPL260619P440",
            putSymbol: "AAPL 260619P00440000",
            strike: 440,
          }],
        },
        side: "call",
        strike: 440,
      }],
      symbol: "aapl",
    }, dependencies)).rejects.toThrow(OptionDeltaDataError);
  });

  test("returns cached chain lookups without invoking the broker client", async () => {
    const selectedExpiration = parseTastytradeNestedOptionChain(createNestedOptionChainItems())[1]!;
    const chainCache = new BoundedTtlCache<ChainExpiration[]>({
      maxEntries: 10,
      ttlMs: 60_000,
    });
    chainCache.set("AAPL", [selectedExpiration]);
    const rateLimiter = {
      run: vi.fn(),
    };

    const result = await getOptionChainLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      symbol: "aapl",
    }, {
      chainCache,
      clientFactory: vi.fn(),
      rateLimiter,
    });

    expect(result.expirations).toEqual([selectedExpiration]);
    expect(rateLimiter.run).not.toHaveBeenCalled();
  });

  test("returns cached contract lookup snapshots and filters one side from both-side cache", async () => {
    const selectedExpiration = parseTastytradeNestedOptionChain(createNestedOptionChainItems())[1]!;
    const chainCache = new BoundedTtlCache<ChainExpiration[]>({
      maxEntries: 10,
      ttlMs: 60_000,
    });
    const contractCache = new BoundedTtlCache<OptionMarketDataSnapshot>({
      maxEntries: 10,
      ttlMs: 60_000,
    });
    chainCache.set("AAPL", [selectedExpiration]);
    contractCache.set("AAPL:2026-06-19:call+put", {
      contracts: [
        createOptionContract(440, 0.31, "call"),
        createOptionContract(440, -0.31, "put"),
      ],
      underlyingPrice: 190.1,
    });
    const rateLimiter = {
      run: vi.fn(),
    };

    const result = await getOptionContractsLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      dte: 49,
      side: "put",
      symbol: "aapl",
    }, {
      chainCache,
      clientFactory: vi.fn(),
      contractCache,
      now: () => new Date("2026-05-01T20:00:00-04:00").valueOf(),
      rateLimiter,
    });

    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]?.optionType).toBe("put");
    expect(result.underlyingPrice).toBe(190.1);
    expect(result.underlyingPriceIsRealtime).toBe(false);
    expect(rateLimiter.run).not.toHaveBeenCalled();
  });

  test("fetches option contracts with default both side and quote-only underlying price", async () => {
    let listener: ((events: Record<string, unknown>[]) => void) | undefined;
    const quoteStreamer = {
      addEventListener: vi.fn((nextListener: (events: Record<string, unknown>[]) => void) => {
        listener = nextListener;
        return undefined as unknown as () => void;
      }),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(),
      subscribe: vi.fn((streamerSymbols: string[]) => {
        listener?.([
          {eventType: "Quote"},
          {eventSymbol: "IGNORED", eventType: "Quote", askPrice: 1},
          {eventSymbol: ".AAPL260619C440", eventType: "Trade", askPrice: 9},
          ...streamerSymbols.flatMap(streamerSymbol => {
            if ("AAPL" === streamerSymbol) {
              return [{
                eventSymbol: streamerSymbol,
                eventType: "Quote",
                askPrice: 190.5,
              }];
            }

            return [
              {
                eventSymbol: streamerSymbol,
                eventType: "Quote",
                askPrice: 2.2,
              },
              {
                eventSymbol: streamerSymbol,
                eventType: "Greeks",
                delta: streamerSymbol.includes("P") ? -0.31 : 0.31,
              },
            ];
          }),
        ]);
      }),
    };

    const result = await getOptionContractsLookup({
      credentials: {
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      dte: 49,
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

    expect(result.requestedSide).toBe("both");
    expect(result.contracts).toHaveLength(6);
    expect(result.underlyingPrice).toBe(190.5);
    expect(quoteStreamer.disconnect).toHaveBeenCalledTimes(1);
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
    const selectedExpiration = parseTastytradeNestedOptionChain(createNestedOptionChainItems())[0]!;
    const chainCache = new BoundedTtlCache<ChainExpiration[]>({
      maxEntries: 10,
      ttlMs: 60_000,
    });
    chainCache.set("AAPL", [selectedExpiration]);
    await expect(getOptionContractsLookup({
      credentials: baseRequest.credentials,
      dte: 500,
      symbol: "AAPL",
    }, {
      chainCache,
      contractCache: new BoundedTtlCache<OptionMarketDataSnapshot>({
        maxEntries: 10,
        ttlMs: 60_000,
      }),
      rateLimiter: immediateRateLimiter,
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
      underlyingPrice: 190.42,
      underlyingPriceIsRealtime: false,
    });

    expect(formattedResult.split("\n")[0]).toBe("`AAPL` @ `190.42` (market closed) | Δ target `0.30` | Expiry `2026-06-19` (`49` DTE)");
    expect(formattedResult).toContain("Expiry `2026-06-19` (`49` DTE)");
    expect(formattedResult).toContain("• Δ ≤ target: Keine passende Option gefunden.");
    expect(formattedResult).toContain("bid/ask `n/a / n/a`");
    expect(formattedResult).toContain("size `n/a x n/a`");
    expect(formattedResult).toContain("IV `n/a`");
  });
});
