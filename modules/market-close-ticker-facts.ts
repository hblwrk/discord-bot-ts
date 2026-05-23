import {randomUUID} from "node:crypto";
import moment from "moment-timezone";
import {getMarketDataAssetConfigs, type MarketDataAsset as ConfiguredMarketDataAsset} from "./assets.ts";
import {type getWithRetry} from "./http-retry.ts";
import {
  getMarketDataBotSymbol,
  getMarketDataSnapshots,
  type MarketDataBotSymbol,
  type MarketDataSnapshot,
} from "./market-data-snapshots.ts";
import {type MarketDataSource} from "./market-data-types.ts";

export type MarketCloseTickerSymbol = MarketDataBotSymbol;
export type MarketCloseTickerFactSource = "investing-daily-bar" | "market-data-bot" | "yahoo-daily-bar";

export type MarketCloseTickerFact = {
  close: number;
  closeChange: number;
  closeChangePercent: number;
  dataSource?: MarketCloseTickerFactSource | undefined;
  date: string;
  high?: number | undefined;
  low?: number | undefined;
  marketDataPid?: number | undefined;
  marketDataSource?: MarketDataSource | undefined;
  open?: number | undefined;
  openToCloseChange?: number | undefined;
  openToCloseChangePercent?: number | undefined;
  previousClose: number;
  sourceSymbol: string;
  symbol: MarketCloseTickerSymbol;
  updatedAt?: string | undefined;
};

type Logger = {
  log: (level: string, message: string) => void;
};

type MarketCloseTickerFactsDependencies = {
  getWithRetryFn?: typeof getWithRetry | undefined;
  logger: Logger;
};
type MarketCloseTickerFactsOptions = {
  referenceTime?: Date | undefined;
};

type InvestingHistoryResponse = {
  c?: unknown;
  h?: unknown;
  l?: unknown;
  o?: unknown;
  s?: unknown;
  t?: unknown;
};

type InvestingDailyBar = {
  close: number;
  date: string;
  high: number;
  low: number;
  open: number;
};
type YahooChartResponse = {
  chart?: {
    error?: unknown;
    result?: unknown;
  };
};
type YahooDailyBar = InvestingDailyBar;

const usEasternTimezone = "US/Eastern";
const investingTvcBaseUrl = "https://tvc6.investing.com";
const yahooChartBaseUrl = "https://query1.finance.yahoo.com/v8/finance/chart";
const marketDataSnapshotMaxAgeMs = 30 * 60_000;
const requiredMarketCloseTickerSymbols = ["ES", "NQ", "RTY", "VIX"] satisfies MarketCloseTickerSymbol[];
const yahooTickers = {
  ES: "ES=F",
  NQ: "NQ=F",
  RTY: "RTY=F",
  VIX: "^VIX",
} satisfies Record<MarketCloseTickerSymbol, string>;
const investingRequestHeaders = {
  "Content-Type": "application/json",
  Referer: "https://tvc-invdn-com.investing.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.102 Safari/537.36",
};
const yahooRequestHeaders = {
  "User-Agent": investingRequestHeaders["User-Agent"],
};

export async function loadMarketCloseTickerFacts(
  date: Date,
  dependencies: MarketCloseTickerFactsDependencies,
  options: MarketCloseTickerFactsOptions = {},
): Promise<MarketCloseTickerFact[]> {
  const snapshotFacts = loadMarketDataSnapshotFacts(date, options.referenceTime ?? date);
  if (true === hasRequiredMarketCloseTickerFacts(snapshotFacts)) {
    return snapshotFacts;
  }

  const tickerAssets = getMarketCloseTickerAssets(dependencies.logger);
  if (undefined === dependencies.getWithRetryFn || 0 === tickerAssets.length) {
    return snapshotFacts;
  }

  const factsBySymbol = new Map<MarketCloseTickerSymbol, MarketCloseTickerFact>(
    snapshotFacts.map(fact => [fact.symbol, fact]),
  );
  const missingTickerAssets = tickerAssets.filter(asset => {
    const symbol = getMarketDataBotSymbol(asset);
    return undefined !== symbol && false === factsBySymbol.has(symbol);
  });
  const historicalFacts = await Promise.all(
    missingTickerAssets.map(asset => loadHistoricalTickerFact(date, asset, dependencies)),
  );
  for (const historicalFact of historicalFacts) {
    if (undefined !== historicalFact) {
      factsBySymbol.set(historicalFact.symbol, historicalFact);
    }
  }

  return Array.from(factsBySymbol.values())
    .sort((left, right) => getSymbolOrder(left.symbol) - getSymbolOrder(right.symbol));
}

export function hasRequiredMarketCloseTickerFacts(facts: MarketCloseTickerFact[]): boolean {
  const availableSymbols = new Set(facts.map(fact => fact.symbol));
  return requiredMarketCloseTickerSymbols.every(symbol => availableSymbols.has(symbol));
}

export function formatMarketCloseTickerFactsForPrompt(facts: MarketCloseTickerFact[]): string {
  if (0 === facts.length) {
    return "";
  }

  return [
    "Verifizierte Markt-Daten fuer den Zieltag aus denselben Market-Data-Bot-Symbolen:",
    ...facts.map(formatTickerFactForPrompt),
    "Diese Bot-/Investing-Daten haben Vorrang vor News-Texten: Nutze Websuche nur fuer Ursachen/Einordnung, nicht fuer Richtung, Stand, Veraenderung oder Sentiment.",
    "Bei Market-Data-Bot-Snapshots sind Stand und Bot-Veraenderung bindend; behaupte daraus keine Cash-Index-Schlusskurse, keine Tageshochs und keine Open/High/Low-Spannen.",
    "Behaupte keine Schlusskurs-Rekorde, neuen Hochs zum Close oder breite Staerke, wenn diese Fakten das nicht stuetzen.",
  ].join("\n");
}

export function getTickerFactValidationIssue(
  combinedText: string,
  winningPollAnswer: string,
  facts: MarketCloseTickerFact[],
): string | undefined {
  if (0 === facts.length) {
    return undefined;
  }

  if (true === hasUnsupportedClosingHighClaim(combinedText, facts)) {
    return "output claimed closing highs not supported by ticker facts";
  }

  const contradictedSymbol = facts.find(fact => hasSymbolDirectionContradiction(combinedText, fact))?.symbol;
  if (undefined !== contradictedSymbol) {
    return `output direction contradicted ticker facts for ${contradictedSymbol}`;
  }

  if (true === hasUnsupportedSentimentAnswer(winningPollAnswer, facts)) {
    return `poll answer ${winningPollAnswer} contradicted ticker facts`;
  }

  return undefined;
}

function loadMarketDataSnapshotFacts(date: Date, referenceTime: Date): MarketCloseTickerFact[] {
  const targetDate = moment(date).tz(usEasternTimezone).format("YYYY-MM-DD");
  return getMarketDataSnapshots({
    maxAgeMs: marketDataSnapshotMaxAgeMs,
    referenceTime,
  }).map(snapshot => getTickerFactFromSnapshot(snapshot, targetDate));
}

function getTickerFactFromSnapshot(snapshot: MarketDataSnapshot, targetDate: string): MarketCloseTickerFact {
  const previousClose = snapshot.lastNumeric - snapshot.priceChange;
  return {
    close: snapshot.lastNumeric,
    closeChange: snapshot.priceChange,
    closeChangePercent: snapshot.percentageChange,
    dataSource: "market-data-bot",
    date: targetDate,
    marketDataPid: snapshot.marketDataPid,
    marketDataSource: snapshot.marketDataSource,
    previousClose,
    sourceSymbol: `marketdata:${snapshot.assetName || snapshot.symbol.toLowerCase()}#${snapshot.marketDataPid}`,
    symbol: snapshot.symbol,
    updatedAt: snapshot.updatedAt.toISOString(),
  };
}

function getMarketCloseTickerAssets(logger: Logger): ConfiguredMarketDataAsset[] {
  const assets = getMarketDataAssetConfigs();
  const assetsBySymbol = new Map<MarketCloseTickerSymbol, ConfiguredMarketDataAsset>();
  for (const asset of assets) {
    const symbol = getMarketDataBotSymbol(asset);
    if (undefined !== symbol && false === assetsBySymbol.has(symbol)) {
      assetsBySymbol.set(symbol, asset);
    }
  }

  for (const requiredSymbol of requiredMarketCloseTickerSymbols) {
    if (false === assetsBySymbol.has(requiredSymbol)) {
      logger.log(
        "warn",
        `Market close recap missing market-data asset for ${requiredSymbol}.`,
      );
    }
  }

  return requiredMarketCloseTickerSymbols
    .map(symbol => assetsBySymbol.get(symbol))
    .filter(isDefined);
}

async function loadInvestingTickerFact(
  date: Date,
  asset: ConfiguredMarketDataAsset,
  dependencies: MarketCloseTickerFactsDependencies,
): Promise<MarketCloseTickerFact | undefined> {
  const symbol = getMarketDataBotSymbol(asset);
  if (undefined === symbol || undefined === dependencies.getWithRetryFn) {
    return undefined;
  }

  const targetDate = moment(date).tz(usEasternTimezone).format("YYYY-MM-DD");
  const requestStart = moment.tz(`${targetDate} 00:00`, "YYYY-MM-DD HH:mm", usEasternTimezone).subtract(10, "days");
  const requestEnd = moment.tz(`${targetDate} 00:00`, "YYYY-MM-DD HH:mm", usEasternTimezone).add(2, "days");
  const url = `${investingTvcBaseUrl}/${randomUUID().replaceAll("-", "")}/0/0/0/0/history` +
    `?symbol=${encodeURIComponent(String(asset.id))}` +
    "&resolution=D" +
    `&from=${requestStart.unix()}` +
    `&to=${requestEnd.unix()}`;

  const response = await dependencies.getWithRetryFn<InvestingHistoryResponse>(url, {
    headers: investingRequestHeaders,
  }, {
    maxAttempts: 2,
    timeoutMs: 8_000,
  }).catch(error => {
    dependencies.logger.log(
      "warn",
      `Could not load market close ticker facts for ${symbol} from market-data pid ${asset.id}: ${error}`,
    );
    return undefined;
  });
  if (undefined === response) {
    return undefined;
  }

  const bars = parseInvestingDailyBars(response.data);
  const targetIndex = bars.findIndex(bar => bar.date === targetDate);
  if (targetIndex <= 0) {
    dependencies.logger.log(
      "warn",
      `Market close ticker facts for ${symbol} did not include ${targetDate} with a prior close.`,
    );
    return undefined;
  }

  const targetBar = bars[targetIndex];
  const previousBar = bars[targetIndex - 1];
  if (undefined === targetBar || undefined === previousBar) {
    return undefined;
  }

  const closeChange = targetBar.close - previousBar.close;
  const openToCloseChange = targetBar.close - targetBar.open;
  return {
    close: targetBar.close,
    closeChange,
    closeChangePercent: getPercentChange(closeChange, previousBar.close),
    dataSource: "investing-daily-bar",
    date: targetBar.date,
    high: targetBar.high,
    low: targetBar.low,
    marketDataPid: asset.id,
    open: targetBar.open,
    openToCloseChange,
    openToCloseChangePercent: getPercentChange(openToCloseChange, targetBar.open),
    previousClose: previousBar.close,
    sourceSymbol: `marketdata:${asset.name}#${asset.id}`,
    symbol,
  };
}

async function loadHistoricalTickerFact(
  date: Date,
  asset: ConfiguredMarketDataAsset,
  dependencies: MarketCloseTickerFactsDependencies,
): Promise<MarketCloseTickerFact | undefined> {
  const investingFact = await loadInvestingTickerFact(date, asset, dependencies);
  return investingFact ?? await loadYahooTickerFact(date, asset, dependencies);
}

async function loadYahooTickerFact(
  date: Date,
  asset: ConfiguredMarketDataAsset,
  dependencies: MarketCloseTickerFactsDependencies,
): Promise<MarketCloseTickerFact | undefined> {
  const symbol = getMarketDataBotSymbol(asset);
  if (undefined === symbol || undefined === dependencies.getWithRetryFn) {
    return undefined;
  }

  const sourceSymbol = yahooTickers[symbol];
  const targetDate = moment(date).tz(usEasternTimezone).format("YYYY-MM-DD");
  const requestStart = moment.tz(`${targetDate} 00:00`, "YYYY-MM-DD HH:mm", usEasternTimezone).subtract(10, "days");
  const requestEnd = moment.tz(`${targetDate} 00:00`, "YYYY-MM-DD HH:mm", usEasternTimezone).add(2, "days");
  const url = `${yahooChartBaseUrl}/${encodeURIComponent(sourceSymbol)}` +
    `?period1=${requestStart.unix()}` +
    `&period2=${requestEnd.unix()}` +
    "&interval=1d" +
    "&includePrePost=false";

  const response = await dependencies.getWithRetryFn<YahooChartResponse>(url, {
    headers: yahooRequestHeaders,
  }, {
    maxAttempts: 2,
    timeoutMs: 8_000,
  }).catch(error => {
    dependencies.logger.log(
      "warn",
      `Could not load market close ticker facts for ${symbol} from Yahoo symbol ${sourceSymbol}: ${error}`,
    );
    return undefined;
  });
  if (undefined === response) {
    return undefined;
  }

  const bars = parseYahooDailyBars(response.data);
  const targetIndex = bars.findIndex(bar => bar.date === targetDate);
  if (targetIndex <= 0) {
    dependencies.logger.log(
      "warn",
      `Yahoo market close ticker facts for ${symbol} did not include ${targetDate} with a prior close.`,
    );
    return undefined;
  }

  const targetBar = bars[targetIndex];
  const previousBar = bars[targetIndex - 1];
  if (undefined === targetBar || undefined === previousBar) {
    return undefined;
  }

  const closeChange = targetBar.close - previousBar.close;
  const openToCloseChange = targetBar.close - targetBar.open;
  return {
    close: targetBar.close,
    closeChange,
    closeChangePercent: getPercentChange(closeChange, previousBar.close),
    dataSource: "yahoo-daily-bar",
    date: targetBar.date,
    high: targetBar.high,
    low: targetBar.low,
    marketDataPid: asset.id,
    open: targetBar.open,
    openToCloseChange,
    openToCloseChangePercent: getPercentChange(openToCloseChange, targetBar.open),
    previousClose: previousBar.close,
    sourceSymbol: `yahoo:${sourceSymbol}`,
    symbol,
  };
}

function parseInvestingDailyBars(data: InvestingHistoryResponse): InvestingDailyBar[] {
  if (false === isRecord(data) || "ok" !== data.s) {
    return [];
  }

  const timestamps = getNumberArray(data.t);
  const opens = getNumberArray(data.o);
  const highs = getNumberArray(data.h);
  const lows = getNumberArray(data.l);
  const closes = getNumberArray(data.c);
  const bars: InvestingDailyBar[] = [];
  for (let index = 0; index < timestamps.length; index++) {
    const timestamp = timestamps[index];
    const open = opens[index];
    const high = highs[index];
    const low = lows[index];
    const close = closes[index];
    if (undefined === timestamp ||
        undefined === open ||
        undefined === high ||
        undefined === low ||
        undefined === close) {
      continue;
    }

    bars.push({
      close,
      date: moment.unix(timestamp).utc().format("YYYY-MM-DD"),
      high,
      low,
      open,
    });
  }

  return bars;
}

function parseYahooDailyBars(data: YahooChartResponse): YahooDailyBar[] {
  const result = getFirstYahooResult(data);
  if (undefined === result) {
    return [];
  }

  const timestamps = getNumberArray(result["timestamp"]);
  const quote = getFirstYahooQuote(result);
  if (undefined === quote) {
    return [];
  }

  const opens = getNumberArray(quote["open"]);
  const highs = getNumberArray(quote["high"]);
  const lows = getNumberArray(quote["low"]);
  const closes = getNumberArray(quote["close"]);
  const bars: YahooDailyBar[] = [];
  for (let index = 0; index < timestamps.length; index++) {
    const timestamp = timestamps[index];
    const open = opens[index];
    const high = highs[index];
    const low = lows[index];
    const close = closes[index];
    if (undefined === timestamp ||
        undefined === open ||
        undefined === high ||
        undefined === low ||
        undefined === close) {
      continue;
    }

    bars.push({
      close,
      date: moment.unix(timestamp).tz(usEasternTimezone).format("YYYY-MM-DD"),
      high,
      low,
      open,
    });
  }

  return bars;
}

function formatTickerFactForPrompt(fact: MarketCloseTickerFact): string {
  if ("market-data-bot" === fact.dataSource) {
    const updatedAt = undefined === fact.updatedAt ? "" : `; Aktualisiert \`${formatTimestamp(fact.updatedAt)}\``;
    return [
      `- \`${fact.symbol}\` (${fact.sourceSymbol}, ${fact.marketDataSource ?? "market-data"}${updatedAt})`,
      `Stand \`${formatValue(fact.close)}\``,
      `Referenz \`${formatValue(fact.previousClose)}\``,
      `Bot-Veraenderung \`${formatSignedChange(fact)}\``,
    ].join("; ");
  }

  const dailyBarSource = "yahoo-daily-bar" === fact.dataSource ? "Yahoo Daily-Bar" : "Investing Daily-Bar";
  const dailyFields = [
    `- \`${fact.symbol}\` (${fact.sourceSymbol}, ${dailyBarSource})`,
    undefined === fact.open ? undefined : `Open \`${formatValue(fact.open)}\``,
    undefined === fact.high ? undefined : `High \`${formatValue(fact.high)}\``,
    undefined === fact.low ? undefined : `Low \`${formatValue(fact.low)}\``,
    `Close \`${formatValue(fact.close)}\``,
    `Vortag \`${formatValue(fact.previousClose)}\``,
    `Close-to-close \`${formatSignedChange(fact)}\``,
    undefined === fact.openToCloseChangePercent ? undefined : `Open-to-close \`${formatSignedPercent(fact.openToCloseChangePercent)}\``,
  ];

  return dailyFields.filter(isDefined).join("; ");
}

function hasUnsupportedClosingHighClaim(value: string, facts: MarketCloseTickerFact[]): boolean {
  if (false === /(?:schluss|schloss|close|closing|bis zum (?:regulaeren |regulären )?(?:close|schluss)|bis zum schluss|zum (?:close|schluss))[^\n.?!;:]{0,120}(?:neue?n? hochs?|rekordhoch|rekord|record high|new highs?)|(?:neue?n? hochs?|rekordhoch|rekord|record high|new highs?)[^\n.?!;:]{0,120}(?:schluss|schloss|close|closing|bis zum (?:regulaeren |regulären )?(?:close|schluss)|bis zum schluss|zum (?:close|schluss))/iu.test(value)) {
    return false;
  }

  const relevantFacts = getReferencedEquityFacts(value, facts);
  return relevantFacts.some(fact => "market-data-bot" === fact.dataSource || false === isCloseNearDailyHigh(fact) || fact.closeChange < 0);
}

function hasSymbolDirectionContradiction(value: string, fact: MarketCloseTickerFact): boolean {
  if (getPrimaryChangePercent(fact) > -0.1) {
    return false;
  }

  const symbolPattern = `\\b${fact.symbol}\\b`;
  const bullishAfterSymbol = new RegExp(`${symbolPattern}[^\\n.?!;:]{0,100}\\b(?:stieg|zogen|zog|legte(?:n)? zu|gewann(?:en)?|schloss(?:en)? (?:hoeher|höher|fester|im plus)|neue?n? hochs?|record high|new highs?|higher|up)\\b`, "iu");
  const bullishBeforeSymbol = new RegExp(`\\b(?:stieg|zogen|zog|legte(?:n)? zu|gewann(?:en)?|schloss(?:en)? (?:hoeher|höher|fester|im plus)|higher|up)\\b[^\\n.?!;:]{0,100}${symbolPattern}`, "iu");
  return bullishAfterSymbol.test(value) || bullishBeforeSymbol.test(value);
}

function hasUnsupportedSentimentAnswer(winningPollAnswer: string, facts: MarketCloseTickerFact[]): boolean {
  const equityFacts = facts.filter(fact => "VIX" !== fact.symbol);
  if (equityFacts.length < 2) {
    return false;
  }

  const weakEquityCount = equityFacts.filter(fact => getPrimaryChangePercent(fact) <= -0.1).length;
  const strongEquityCount = equityFacts.filter(fact => getPrimaryChangePercent(fact) >= 0.1).length;
  const vixFact = facts.find(fact => "VIX" === fact.symbol);
  if ("Risk-on" === winningPollAnswer &&
      weakEquityCount >= 2 &&
      (undefined === vixFact || getPrimaryChange(vixFact) >= -0.05)) {
    return true;
  }

  if ("Risk-off" === winningPollAnswer &&
      strongEquityCount >= 2 &&
      (undefined === vixFact || getPrimaryChange(vixFact) <= 0.05)) {
    return true;
  }

  return false;
}

function getReferencedEquityFacts(value: string, facts: MarketCloseTickerFact[]): MarketCloseTickerFact[] {
  const equityFacts = facts.filter(fact => "VIX" !== fact.symbol);
  const referencedFacts = equityFacts.filter(fact => new RegExp(`\\b${fact.symbol}\\b`, "iu").test(value));
  return 0 < referencedFacts.length ? referencedFacts : equityFacts;
}

function isCloseNearDailyHigh(fact: MarketCloseTickerFact): boolean {
  if (undefined === fact.high || 0 === fact.high) {
    return false;
  }

  return ((fact.high - fact.close) / fact.high) <= 0.001;
}

function getPrimaryChange(fact: MarketCloseTickerFact): number {
  return fact.openToCloseChange ?? fact.closeChange;
}

function getPrimaryChangePercent(fact: MarketCloseTickerFact): number {
  return fact.openToCloseChangePercent ?? fact.closeChangePercent;
}

function getPercentChange(change: number, base: number): number {
  if (0 === base) {
    return 0;
  }

  return (change / base) * 100;
}

function getNumberArray(value: unknown): (number | undefined)[] {
  if (false === Array.isArray(value)) {
    return [];
  }

  return value.map(item => "number" === typeof item && Number.isFinite(item) ? item : undefined);
}

function getFirstYahooResult(data: YahooChartResponse): Record<string, unknown> | undefined {
  const chart = data.chart;
  if (false === isRecord(chart) || (undefined !== chart["error"] && null !== chart["error"])) {
    return undefined;
  }

  const results = chart["result"];
  if (false === Array.isArray(results)) {
    return undefined;
  }

  return results.find(isRecord);
}

function getFirstYahooQuote(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const indicators = result["indicators"];
  if (false === isRecord(indicators)) {
    return undefined;
  }

  const quotes = indicators["quote"];
  if (false === Array.isArray(quotes)) {
    return undefined;
  }

  return quotes.find(isRecord);
}

function formatValue(value: number): string {
  const [integer = "0", decimal = "00"] = Math.abs(value).toFixed(2).split(".");
  const formattedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const sign = value < 0 ? "-" : "";
  return `${sign}${formattedInteger},${decimal}`;
}

function formatSignedChange(fact: MarketCloseTickerFact): string {
  if ("VIX" === fact.symbol) {
    const sign = fact.closeChange >= 0 ? "+" : "";
    return `${sign}${fact.closeChange.toFixed(2).replace(".", ",")} Punkte`;
  }

  return formatSignedPercent(fact.closeChangePercent);
}

function formatSignedPercent(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2).replace(".", ",")}%`;
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return value;
  }

  return timestamp.toISOString().slice(11, 19);
}

function getSymbolOrder(symbol: MarketCloseTickerSymbol): number {
  return requiredMarketCloseTickerSymbols.indexOf(symbol);
}

function isDefined<T>(value: T | undefined): value is T {
  return undefined !== value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && false === Array.isArray(value);
}
