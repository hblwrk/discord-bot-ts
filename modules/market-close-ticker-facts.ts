import moment from "moment-timezone";
import {type getWithRetry} from "./http-retry.ts";

export type MarketCloseTickerSymbol = "SPX" | "NQ" | "RTY" | "VIX";

export type MarketCloseTickerFact = {
  close: number;
  closeChange: number;
  closeChangePercent: number;
  date: string;
  high: number;
  low: number;
  open: number;
  openToCloseChange: number;
  openToCloseChangePercent: number;
  previousClose: number;
  sourceSymbol: string;
  symbol: MarketCloseTickerSymbol;
};

type Logger = {
  log: (level: string, message: string) => void;
};

type MarketCloseTickerFactsDependencies = {
  getWithRetryFn: typeof getWithRetry;
  logger: Logger;
};

type YahooChartResponse = {
  chart?: {
    error?: unknown;
    result?: unknown;
  };
};

type YahooDailyBar = {
  close: number;
  date: string;
  high: number;
  low: number;
  open: number;
};

const usEasternTimezone = "US/Eastern";
const yahooChartBaseUrl = "https://query1.finance.yahoo.com/v8/finance/chart";
const yahooTickers = [
  {symbol: "SPX", sourceSymbol: "^GSPC"},
  {symbol: "NQ", sourceSymbol: "^NDX"},
  {symbol: "RTY", sourceSymbol: "^RUT"},
  {symbol: "VIX", sourceSymbol: "^VIX"},
] satisfies {sourceSymbol: string; symbol: MarketCloseTickerSymbol}[];

export async function loadMarketCloseTickerFacts(
  date: Date,
  dependencies: MarketCloseTickerFactsDependencies,
): Promise<MarketCloseTickerFact[]> {
  const facts = await Promise.all(yahooTickers.map(ticker => loadTickerFact(date, ticker, dependencies)));
  return facts.filter(isDefined);
}

export function formatMarketCloseTickerFactsForPrompt(facts: MarketCloseTickerFact[]): string {
  if (0 === facts.length) {
    return "";
  }

  return [
    "Verifizierte Ticker-Daten aus Daily-Bars fuer den Zieltag:",
    ...facts.map(fact => [
      `- \`${fact.symbol}\` (${fact.sourceSymbol})`,
      `Open \`${formatValue(fact.open)}\``,
      `High \`${formatValue(fact.high)}\``,
      `Low \`${formatValue(fact.low)}\``,
      `Close \`${formatValue(fact.close)}\``,
      `Vortag \`${formatValue(fact.previousClose)}\``,
      `Close-to-close \`${formatSignedPercent(fact.closeChangePercent)}\``,
      `Open-to-close \`${formatSignedPercent(fact.openToCloseChangePercent)}\``,
    ].join("; ")),
    "Diese Ticker-Daten haben Vorrang vor News-Texten: Nutze Websuche nur fuer Ursachen/Einordnung, nicht fuer Richtung, Schlusskurs oder Sentiment.",
    "Behaupte keine Schlusskurs-Rekorde, neuen Hochs zum Close oder breite Staerke, wenn diese Daily-Bars das nicht stuetzen.",
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

async function loadTickerFact(
  date: Date,
  ticker: {sourceSymbol: string; symbol: MarketCloseTickerSymbol},
  dependencies: MarketCloseTickerFactsDependencies,
): Promise<MarketCloseTickerFact | undefined> {
  const targetDate = moment(date).tz(usEasternTimezone).format("YYYY-MM-DD");
  const requestStart = moment.tz(`${targetDate} 00:00`, "YYYY-MM-DD HH:mm", usEasternTimezone).subtract(10, "days");
  const requestEnd = moment.tz(`${targetDate} 00:00`, "YYYY-MM-DD HH:mm", usEasternTimezone).add(2, "days");
  const url = `${yahooChartBaseUrl}/${encodeURIComponent(ticker.sourceSymbol)}` +
    `?period1=${requestStart.unix()}` +
    `&period2=${requestEnd.unix()}` +
    "&interval=1d" +
    "&includePrePost=false";

  const response = await dependencies.getWithRetryFn<YahooChartResponse>(url, undefined, {
    maxAttempts: 2,
    timeoutMs: 8_000,
  }).catch(error => {
    dependencies.logger.log(
      "warn",
      `Could not load market close ticker facts for ${ticker.symbol}: ${error}`,
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
      `Market close ticker facts for ${ticker.symbol} did not include ${targetDate} with a prior close.`,
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
    date: targetBar.date,
    high: targetBar.high,
    low: targetBar.low,
    open: targetBar.open,
    openToCloseChange,
    openToCloseChangePercent: getPercentChange(openToCloseChange, targetBar.open),
    previousClose: previousBar.close,
    sourceSymbol: ticker.sourceSymbol,
    symbol: ticker.symbol,
  };
}

function parseYahooDailyBars(data: YahooChartResponse): YahooDailyBar[] {
  const result = getFirstResult(data);
  if (undefined === result) {
    return [];
  }

  const timestamps = getNumberArray(result["timestamp"]);
  const quote = getFirstQuote(result);
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

function getFirstResult(data: YahooChartResponse): Record<string, unknown> | undefined {
  const result = data.chart?.result;
  if (false === Array.isArray(result)) {
    return undefined;
  }

  const firstResult: unknown = result[0];
  return isRecord(firstResult) ? firstResult : undefined;
}

function getFirstQuote(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const indicators = result["indicators"];
  if (false === isRecord(indicators)) {
    return undefined;
  }

  const quote = indicators["quote"];
  if (false === Array.isArray(quote)) {
    return undefined;
  }

  const firstQuote: unknown = quote[0];
  return isRecord(firstQuote) ? firstQuote : undefined;
}

function getNumberArray(value: unknown): (number | undefined)[] {
  if (false === Array.isArray(value)) {
    return [];
  }

  return value.map(item => "number" === typeof item && Number.isFinite(item) ? item : undefined);
}

function hasUnsupportedClosingHighClaim(value: string, facts: MarketCloseTickerFact[]): boolean {
  if (false === /(?:schluss|schloss|close|closing|bis zum (?:regulaeren |regulären )?(?:close|schluss)|bis zum schluss|zum (?:close|schluss))[^\n.?!;:]{0,120}(?:neue?n? hochs?|rekordhoch|rekord|record high|new highs?)|(?:neue?n? hochs?|rekordhoch|rekord|record high|new highs?)[^\n.?!;:]{0,120}(?:schluss|schloss|close|closing|bis zum (?:regulaeren |regulären )?(?:close|schluss)|bis zum schluss|zum (?:close|schluss))/iu.test(value)) {
    return false;
  }

  const relevantFacts = getReferencedEquityFacts(value, facts);
  return relevantFacts.some(fact => false === isCloseNearDailyHigh(fact) || fact.closeChange < 0);
}

function hasSymbolDirectionContradiction(value: string, fact: MarketCloseTickerFact): boolean {
  if (fact.closeChangePercent > -0.1 || fact.openToCloseChangePercent > -0.1) {
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

  const weakEquityCount = equityFacts.filter(fact => fact.openToCloseChangePercent <= -0.1).length;
  const strongEquityCount = equityFacts.filter(fact => fact.openToCloseChangePercent >= 0.1).length;
  const vixFact = facts.find(fact => "VIX" === fact.symbol);
  if ("Risk-on" === winningPollAnswer &&
      weakEquityCount >= 2 &&
      (undefined === vixFact || vixFact.openToCloseChange >= -0.05)) {
    return true;
  }

  if ("Risk-off" === winningPollAnswer &&
      strongEquityCount >= 2 &&
      (undefined === vixFact || vixFact.openToCloseChange <= 0.05)) {
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
  if (0 === fact.high) {
    return false;
  }

  return ((fact.high - fact.close) / fact.high) <= 0.001;
}

function getPercentChange(change: number, base: number): number {
  if (0 === base) {
    return 0;
  }

  return (change / base) * 100;
}

function formatValue(value: number): string {
  const [integer = "0", decimal = "00"] = Math.abs(value).toFixed(2).split(".");
  const formattedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const sign = value < 0 ? "-" : "";
  return `${sign}${formattedInteger},${decimal}`;
}

function formatSignedPercent(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2).replace(".", ",")}%`;
}

function isDefined<T>(value: T | undefined): value is T {
  return undefined !== value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && false === Array.isArray(value);
}
