import {beforeEach, describe, expect, test, vi} from "vitest";
import {MarketDataSubscriptionType} from "@tastytrade/api";
import {
  createHandledDxLinkQuoteStreamer,
  startTastytradeCryptoStream,
  type TastytradeCryptoStreamOptions,
} from "./market-data-tastytrade.ts";
import {type MarketDataAsset} from "./market-data-types.ts";

type StreamerListener = (events: Record<string, unknown>[]) => void;
type StreamerErrorListener = (error: {message: string; type?: string | undefined}) => void;

function createCryptoAsset(overrides: Partial<MarketDataAsset> = {}): MarketDataAsset {
  return {
    botToken: "token",
    botClientId: "btc-client",
    botName: "Bitcoin/USD",
    id: 1057391,
    suffix: "$",
    unit: "PCT",
    marketHours: "crypto",
    tastytradeStreamerSymbol: "BTC/USD",
    decimals: 2,
    lastUpdate: 0,
    order: 0,
    ...overrides,
  };
}

function createStreamer() {
  let listener: StreamerListener | undefined;
  let errorListener: StreamerErrorListener | undefined;
  return {
    streamer: {
      addErrorListener: vi.fn((newListener: StreamerErrorListener) => {
        errorListener = newListener;
        return vi.fn(() => {
          errorListener = undefined;
        });
      }),
      addEventListener: vi.fn((newListener: StreamerListener) => {
        listener = newListener;
        return vi.fn(() => {
          listener = undefined;
        });
      }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    },
    emit: (events: Record<string, unknown>[]) => {
      listener?.(events);
    },
    emitError: (error: {message: string; type?: string | undefined}) => {
      errorListener?.(error);
    },
  };
}

function createOptions(overrides: Partial<TastytradeCryptoStreamOptions> = {}): TastytradeCryptoStreamOptions {
  const stream = createStreamer();
  return {
    assets: [createCryptoAsset()],
    clientFactory: vi.fn(() => ({
      quoteStreamer: stream.streamer,
    })),
    logger: {
      log: vi.fn(),
    },
    onFallback: vi.fn(),
    onMarketData: vi.fn(),
    onRecovered: vi.fn(),
    random: () => 0.5,
    readSecretFn: vi.fn(secretName => {
      if ("tastytrade_client_secret" === secretName) {
        return "client-secret";
      }

      if ("tastytrade_refresh_token" === secretName) {
        return "refresh-token";
      }

      return "";
    }),
    ...overrides,
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("tastytrade crypto market data stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));
    vi.clearAllMocks();
  });

  test("subscribes crypto streamer symbols and emits trade prices", async () => {
    const stream = createStreamer();
    const options = createOptions({
      clientFactory: vi.fn(() => ({
        quoteStreamer: stream.streamer,
      })),
    });

    startTastytradeCryptoStream(options);
    await flushAsyncWork();

    expect(stream.streamer.connect).toHaveBeenCalledTimes(1);
    expect(stream.streamer.subscribe).toHaveBeenCalledWith(
      ["BTC/USD"],
      [
        MarketDataSubscriptionType.Trade,
        MarketDataSubscriptionType.Quote,
        MarketDataSubscriptionType.Summary,
      ],
    );

    stream.emit([{
      eventSymbol: "BTC/USD",
      eventType: "Trade",
      price: 100,
      priceChange: 1.5,
      percentageChange: 1.52,
    }]);

    expect(options.onRecovered).toHaveBeenCalledTimes(1);
    expect(options.onMarketData).toHaveBeenCalledWith(
      expect.objectContaining({botClientId: "btc-client"}),
      100,
      1.5,
      1.52,
    );
  });

  test("resolves crypto display symbols to tastytrade streamer symbols", async () => {
    const stream = createStreamer();
    const getCryptocurrencies = vi.fn().mockResolvedValue([{
      symbol: "BTC/USD",
      "streamer-symbol": "BTC/USD:CXTALP",
    }]);
    const options = createOptions({
      clientFactory: vi.fn(() => ({
        instrumentsService: {
          getCryptocurrencies,
        },
        quoteStreamer: stream.streamer,
      })),
    });

    startTastytradeCryptoStream(options);
    await flushAsyncWork();

    expect(getCryptocurrencies).toHaveBeenCalledWith(["BTC/USD"]);
    expect(stream.streamer.subscribe).toHaveBeenCalledWith(
      ["BTC/USD:CXTALP"],
      [
        MarketDataSubscriptionType.Trade,
        MarketDataSubscriptionType.Quote,
        MarketDataSubscriptionType.Summary,
      ],
    );

    stream.emit([{
      eventSymbol: "BTC/USD:CXTALP",
      eventType: "Trade",
      price: 100,
    }]);

    expect(options.onMarketData).toHaveBeenCalledWith(
      expect.objectContaining({botClientId: "btc-client"}),
      100,
      0,
      0,
    );
  });

  test("derives crypto move from summary previous close", async () => {
    const stream = createStreamer();
    const options = createOptions({
      clientFactory: vi.fn(() => ({
        quoteStreamer: stream.streamer,
      })),
    });

    startTastytradeCryptoStream(options);
    await flushAsyncWork();

    stream.emit([{
      eventSymbol: "BTC/USD",
      eventType: "Summary",
      dayClosePrice: 105,
      prevDayClosePrice: 100,
    }]);

    expect(options.onMarketData).toHaveBeenLastCalledWith(
      expect.objectContaining({botClientId: "btc-client"}),
      105,
      5,
      5,
    );

    stream.emit([{
      eventSymbol: "BTC/USD",
      eventType: "Quote",
      bidPrice: 105.9,
      askPrice: 106.1,
    }]);

    expect(options.onMarketData).toHaveBeenLastCalledWith(
      expect.objectContaining({botClientId: "btc-client"}),
      106,
      6,
      6,
    );

    stream.emit([{
      change: 0.1,
      eventSymbol: "BTC/USD",
      eventType: "Trade",
      percentageChange: 0.09,
      price: 107,
    }]);

    expect(options.onMarketData).toHaveBeenLastCalledWith(
      expect.objectContaining({botClientId: "btc-client"}),
      107,
      7,
      7.000000000000001,
    );
  });

  test("derives crypto percentage move from trade change", async () => {
    const stream = createStreamer();
    const options = createOptions({
      clientFactory: vi.fn(() => ({
        quoteStreamer: stream.streamer,
      })),
    });

    startTastytradeCryptoStream(options);
    await flushAsyncWork();

    stream.emit([{
      eventSymbol: "BTC/USD",
      eventType: "Trade",
      price: 103,
      change: 3,
    }]);

    expect(options.onMarketData).toHaveBeenLastCalledWith(
      expect.objectContaining({botClientId: "btc-client"}),
      103,
      3,
      3,
    );
  });

  test("resubscribes once when no initial quote arrives", async () => {
    const stream = createStreamer();
    const options = createOptions({
      clientFactory: vi.fn(() => ({
        quoteStreamer: stream.streamer,
      })),
    });

    startTastytradeCryptoStream(options);
    await flushAsyncWork();

    expect(stream.streamer.subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stream.streamer.subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(stream.streamer.subscribe).toHaveBeenCalledTimes(2);
  });

  test("uses quote mid price when bid and ask are available", async () => {
    const stream = createStreamer();
    const options = createOptions({
      clientFactory: vi.fn(() => ({
        quoteStreamer: stream.streamer,
      })),
    });

    startTastytradeCryptoStream(options);
    await flushAsyncWork();

    stream.emit([{
      "event-symbol": "BTC/USD",
      "event-type": "Quote",
      "bid-price": 99,
      "ask-price": 101,
    }]);

    expect(options.onMarketData).toHaveBeenCalledWith(
      expect.objectContaining({botClientId: "btc-client"}),
      100,
      0,
      0,
    );
  });

  test("falls back and retries with capped exponential backoff when connect fails", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("still down"));
    const stream = createStreamer();
    stream.streamer.connect = connect;
    const options = createOptions({
      clientFactory: vi.fn(() => ({
        quoteStreamer: stream.streamer,
      })),
    });

    startTastytradeCryptoStream(options);
    await flushAsyncWork();

    expect(options.onFallback).toHaveBeenCalledWith("Error: down");
    expect(connect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(connect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(options.onFallback).toHaveBeenLastCalledWith("Error: still down");

    await vi.advanceTimersByTimeAsync(59_999);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();
    expect(connect).toHaveBeenCalledTimes(3);
  });

  test("handles dxLink streamer errors through fallback and retry", async () => {
    const stream = createStreamer();
    const options = createOptions({
      clientFactory: vi.fn(() => ({
        quoteStreamer: stream.streamer,
      })),
    });

    startTastytradeCryptoStream(options);
    await flushAsyncWork();

    stream.emitError({type: "UNKNOWN", message: "Unable to connect"});

    expect(options.onFallback).toHaveBeenCalledWith("dxLink UNKNOWN: Unable to connect");
    expect(stream.streamer.disconnect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsyncWork();

    expect(stream.streamer.connect).toHaveBeenCalledTimes(2);

    stream.emitError({message: "   "});

    expect(options.onFallback).toHaveBeenLastCalledWith("dxLink: unknown error");
  });

  test("creates a handled dxLink quote streamer with subscriptions and error listeners", async () => {
    const dxLinkErrorListener = vi.fn();
    const feedListener = vi.fn();
    const dxLinkClient = {
      addErrorListener: vi.fn((listener: StreamerErrorListener) => {
        dxLinkErrorListener.mockImplementation(listener);
      }),
      close: vi.fn(),
      connect: vi.fn(),
      removeErrorListener: vi.fn(),
      setAuthToken: vi.fn(),
    };
    const dxLinkFeed = {
      addEventListener: vi.fn(),
      addSubscriptions: vi.fn(),
      close: vi.fn(),
      configure: vi.fn(),
      removeEventListener: vi.fn(),
      removeSubscriptions: vi.fn(),
    };
    const quoteStreamer = createHandledDxLinkQuoteStreamer({
      getApiQuoteToken: vi.fn().mockResolvedValue({
        "dxlink-url": "wss://quote.example",
        token: "quote-token",
      }),
    }, {
      createClient: () => dxLinkClient,
      createFeed: () => dxLinkFeed,
    });
    const quoteErrorListener = vi.fn();
    const removeErrorListener = quoteStreamer.addErrorListener?.(quoteErrorListener);

    quoteStreamer.addEventListener(feedListener);
    await quoteStreamer.connect();
    quoteStreamer.subscribe(["BTC/USD:CXTALP"], [MarketDataSubscriptionType.Trade]);
    quoteStreamer.unsubscribe(["BTC/USD:CXTALP"]);
    dxLinkErrorListener({type: "UNKNOWN", message: "Unable to connect"});
    removeErrorListener?.();
    quoteStreamer.disconnect();

    expect(dxLinkClient.connect).toHaveBeenCalledWith("wss://quote.example");
    expect(dxLinkClient.setAuthToken).toHaveBeenCalledWith("quote-token");
    expect(dxLinkFeed.configure).toHaveBeenCalledWith({
      acceptAggregationPeriod: 10,
      acceptDataFormat: "COMPACT",
      acceptEventFields: {
        Quote: ["eventSymbol", "bidPrice", "askPrice"],
        Summary: ["eventSymbol", "dayClosePrice", "prevDayClosePrice"],
        Trade: ["eventSymbol", "price", "change"],
      },
    });
    expect(dxLinkFeed.addEventListener).toHaveBeenCalledWith(feedListener);
    expect(dxLinkFeed.addSubscriptions).toHaveBeenCalledWith({
      symbol: "BTC/USD:CXTALP",
      type: MarketDataSubscriptionType.Trade,
    });
    expect(dxLinkFeed.removeSubscriptions).toHaveBeenCalledWith({
      symbol: "BTC/USD:CXTALP",
      type: MarketDataSubscriptionType.Trade,
    });
    expect(quoteErrorListener).toHaveBeenCalledWith({
      message: "Unable to connect",
      type: "UNKNOWN",
    });
    expect(dxLinkClient.removeErrorListener).toHaveBeenCalledTimes(1);
    expect(dxLinkFeed.close).toHaveBeenCalledTimes(1);
    expect(dxLinkClient.close).toHaveBeenCalledTimes(1);
  });

  test("falls back when a connected stream stays stale and recovers on the next valid event", async () => {
    const stream = createStreamer();
    const options = createOptions({
      assets: [createCryptoAsset({botClientId: "stale-btc-client"})],
      clientFactory: vi.fn(() => ({
        quoteStreamer: stream.streamer,
      })),
    });

    startTastytradeCryptoStream(options);
    await flushAsyncWork();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushAsyncWork();

    expect(options.onFallback).toHaveBeenCalledWith("no valid crypto quote for 300s");

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsyncWork();
    stream.emit([{
      eventSymbol: "BTC/USD",
      eventType: "Trade",
      price: 101,
    }]);

    expect(options.onRecovered).toHaveBeenCalledTimes(1);
    expect(options.onMarketData).toHaveBeenCalledWith(
      expect.objectContaining({botClientId: "stale-btc-client"}),
      101,
      0,
      0,
    );
  });

  test("falls back only the stale crypto symbol while other tastytrade symbols remain live", async () => {
    const stream = createStreamer();
    const btcAsset = createCryptoAsset({
      botClientId: "btc-client",
      tastytradeStreamerSymbol: "BTC/USD",
    });
    const ethAsset = createCryptoAsset({
      botClientId: "eth-client",
      tastytradeStreamerSymbol: "ETH/USD",
    });
    const options = createOptions({
      assets: [btcAsset, ethAsset],
      clientFactory: vi.fn(() => ({
        quoteStreamer: stream.streamer,
      })),
    });

    startTastytradeCryptoStream(options);
    await flushAsyncWork();

    stream.emit([{
      eventSymbol: "BTC/USD",
      eventType: "Trade",
      price: 100,
    }]);
    await vi.advanceTimersByTimeAsync(299_999);
    stream.emit([{
      eventSymbol: "BTC/USD",
      eventType: "Trade",
      price: 101,
    }]);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();

    expect(options.onFallback).toHaveBeenCalledWith(
      "no valid ETH/USD crypto quote for 300s",
      ethAsset,
    );
    expect(options.onFallback).not.toHaveBeenCalledWith(
      expect.stringContaining("BTC/USD"),
      btcAsset,
    );
  });

  test("missing credentials fall back without overlapping retry attempts", async () => {
    const options = createOptions({
      readSecretFn: vi.fn(() => ""),
    });

    startTastytradeCryptoStream(options);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsyncWork();

    expect(options.clientFactory).not.toHaveBeenCalled();
    expect(options.onFallback).toHaveBeenCalledTimes(2);
  });
});
