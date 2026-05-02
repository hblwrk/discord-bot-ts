import TastytradeClient, {MarketDataSubscriptionType} from "@tastytrade/api";
import WS from "ws";
import {type MarketDataAsset} from "./market-data-types.ts";
import {readSecret} from "./secrets.ts";

type Logger = {
  log: (level: string, message: unknown) => void;
};

type TimerHandle = ReturnType<typeof setTimeout>;
type TastytradeEvent = Record<string, unknown>;
type TastytradeEventListener = (events: TastytradeEvent[]) => void;
type TastytradeQuoteStreamer = {
  addEventListener: (listener: TastytradeEventListener) => () => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  subscribe: (streamerSymbols: string[], types?: MarketDataSubscriptionType[] | null) => void;
};
type TastytradeMarketDataClient = {
  quoteStreamer: TastytradeQuoteStreamer;
};
type TastytradeMarketDataClientFactory = (credentials: {
  clientSecret: string;
  refreshToken: string;
}) => TastytradeMarketDataClient;

type CryptoStreamAsset = {
  asset: MarketDataAsset;
  streamerSymbol: string;
};

export type TastytradeCryptoStreamOptions = {
  assets: MarketDataAsset[];
  clearTimeoutFn?: typeof clearTimeout;
  clientFactory?: TastytradeMarketDataClientFactory;
  logger: Logger;
  now?: () => number;
  onFallback: (reason: string, asset?: MarketDataAsset) => void;
  onMarketData: (asset: MarketDataAsset, lastNumeric: number, priceChange: number, percentageChange: number) => void;
  onRecovered: () => void;
  random?: () => number;
  readSecretFn?: typeof readSecret;
  setTimeoutFn?: typeof setTimeout;
};

export type TastytradeCryptoStreamHandle = {
  stop: () => void;
};

const retryBaseDelayMs = 30_000;
const retryMaxDelayMs = 30 * 60_000;
const retryJitterRatio = 0.2;
const staleTimeoutMs = 300_000;
const staleCheckIntervalMs = 30_000;
const quoteSubscriptionTypes = [
  MarketDataSubscriptionType.Trade,
  MarketDataSubscriptionType.Quote,
  MarketDataSubscriptionType.Summary,
];

const webSocketGlobal = globalThis as typeof globalThis & {
  WebSocket?: unknown;
};

export function startTastytradeCryptoStream({
  assets,
  clearTimeoutFn = clearTimeout,
  clientFactory = createTastytradeMarketDataClient,
  logger,
  now = () => Date.now(),
  onFallback,
  onMarketData,
  onRecovered,
  random = Math.random,
  readSecretFn = readSecret,
  setTimeoutFn = setTimeout,
}: TastytradeCryptoStreamOptions): TastytradeCryptoStreamHandle {
  const streamAssets = getCryptoStreamAssets(assets);
  if (0 === streamAssets.length) {
    return {
      stop: () => {},
    };
  }

  const assetByStreamerSymbol = new Map<string, MarketDataAsset>();
  for (const streamAsset of streamAssets) {
    assetByStreamerSymbol.set(streamAsset.streamerSymbol, streamAsset.asset);
  }

  let client: TastytradeMarketDataClient | undefined;
  let connectedAtMs = 0;
  let lastValidEventAtMs = 0;
  const lastValidEventAtBySymbol = new Map<string, number>();
  const fallbackSymbols = new Set<string>();
  let live = false;
  let reconnecting = false;
  let retryDelayMs = retryBaseDelayMs;
  let retryTimer: TimerHandle | undefined;
  let staleTimer: TimerHandle | undefined;
  let removeListener: (() => void) | undefined;
  let stopped = false;
  const previousPrices = new Map<string, number>();

  const disconnect = () => {
    if (undefined !== removeListener) {
      removeListener();
      removeListener = undefined;
    }

    if (undefined !== client) {
      client.quoteStreamer.disconnect();
      client = undefined;
    }

    connectedAtMs = 0;
    live = false;
  };

  const clearTimer = (timer: TimerHandle | undefined) => {
    if (undefined !== timer) {
      clearTimeoutFn(timer);
    }
  };

  const scheduleRetry = (reason: string) => {
    clearTimer(retryTimer);
    if (true === stopped) {
      return;
    }

    const jitterMultiplier = 1 - retryJitterRatio + (random() * retryJitterRatio * 2);
    const retryInMs = Math.round(retryDelayMs * jitterMultiplier);
    logger.log(
      "warn",
      `Tastytrade crypto stream unavailable: ${reason}. Retrying in ${Math.round(retryInMs / 1000)}s.`,
    );
    retryTimer = setTimeoutFn(() => {
      void connect();
    }, retryInMs);
    retryTimer.unref();
    retryDelayMs = Math.min(retryDelayMs * 2, retryMaxDelayMs);
  };

  const fail = (reason: string) => {
    clearTimer(staleTimer);
    disconnect();
    onFallback(reason);
    scheduleRetry(reason);
  };

  const handleEvents: TastytradeEventListener = events => {
    for (const event of events) {
      const streamEvent = parseTastytradeCryptoEvent(event, assetByStreamerSymbol);
      if (null === streamEvent) {
        continue;
      }

      const previousPrice = previousPrices.get(getAssetKey(streamEvent.asset)) ?? null;
      const priceChange = streamEvent.priceChange ?? (
        null === previousPrice ? 0 : streamEvent.lastNumeric - previousPrice
      );
      const percentageChange = streamEvent.percentageChange ?? (
        null === previousPrice || 0 === previousPrice
          ? 0
          : ((streamEvent.lastNumeric - previousPrice) / previousPrice) * 100
      );

      previousPrices.set(getAssetKey(streamEvent.asset), streamEvent.lastNumeric);
      const eventTimeMs = now();
      lastValidEventAtMs = eventTimeMs;
      lastValidEventAtBySymbol.set(streamEvent.streamerSymbol, eventTimeMs);
      fallbackSymbols.delete(streamEvent.streamerSymbol);
      if (false === live) {
        live = true;
        retryDelayMs = retryBaseDelayMs;
        onRecovered();
      }

      onMarketData(streamEvent.asset, streamEvent.lastNumeric, priceChange, percentageChange);
    }
  };

  const scheduleStaleCheck = () => {
    clearTimer(staleTimer);
    if (true === stopped) {
      return;
    }

    staleTimer = setTimeoutFn(() => {
      const currentTimeMs = now();
      const streamReferenceTimeMs = lastValidEventAtMs || connectedAtMs;
      if (0 !== streamReferenceTimeMs && currentTimeMs - streamReferenceTimeMs >= staleTimeoutMs) {
        fail(`no valid crypto quote for ${Math.floor((currentTimeMs - streamReferenceTimeMs) / 1000)}s`);
        return;
      }

      for (const streamAsset of streamAssets) {
        const symbolReferenceTimeMs = lastValidEventAtBySymbol.get(streamAsset.streamerSymbol) ?? connectedAtMs;
        if (0 === symbolReferenceTimeMs ||
            currentTimeMs - symbolReferenceTimeMs < staleTimeoutMs ||
            true === fallbackSymbols.has(streamAsset.streamerSymbol)) {
          continue;
        }

        fallbackSymbols.add(streamAsset.streamerSymbol);
        onFallback(
          `no valid ${streamAsset.streamerSymbol} crypto quote for ${Math.floor((currentTimeMs - symbolReferenceTimeMs) / 1000)}s`,
          streamAsset.asset,
        );
      }

      scheduleStaleCheck();
    }, staleCheckIntervalMs);
    staleTimer.unref();
  };

  const connect = async () => {
    if (true === stopped || true === reconnecting) {
      return;
    }

    reconnecting = true;
    clearTimer(retryTimer);

    try {
      ensureWebSocketGlobal();
      const clientSecret = readSecretFn("tastytrade_client_secret").trim();
      const refreshToken = readSecretFn("tastytrade_refresh_token").trim();
      if ("" === clientSecret || "" === refreshToken) {
        throw new Error("tastytrade credentials are missing");
      }

      disconnect();
      client = clientFactory({clientSecret, refreshToken});
      removeListener = client.quoteStreamer.addEventListener(handleEvents);
      await client.quoteStreamer.connect();
      connectedAtMs = now();
      lastValidEventAtMs = 0;
      lastValidEventAtBySymbol.clear();
      fallbackSymbols.clear();
      client.quoteStreamer.subscribe(
        streamAssets.map(streamAsset => streamAsset.streamerSymbol),
        quoteSubscriptionTypes,
      );
      logger.log(
        "info",
        `Tastytrade crypto stream subscribed to ${streamAssets.length} symbols.`,
      );
      scheduleStaleCheck();
    } catch (error) {
      fail(String(error));
    } finally {
      reconnecting = false;
    }
  };

  void connect();

  return {
    stop: () => {
      stopped = true;
      clearTimer(retryTimer);
      clearTimer(staleTimer);
      disconnect();
    },
  };
}

function createTastytradeMarketDataClient(credentials: {
  clientSecret: string;
  refreshToken: string;
}): TastytradeMarketDataClient {
  return new TastytradeClient({
    baseUrl: "https://api.tastyworks.com",
    accountStreamerUrl: "wss://streamer.tastyworks.com",
    clientSecret: credentials.clientSecret,
    refreshToken: credentials.refreshToken,
    oauthScopes: ["read"],
  });
}

function ensureWebSocketGlobal() {
  if (undefined === webSocketGlobal.WebSocket) {
    webSocketGlobal.WebSocket = WS as unknown as typeof webSocketGlobal.WebSocket;
  }
}

function getCryptoStreamAssets(assets: MarketDataAsset[]): CryptoStreamAsset[] {
  return assets.flatMap(asset => {
    if ("crypto" !== asset.marketHours) {
      return [];
    }

    const streamerSymbol = asset.tastytradeStreamerSymbol?.trim();
    if (!streamerSymbol) {
      return [];
    }

    return [{
      asset,
      streamerSymbol,
    }];
  });
}

function getAssetKey(asset: MarketDataAsset): string {
  return asset.botClientId || asset.name || String(asset.id);
}

function parseTastytradeCryptoEvent(
  event: TastytradeEvent,
  assetByStreamerSymbol: Map<string, MarketDataAsset>,
): {
  asset: MarketDataAsset;
  lastNumeric: number;
  percentageChange: number | null;
  priceChange: number | null;
  streamerSymbol: string;
} | null {
  const eventSymbol = getStringField(event, ["eventSymbol", "event-symbol", "symbol"]);
  if (null === eventSymbol) {
    return null;
  }

  const asset = assetByStreamerSymbol.get(eventSymbol);
  if (!asset) {
    return null;
  }

  const eventType = getStringField(event, ["eventType", "event-type", "type"]);
  if (null !== eventType && false === quoteSubscriptionTypes.includes(eventType as MarketDataSubscriptionType)) {
    return null;
  }

  const lastNumeric = getEventPrice(event);
  if (null === lastNumeric) {
    return null;
  }

  return {
    asset,
    lastNumeric,
    percentageChange: getNumericField(event, [
      "percentageChange",
      "percentage-change",
      "percentChange",
      "percent-change",
      "changePercent",
      "change-percent",
    ]),
    priceChange: getNumericField(event, [
      "priceChange",
      "price-change",
      "netChange",
      "net-change",
      "dayChange",
      "day-change",
      "change",
    ]),
    streamerSymbol: eventSymbol,
  };
}

function getEventPrice(event: TastytradeEvent): number | null {
  const bidPrice = getNumericField(event, ["bidPrice", "bid-price"]);
  const askPrice = getNumericField(event, ["askPrice", "ask-price"]);
  if (null !== bidPrice && null !== askPrice) {
    return (bidPrice + askPrice) / 2;
  }

  return getNumericField(event, [
    "price",
    "lastPrice",
    "last-price",
    "last",
    "dayClosePrice",
    "day-close-price",
  ]);
}

function getStringField(event: TastytradeEvent, fieldNames: string[]): string | null {
  for (const fieldName of fieldNames) {
    const value = event[fieldName];
    if ("string" === typeof value && "" !== value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getNumericField(event: TastytradeEvent, fieldNames: string[]): number | null {
  for (const fieldName of fieldNames) {
    const parsedValue = parseNumericValue(event[fieldName]);
    if (null !== parsedValue) {
      return parsedValue;
    }
  }

  return null;
}

function parseNumericValue(value: unknown): number | null {
  if ("number" === typeof value && Number.isFinite(value)) {
    return value;
  }

  if ("string" === typeof value) {
    const parsedValue = Number(value.replaceAll(",", "").replaceAll("%", "").trim());
    if (Number.isFinite(parsedValue)) {
      return parsedValue;
    }
  }

  return null;
}
