import moment from "moment-timezone";
import {getWithRetry} from "./http-retry.ts";
import {safeHttpsAgent} from "./safe-http.ts";
import type {TwitterPostContext} from "./twitter-sanity-score.ts";

export type TwitterPriceCheck = {
  verdict: "supported" | "contradicted";
  sentence: string;
  source: string;
};

type PriceCheckDependencies = {
  getWithRetryFn?: typeof getWithRetry;
  logger: {log: (level: string, message: string) => void};
  nowMs?: () => number;
};

type PriceClaim = {ticker: string; debutDrop?: {percent: number; approximate: boolean}; newLow: boolean};
type PriceBar = {timeMs: number; date: string; open: number; high: number; low: number; close: number};
type Chart = {meta: Record<string, unknown>; bars: PriceBar[]; splits: unknown};

const chartBase = "https://query1.finance.yahoo.com/v8/finance/chart";
const yahooHeaders = {"User-Agent": "Mozilla/5.0 (compatible; hblwrk/1.0)"};
const timezone = "America/New_York";
const dayMs = 86_400_000;

export function priceClaimInPost(post: TwitterPostContext): PriceClaim | undefined {
  const symbols = [...new Set([...post.text.matchAll(/\$([A-Z]{1,5})\b/giu)].map(match => match[1]!.toUpperCase()))];
  if (symbols.length !== 1) return undefined;
  const debut = /\bdown\s*(~|about\s+|around\s+|approximately\s+)?(\d{1,2}(?:\.\d+)?)\s*%\s+since\s+(?:its\s+|the\s+)?(?:stock\s+market\s+|market\s+)?(?:debut|first\s+trad(?:e|ing)(?:\s+day)?)\b/iu.exec(post.text);
  const newLow = /\b(?:new|record)\s+52[ -]week\s+low\b/iu.test(post.text);
  if (null === debut && !newLow) return undefined;
  const percent = null === debut ? undefined : Number(debut[2]);
  if (undefined !== percent && (!Number.isFinite(percent) || percent <= 0 || percent >= 100)) return undefined;
  return {ticker: symbols[0]!, newLow,
    ...(undefined === percent ? {} : {debutDrop: {percent, approximate: Boolean(debut?.[1])}})};
}

export async function checkTwitterPriceClaims(
  post: TwitterPostContext, statusId: string, dependencies: PriceCheckDependencies,
): Promise<TwitterPriceCheck | undefined> {
  const claim = priceClaimInPost(post);
  const postedMs = Date.parse(post.createdAt ?? "");
  const nowMs = dependencies.nowMs?.() ?? Date.now();
  if (undefined === claim || !Number.isFinite(postedMs) || !/^\d{15,20}$/u.test(statusId)
    || postedMs > nowMs + 2 * 60_000 || nowMs - postedMs > 7 * dayMs) return undefined;
  const idTimeMs = Number((BigInt(statusId) >> 22n) + 1_288_834_974_657n);
  if (Math.abs(postedMs - idTimeMs) > 60_000) return undefined;

  try {
    const daily = await loadChart(claim.ticker, postedMs - 370 * dayMs, postedMs + dayMs,
      "1d", dependencies);
    if (undefined === daily || daily.meta["symbol"] !== claim.ticker
      || daily.meta["instrumentType"] !== "EQUITY" || daily.meta["currency"] !== "USD"
      || daily.meta["exchangeTimezoneName"] !== timezone || hasSplits(daily.splits)) return undefined;
    const companyName = daily.meta["longName"] ?? daily.meta["shortName"];
    const company = typeof companyName === "string" ? companyName.toLowerCase() : "";
    const precedingName = new RegExp(`\\b([A-Za-z]{4,})\\s+\\$${claim.ticker}\\b`, "iu").exec(post.text)?.[1]?.toLowerCase();
    if (undefined !== precedingName && !company.includes(precedingName)) return undefined;

    const postEastern = moment(postedMs).tz(timezone);
    const postDate = postEastern.format("YYYY-MM-DD");
    const postMinutes = postEastern.hour() * 60 + postEastern.minute();
    const inSession = postEastern.day() >= 1 && postEastern.day() <= 5 && postMinutes >= 570 && postMinutes < 960;
    const complete = daily.bars.filter(bar => bar.date < postDate || (bar.date === postDate && postMinutes >= 960));
    const last = complete.at(-1);
    const first = daily.bars[0];
    const expectedSession = postEastern.clone();
    if (postMinutes < 960) expectedSession.subtract(1, "day");
    while (expectedSession.day() === 0 || expectedSession.day() === 6) expectedSession.subtract(1, "day");
    if (undefined === last || undefined === first || last.date !== expectedSession.format("YYYY-MM-DD")
      || postedMs - last.timeMs > 5 * dayMs) return undefined;
    let observedPrice = last.close;
    let sessionLow = last.low;
    const lowLookbackMs = postEastern.clone().subtract(365, "days").startOf("day").valueOf();
    let previousLows = complete.slice(0, -1).filter(bar => bar.timeMs >= lowLookbackMs);
    if (inSession) {
      const minuteChart = await loadChart(claim.ticker, postEastern.clone().startOf("day").valueOf(), postedMs + 60_000,
        "1m", dependencies);
      const minuteBars = minuteChart?.bars.filter(bar => bar.date === postDate && bar.timeMs + 60_000 <= postedMs) ?? [];
      const minute = minuteBars.at(-1);
      if (minuteChart?.meta["symbol"] !== claim.ticker || undefined === minute || postedMs - minute.timeMs > 16 * 60_000) {
        return undefined;
      }
      const marketOpenMs = postEastern.clone().hour(9).minute(30).second(0).millisecond(0).valueOf();
      const expectedMinutes = Math.floor((postedMs - marketOpenMs) / 60_000);
      if (minuteBars[0]!.timeMs > marketOpenMs + 60_000 || minuteBars.length < expectedMinutes * 0.85) return undefined;
      observedPrice = minute.close;
      sessionLow = Math.min(...minuteBars.map(bar => bar.low));
      previousLows = complete.filter(bar => bar.timeMs >= lowLookbackMs);
    }

    const checks: boolean[] = [];
    let dropPercent: number | undefined;
    let lowMatches: boolean | undefined;
    if (undefined !== claim.debutDrop) {
      const firstTradeDate = daily.meta["firstTradeDate"];
      if ("number" !== typeof firstTradeDate || !Number.isFinite(firstTradeDate)
        || moment.unix(firstTradeDate).tz(timezone).format("YYYY-MM-DD") !== first.date) return undefined;
      dropPercent = (1 - observedPrice / first.open) * 100;
      const difference = Math.abs(dropPercent - claim.debutDrop.percent);
      if (difference > (claim.debutDrop.approximate ? 2 : 1) && difference < 5) return undefined;
      checks.push(difference <= (claim.debutDrop.approximate ? 2 : 1));
    }
    if (claim.newLow) {
      if (previousLows.length === 0 || !hasSufficientLowHistory(daily, postedMs, last.date)) return undefined;
      const previousLow = Math.min(...previousLows.map(bar => bar.low));
      if (Math.abs(sessionLow - previousLow) < 0.05) return undefined;
      lowMatches = sessionLow < previousLow;
      checks.push(lowMatches);
    }
    const verdict = checks.every(Boolean) ? "supported" : "contradicted";
    const sentence = lowMatches === false ? "The prior 52-week low was lower."
      : undefined === dropPercent ? "The quote set a new 52-week low."
        : `The quote shows a ${Math.round(dropPercent)}% fall from the debut open.`;
    return {verdict, sentence, source: `https://finance.yahoo.com/quote/${claim.ticker}/history/`};
  } catch {
    dependencies.logger.log("debug", "Twitter/X stock quote check skipped.");
    return undefined;
  }
}

function hasSufficientLowHistory(chart: Chart, postedMs: number, lastDate: string): boolean {
  const firstTradeDate = chart.meta["firstTradeDate"];
  if (typeof firstTradeDate !== "number" || !Number.isFinite(firstTradeDate)) return false;
  const listed = moment.unix(firstTradeDate).tz(timezone).startOf("day");
  const yearStart = moment(postedMs).tz(timezone).subtract(365, "days").startOf("day");
  const start = listed.isAfter(yearStart) ? listed : yearStart;
  if (listed.isAfter(yearStart) && chart.bars[0]?.date !== listed.format("YYYY-MM-DD")) return false;
  const end = moment.tz(lastDate, "YYYY-MM-DD", timezone);
  let expectedWeekdays = 0;
  for (const date = start.clone(); date.isSameOrBefore(end, "day"); date.add(1, "day")) {
    if (date.day() !== 0 && date.day() !== 6) expectedWeekdays++;
  }
  const available = chart.bars.filter(bar => bar.date >= start.format("YYYY-MM-DD") && bar.date <= lastDate).length;
  return expectedWeekdays > 0 && available >= expectedWeekdays * 0.95;
}

async function loadChart(
  ticker: string, startMs: number, endMs: number, interval: "1d" | "1m", dependencies: PriceCheckDependencies,
): Promise<Chart | undefined> {
  const url = `${chartBase}/${ticker}?period1=${Math.floor(startMs / 1000)}`
    + `&period2=${Math.ceil(endMs / 1000)}&interval=${interval}&includePrePost=false&events=splits`;
  const response = await (dependencies.getWithRetryFn ?? getWithRetry)(url, {
    httpsAgent: safeHttpsAgent, headers: yahooHeaders, maxContentLength: 750_000, maxRedirects: 0,
  }, {maxAttempts: 1, timeoutMs: 6_000});
  const body: unknown = response.data;
  if (!isRecord(body) || !isRecord(body["chart"])) return undefined;
  const result = body["chart"]["result"];
  if (!Array.isArray(result) || result.length !== 1 || !isRecord(result[0]) || !isRecord(result[0]["meta"])) return undefined;
  const chart = result[0];
  const meta = chart["meta"];
  if (!isRecord(meta)) return undefined;
  const timestamps: unknown = chart["timestamp"];
  const indicators = chart["indicators"];
  if (!Array.isArray(timestamps) || !isRecord(indicators) || !Array.isArray(indicators["quote"])
    || !isRecord(indicators["quote"][0]) || timestamps.length > 5_000) return undefined;
  const quote = indicators["quote"][0];
  const bars: PriceBar[] = [];
  for (let index = 0; index < timestamps.length; index++) {
    const time: unknown = timestamps[index];
    const open: unknown = Array.isArray(quote["open"]) ? quote["open"][index] : undefined;
    const high: unknown = Array.isArray(quote["high"]) ? quote["high"][index] : undefined;
    const low: unknown = Array.isArray(quote["low"]) ? quote["low"][index] : undefined;
    const close: unknown = Array.isArray(quote["close"]) ? quote["close"][index] : undefined;
    if (!positiveNumber(time) || !positiveNumber(open) || !positiveNumber(high)
      || !positiveNumber(low) || !positiveNumber(close)
      || high < low || high < Math.max(open, close) - 0.02 || low > Math.min(open, close) + 0.02) continue;
    bars.push({timeMs: time * 1000, date: moment.unix(time).tz(timezone).format("YYYY-MM-DD"), open, high, low, close});
  }
  if (bars.length === 0 || bars.some((bar, index) => index > 0 && bar.timeMs <= bars[index - 1]!.timeMs)) return undefined;
  return {meta, bars, splits: isRecord(chart["events"]) ? chart["events"]["splits"] : undefined};
}

function hasSplits(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
