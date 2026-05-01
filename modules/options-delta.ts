import TastytradeClient, {MarketDataSubscriptionType} from "@tastytrade/api";
import WS from "ws";
import {BoundedTtlCache} from "./bounded-ttl-cache.ts";
import {optionDataRateLimiter, type BrokerApiRateLimiter} from "./broker-api-rate-limit.ts";
export {formatOptionDeltaLookupResult, getClosestDeltaContract, getOptionContractMidPrice} from "./options-format.ts";

export type OptionDeltaSide = "call" | "put";
export type OptionDeltaRequestedSide = OptionDeltaSide | "both";

export type OptionDeltaCredentials = {
  clientSecret: string;
  refreshToken: string;
};

export type OptionDeltaLookupRequest = {
  credentials: OptionDeltaCredentials;
  delta: number;
  dte: number;
  side: OptionDeltaRequestedSide;
  symbol: string;
};

export type OptionDeltaContract = {
  ask: number | null;
  askSize: number | null;
  bid: number | null;
  bidSize: number | null;
  delta: number;
  expirationDate: string;
  gamma: number | null;
  iv: number | null;
  optionType: OptionDeltaSide;
  streamerSymbol: string;
  strike: number;
  symbol: string;
  theta: number | null;
  vega: number | null;
};

export type OptionDeltaBracket = {
  above: OptionDeltaContract | null;
  below: OptionDeltaContract | null;
};

export type OptionDeltaSideResult = {
  brackets: OptionDeltaBracket;
  contractsConsidered: number;
  side: OptionDeltaSide;
};

export type OptionDeltaLookupResult = {
  actualDte: number;
  expiration: string;
  requestedDte: number;
  requestedSide: OptionDeltaRequestedSide;
  rolled: boolean;
  sideResults: OptionDeltaSideResult[];
  symbol: string;
  targetDelta: number;
};

type TastytradeEvent = Record<string, unknown>;
type TastytradeEventListener = (events: TastytradeEvent[]) => void;
type TastytradeQuoteStreamer = {
  addEventListener: (listener: TastytradeEventListener) => () => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  subscribe: (streamerSymbols: string[], types?: MarketDataSubscriptionType[] | null) => void;
};
type TastytradeClientLike = {
  instrumentsService: {
    getNestedOptionChain: (symbol: string) => Promise<unknown>;
  };
  quoteStreamer: TastytradeQuoteStreamer;
};
type TastytradeClientFactory = (credentials: OptionDeltaCredentials) => TastytradeClientLike;
type OptionDeltaCache<Value> = Pick<BoundedTtlCache<Value>, "get" | "set">;
export type OptionDeltaLookupDependencies = {
  chainCache?: OptionDeltaCache<ChainExpiration[]>;
  clientFactory?: TastytradeClientFactory;
  contractCache?: OptionDeltaCache<OptionDeltaContract[]>;
  marketDataTimeoutMs?: number;
  rateLimiter?: Pick<BrokerApiRateLimiter, "run">;
};
type ChainStrike = {
  callStreamerSymbol: string | null;
  callSymbol: string | null;
  putStreamerSymbol: string | null;
  putSymbol: string | null;
  strike: number;
};
export type ChainExpiration = {
  daysToExpiration: number;
  expirationDate: string;
  strikes: ChainStrike[];
};
type SelectedExpiration = {
  expiration: ChainExpiration;
  rolled: boolean;
};
type StreamedMarketData = {
  ask: number | null;
  askSize: number | null;
  bid: number | null;
  bidSize: number | null;
  delta: number | null;
  gamma: number | null;
  iv: number | null;
  theta: number | null;
  vega: number | null;
};

const defaultMarketDataTimeoutMs = 5500;
const optionChainCacheTtlMs = 5 * 60 * 1000;
const optionContractCacheTtlMs = 20 * 1000;
const optionChainCache = new BoundedTtlCache<ChainExpiration[]>({
  maxEntries: 32,
  ttlMs: optionChainCacheTtlMs,
});
const optionContractCache = new BoundedTtlCache<OptionDeltaContract[]>({
  maxEntries: 24,
  ttlMs: optionContractCacheTtlMs,
});
const webSocketGlobal = globalThis as {
  WebSocket?: unknown;
};

export class OptionDeltaInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OptionDeltaInputError";
  }
}

export class OptionDeltaConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OptionDeltaConfigurationError";
  }
}

export class OptionDeltaDataError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OptionDeltaDataError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && false === Array.isArray(value);
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (null === value || undefined === value) {
    return [];
  }

  return [value];
}

function toFiniteNumber(value: unknown): number | null {
  if ("number" === typeof value && Number.isFinite(value)) {
    return value;
  }

  if ("string" === typeof value && "" !== value.trim()) {
    const parsedValue = Number(value);
    if (Number.isFinite(parsedValue)) {
      return parsedValue;
    }
  }

  return null;
}

function getNumber(record: Record<string, unknown>, key: string): number | null {
  return toFiniteNumber(record[key]);
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return "string" === typeof value && "" !== value.trim() ? value : null;
}

function getEventSymbol(event: TastytradeEvent): string | null {
  return getString(event, "eventSymbol") ?? getString(event, "event-symbol");
}

function getEventType(event: TastytradeEvent): string | null {
  return getString(event, "eventType") ?? getString(event, "event-type");
}

function normalizeCredentials(credentials: OptionDeltaCredentials): OptionDeltaCredentials {
  const clientSecret = credentials.clientSecret.trim();
  const refreshToken = credentials.refreshToken.trim();
  if ("" === clientSecret || "" === refreshToken) {
    throw new OptionDeltaConfigurationError("Option data credentials are missing.");
  }

  return {
    clientSecret,
    refreshToken,
  };
}

export function normalizeOptionSymbol(symbol: string): string {
  const normalizedSymbol = symbol.trim().toUpperCase().replaceAll(".", "/");
  if (false === /^[A-Z0-9/]{1,16}$/.test(normalizedSymbol)) {
    throw new OptionDeltaInputError("Symbol must use letters, numbers, slash, or dot notation.");
  }

  return normalizedSymbol;
}

export function normalizeTargetDelta(delta: number): number {
  if (false === Number.isFinite(delta) || delta <= 0 || delta >= 1) {
    throw new OptionDeltaInputError("Delta must be greater than 0 and lower than 1.");
  }

  return delta;
}

function normalizeDte(dte: number): number {
  if (false === Number.isInteger(dte) || dte < 0 || dte > 3650) {
    throw new OptionDeltaInputError("DTE must be an integer from 0 to 3650.");
  }

  return dte;
}

function ensureWebSocketGlobal() {
  if (undefined === webSocketGlobal.WebSocket) {
    webSocketGlobal.WebSocket = WS;
  }
}

function createTastytradeClient(credentials: OptionDeltaCredentials): TastytradeClientLike {
  ensureWebSocketGlobal();
  return new TastytradeClient({
    baseUrl: "https://api.tastyworks.com",
    accountStreamerUrl: "wss://streamer.tastyworks.com",
    clientSecret: credentials.clientSecret,
    refreshToken: credentials.refreshToken,
    oauthScopes: ["read"],
  });
}

function parseChainStrike(strikeData: unknown): ChainStrike | null {
  if (false === isRecord(strikeData)) {
    return null;
  }

  const strike = getNumber(strikeData, "strike-price");
  if (null === strike) {
    return null;
  }

  return {
    callStreamerSymbol: getString(strikeData, "call-streamer-symbol"),
    callSymbol: getString(strikeData, "call"),
    putStreamerSymbol: getString(strikeData, "put-streamer-symbol"),
    putSymbol: getString(strikeData, "put"),
    strike,
  };
}

function parseChainExpiration(expirationData: unknown): ChainExpiration | null {
  if (false === isRecord(expirationData)) {
    return null;
  }

  const expirationDate = getString(expirationData, "expiration-date");
  const daysToExpiration = getNumber(expirationData, "days-to-expiration");
  if (null === expirationDate || null === daysToExpiration) {
    return null;
  }

  const strikes: ChainStrike[] = [];
  for (const strikeData of toArray(expirationData["strikes"])) {
    const strike = parseChainStrike(strikeData);
    if (null !== strike) {
      strikes.push(strike);
    }
  }

  return {
    daysToExpiration,
    expirationDate,
    strikes,
  };
}

export function parseTastytradeNestedOptionChain(chainData: unknown): ChainExpiration[] {
  let chainItems: unknown[] = [];
  if (Array.isArray(chainData)) {
    chainItems = chainData;
  } else if (isRecord(chainData) && isRecord(chainData["data"])) {
    chainItems = toArray(chainData["data"]["items"]);
  } else if (isRecord(chainData)) {
    chainItems = toArray(chainData["items"]);
  }

  const expirations: ChainExpiration[] = [];
  for (const itemData of chainItems) {
    if (false === isRecord(itemData)) {
      continue;
    }

    for (const expirationData of toArray(itemData["expirations"])) {
      const expiration = parseChainExpiration(expirationData);
      if (null !== expiration) {
        expirations.push(expiration);
      }
    }
  }

  return expirations.sort((first, second) => first.daysToExpiration - second.daysToExpiration);
}

export function selectExpirationForDte(expirations: ChainExpiration[], dte: number): SelectedExpiration | null {
  const normalizedDte = normalizeDte(dte);
  for (const expiration of [...expirations].sort((first, second) => first.daysToExpiration - second.daysToExpiration)) {
    if (expiration.daysToExpiration >= normalizedDte) {
      return {
        expiration,
        rolled: expiration.daysToExpiration !== normalizedDte,
      };
    }
  }

  return null;
}

function getRequestedSides(side: OptionDeltaRequestedSide): OptionDeltaSide[] {
  if ("both" === side) {
    return ["call", "put"];
  }

  return [side];
}

function getStrikeStreamerSymbol(strike: ChainStrike, side: OptionDeltaSide): string | null {
  return "call" === side ? strike.callStreamerSymbol : strike.putStreamerSymbol;
}

function getStrikeOptionSymbol(strike: ChainStrike, side: OptionDeltaSide): string | null {
  return "call" === side ? strike.callSymbol : strike.putSymbol;
}

function initializeStreamedMarketData(): StreamedMarketData {
  return {
    ask: null,
    askSize: null,
    bid: null,
    bidSize: null,
    delta: null,
    gamma: null,
    iv: null,
    theta: null,
    vega: null,
  };
}

function mergeQuoteEvent(marketData: StreamedMarketData, event: TastytradeEvent): StreamedMarketData {
  return {
    ...marketData,
    ask: getNumber(event, "askPrice") ?? getNumber(event, "ask-price") ?? marketData.ask,
    askSize: getNumber(event, "askSize") ?? getNumber(event, "ask-size") ?? marketData.askSize,
    bid: getNumber(event, "bidPrice") ?? getNumber(event, "bid-price") ?? marketData.bid,
    bidSize: getNumber(event, "bidSize") ?? getNumber(event, "bid-size") ?? marketData.bidSize,
  };
}

function mergeGreeksEvent(marketData: StreamedMarketData, event: TastytradeEvent): StreamedMarketData {
  return {
    ...marketData,
    delta: getNumber(event, "delta") ?? marketData.delta,
    gamma: getNumber(event, "gamma") ?? marketData.gamma,
    iv: getNumber(event, "volatility") ?? marketData.iv,
    theta: getNumber(event, "theta") ?? marketData.theta,
    vega: getNumber(event, "vega") ?? marketData.vega,
  };
}

function hasGreeks(marketData: StreamedMarketData | undefined): boolean {
  return undefined !== marketData && null !== marketData.delta;
}

function hasQuote(marketData: StreamedMarketData | undefined): boolean {
  return undefined !== marketData && (null !== marketData.bid || null !== marketData.ask);
}

function hasRequiredMarketData(
  streamedData: Map<string, StreamedMarketData>,
  greeksSymbols: string[],
  quoteSymbols: string[],
): boolean {
  return greeksSymbols.every(symbol => hasGreeks(streamedData.get(symbol)))
    && quoteSymbols.every(symbol => hasQuote(streamedData.get(symbol)));
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, delayMs);
  });
}

async function collectMarketData(
  quoteStreamer: TastytradeQuoteStreamer,
  streamerSymbols: string[],
  timeoutMs: number,
): Promise<Map<string, StreamedMarketData>> {
  const streamedData = new Map<string, StreamedMarketData>();
  const symbolSet = new Set(streamerSymbols);
  const quoteSymbols: string[] = [];
  const greeksSymbols: string[] = [];
  let removeListener: (() => void) | undefined;

  const listener: TastytradeEventListener = events => {
    for (const event of events) {
      const eventSymbol = getEventSymbol(event);
      if (null === eventSymbol || false === symbolSet.has(eventSymbol)) {
        continue;
      }

      const eventType = getEventType(event);
      const existingMarketData = streamedData.get(eventSymbol) ?? initializeStreamedMarketData();
      if ("Quote" === eventType) {
        streamedData.set(eventSymbol, mergeQuoteEvent(existingMarketData, event));
      } else if ("Greeks" === eventType) {
        streamedData.set(eventSymbol, mergeGreeksEvent(existingMarketData, event));
      }
    }
  };

  try {
    removeListener = quoteStreamer.addEventListener(listener);
    await quoteStreamer.connect();
    quoteStreamer.subscribe(streamerSymbols, [
      MarketDataSubscriptionType.Greeks,
      MarketDataSubscriptionType.Quote,
    ]);

    quoteSymbols.push(...streamerSymbols);
    greeksSymbols.push(...streamerSymbols);
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (true === hasRequiredMarketData(streamedData, greeksSymbols, quoteSymbols)) {
        break;
      }

      await wait(100);
    }

    return streamedData;
  } finally {
    if (undefined !== removeListener) {
      removeListener();
    }

    quoteStreamer.disconnect();
  }
}

function buildContracts(
  expiration: ChainExpiration,
  requestedSides: OptionDeltaSide[],
  streamedData: Map<string, StreamedMarketData>,
): OptionDeltaContract[] {
  const contracts: OptionDeltaContract[] = [];

  for (const strike of expiration.strikes) {
    for (const side of requestedSides) {
      const streamerSymbol = getStrikeStreamerSymbol(strike, side);
      const optionSymbol = getStrikeOptionSymbol(strike, side);
      if (null === streamerSymbol || null === optionSymbol) {
        continue;
      }

      const marketData = streamedData.get(streamerSymbol);
      if (undefined === marketData || null === marketData.delta) {
        continue;
      }

      contracts.push({
        ask: marketData.ask,
        askSize: marketData.askSize,
        bid: marketData.bid,
        bidSize: marketData.bidSize,
        delta: marketData.delta,
        expirationDate: expiration.expirationDate,
        gamma: marketData.gamma,
        iv: marketData.iv,
        optionType: side,
        streamerSymbol,
        strike: strike.strike,
        symbol: optionSymbol,
        theta: marketData.theta,
        vega: marketData.vega,
      });
    }
  }

  return contracts;
}

export function findDeltaBrackets(contracts: OptionDeltaContract[], targetDelta: number): OptionDeltaBracket {
  const eligibleContracts = contracts
    .filter(contract => {
      const absoluteDelta = Math.abs(contract.delta);
      return Number.isFinite(absoluteDelta) && absoluteDelta > 0 && absoluteDelta < 1;
    })
    .sort((first, second) => Math.abs(first.delta) - Math.abs(second.delta));

  let below: OptionDeltaContract | null = null;
  let above: OptionDeltaContract | null = null;

  for (const contract of eligibleContracts) {
    const absoluteDelta = Math.abs(contract.delta);
    if (absoluteDelta <= targetDelta) {
      below = contract;
      continue;
    }

    above = contract;
    break;
  }

  return {
    above,
    below,
  };
}

export async function getOptionDeltaLookup(
  request: OptionDeltaLookupRequest,
  dependencies: OptionDeltaLookupDependencies = {},
): Promise<OptionDeltaLookupResult> {
  const credentials = normalizeCredentials(request.credentials);
  const symbol = normalizeOptionSymbol(request.symbol);
  const dte = normalizeDte(request.dte);
  const targetDelta = normalizeTargetDelta(request.delta);
  const requestedSides = getRequestedSides(request.side);
  const chainCache = dependencies.chainCache ?? optionChainCache;
  const contractCache = dependencies.contractCache ?? optionContractCache;
  const rateLimiter = dependencies.rateLimiter ?? optionDataRateLimiter;

  const cachedExpirations = chainCache.get(symbol);
  if (undefined === cachedExpirations) {
    return rateLimiter.run(async () => {
      const client = (dependencies.clientFactory ?? createTastytradeClient)(credentials);
      const expirations = await getOptionChainExpirations(client, symbol, chainCache);
      return buildLookupResultFromExpirations({
        client,
        contractCache,
        dte,
        marketDataTimeoutMs: dependencies.marketDataTimeoutMs ?? defaultMarketDataTimeoutMs,
        requestedSide: request.side,
        requestedSides,
        symbol,
        targetDelta,
      }, expirations);
    });
  }

  const selectedExpiration = selectExpirationForDte(cachedExpirations, dte);
  if (null === selectedExpiration) {
    throw new OptionDeltaDataError(`No option expiration found on or after ${dte} DTE for ${symbol}.`);
  }

  const cachedContracts = getCachedContracts(contractCache, symbol, selectedExpiration.expiration, requestedSides);
  if (undefined !== cachedContracts) {
    return buildLookupResult({
      contracts: cachedContracts,
      requestedDte: dte,
      requestedSide: request.side,
      requestedSides,
      selectedExpiration,
      symbol,
      targetDelta,
    });
  }

  return rateLimiter.run(async () => {
    const client = (dependencies.clientFactory ?? createTastytradeClient)(credentials);
    const contracts = await getOptionContracts(
      client,
      symbol,
      selectedExpiration.expiration,
      requestedSides,
      dependencies.marketDataTimeoutMs ?? defaultMarketDataTimeoutMs,
      contractCache,
    );

    return buildLookupResult({
      contracts,
      requestedDte: dte,
      requestedSide: request.side,
      requestedSides,
      selectedExpiration,
      symbol,
      targetDelta,
    });
  });
}

async function getOptionChainExpirations(
  client: TastytradeClientLike,
  symbol: string,
  chainCache: OptionDeltaCache<ChainExpiration[]>,
): Promise<ChainExpiration[]> {
  const cachedExpirations = chainCache.get(symbol);
  if (undefined !== cachedExpirations) {
    return cachedExpirations;
  }

  const chainData = await client.instrumentsService.getNestedOptionChain(symbol);
  const expirations = parseTastytradeNestedOptionChain(chainData);
  chainCache.set(symbol, expirations);
  return expirations;
}

function getContractsCacheKey(symbol: string, expiration: ChainExpiration, requestedSides: OptionDeltaSide[]): string {
  return `${symbol}:${expiration.expirationDate}:${requestedSides.join("+")}`;
}

function getCachedContracts(
  contractCache: OptionDeltaCache<OptionDeltaContract[]>,
  symbol: string,
  expiration: ChainExpiration,
  requestedSides: OptionDeltaSide[],
): OptionDeltaContract[] | undefined {
  const cachedContracts = contractCache.get(getContractsCacheKey(symbol, expiration, requestedSides));
  if (undefined !== cachedContracts) {
    return cachedContracts;
  }

  if (1 === requestedSides.length) {
    const cachedBothSidesContracts = contractCache.get(getContractsCacheKey(symbol, expiration, ["call", "put"]));
    if (undefined !== cachedBothSidesContracts) {
      return cachedBothSidesContracts.filter(contract => contract.optionType === requestedSides[0]);
    }
  }

  return undefined;
}

async function getOptionContracts(
  client: TastytradeClientLike,
  symbol: string,
  expiration: ChainExpiration,
  requestedSides: OptionDeltaSide[],
  marketDataTimeoutMs: number,
  contractCache: OptionDeltaCache<OptionDeltaContract[]>,
): Promise<OptionDeltaContract[]> {
  const cachedContracts = getCachedContracts(contractCache, symbol, expiration, requestedSides);
  if (undefined !== cachedContracts) {
    return cachedContracts;
  }

  const streamerSymbols = expiration.strikes.flatMap(strike => {
    return requestedSides.flatMap(side => getStrikeStreamerSymbol(strike, side) ?? []);
  });
  if (0 === streamerSymbols.length) {
    throw new OptionDeltaDataError(`No option contracts found for ${symbol} ${expiration.expirationDate}.`);
  }

  const streamedData = await collectMarketData(
    client.quoteStreamer,
    [...new Set(streamerSymbols)],
    marketDataTimeoutMs,
  );
  const contracts = buildContracts(expiration, requestedSides, streamedData);
  contractCache.set(getContractsCacheKey(symbol, expiration, requestedSides), contracts);
  return contracts;
}

type BuildLookupResultFromExpirationsRequest = {
  client: TastytradeClientLike;
  contractCache: OptionDeltaCache<OptionDeltaContract[]>;
  dte: number;
  marketDataTimeoutMs: number;
  requestedSide: OptionDeltaRequestedSide;
  requestedSides: OptionDeltaSide[];
  symbol: string;
  targetDelta: number;
};

async function buildLookupResultFromExpirations(
  request: BuildLookupResultFromExpirationsRequest,
  expirations: ChainExpiration[],
): Promise<OptionDeltaLookupResult> {
  const selectedExpiration = selectExpirationForDte(expirations, request.dte);
  if (null === selectedExpiration) {
    throw new OptionDeltaDataError(`No option expiration found on or after ${request.dte} DTE for ${request.symbol}.`);
  }

  const contracts = await getOptionContracts(
    request.client,
    request.symbol,
    selectedExpiration.expiration,
    request.requestedSides,
    request.marketDataTimeoutMs,
    request.contractCache,
  );

  return buildLookupResult({
    contracts,
    requestedDte: request.dte,
    requestedSide: request.requestedSide,
    requestedSides: request.requestedSides,
    selectedExpiration,
    symbol: request.symbol,
    targetDelta: request.targetDelta,
  });
}

type BuildLookupResultRequest = {
  contracts: OptionDeltaContract[];
  requestedDte: number;
  requestedSide: OptionDeltaRequestedSide;
  requestedSides: OptionDeltaSide[];
  selectedExpiration: SelectedExpiration;
  symbol: string;
  targetDelta: number;
};

function buildLookupResult(request: BuildLookupResultRequest): OptionDeltaLookupResult {
  const sideResults = request.requestedSides.map(side => {
    const sideContracts = request.contracts.filter(contract => contract.optionType === side);
    return {
      brackets: findDeltaBrackets(sideContracts, request.targetDelta),
      contractsConsidered: sideContracts.length,
      side,
    };
  });

  return {
    actualDte: request.selectedExpiration.expiration.daysToExpiration,
    expiration: request.selectedExpiration.expiration.expirationDate,
    requestedDte: request.requestedDte,
    requestedSide: request.requestedSide,
    rolled: request.selectedExpiration.rolled,
    sideResults,
    symbol: request.symbol,
    targetDelta: request.targetDelta,
  };
}
