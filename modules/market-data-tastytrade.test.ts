import {beforeEach, describe, expect, test, vi} from "vitest";
import {MarketDataSubscriptionType} from "@tastytrade/api";
import {
  startTastytradeCryptoStream,
  type TastytradeCryptoStreamOptions,
} from "./market-data-tastytrade.ts";
import {type MarketDataAsset} from "./market-data-types.ts";

type StreamerListener = (events: Record<string, unknown>[]) => void;

function createCryptoAsset(overrides: Partial<MarketDataAsset> = {}): MarketDataAsset {
  return {
    botToken: "token",
    botClientId: "btc-client",
    botName: "Bitcoin/USD",
    id: 1057391,
    suffix: "$",
    unit: "PCT",
    marketHours: "crypto",
    tastytradeStreamerSymbol: "BTC/USD:CXTALP",
    decimals: 2,
    lastUpdate: 0,
    order: 0,
    ...overrides,
  };
}

function createStreamer() {
  let listener: StreamerListener | undefined;
  return {
    streamer: {
      addEventListener: vi.fn((newListener: StreamerListener) => {
        listener = newListener;
        return vi.fn(() => {
          listener = undefined;
        });
      }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
    },
    emit: (events: Record<string, unknown>[]) => {
      listener?.(events);
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
      "event-symbol": "BTC/USD:CXTALP",
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
      eventSymbol: "BTC/USD:CXTALP",
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
      tastytradeStreamerSymbol: "BTC/USD:CXTALP",
    });
    const ethAsset = createCryptoAsset({
      botClientId: "eth-client",
      tastytradeStreamerSymbol: "ETH/USD:CXTALP",
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
      eventSymbol: "BTC/USD:CXTALP",
      eventType: "Trade",
      price: 100,
    }]);
    await vi.advanceTimersByTimeAsync(299_999);
    stream.emit([{
      eventSymbol: "BTC/USD:CXTALP",
      eventType: "Trade",
      price: 101,
    }]);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();

    expect(options.onFallback).toHaveBeenCalledWith(
      "no valid ETH/USD:CXTALP crypto quote for 300s",
      ethAsset,
    );
    expect(options.onFallback).not.toHaveBeenCalledWith(
      expect.stringContaining("BTC/USD:CXTALP"),
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
