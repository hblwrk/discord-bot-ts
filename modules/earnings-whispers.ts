import moment from "moment-timezone";
import {type getWithRetry} from "./http-retry.ts";
import {getLogger} from "./logging.ts";
import {dateStampFormat, usEasternTimezone} from "./earnings-types.ts";

type Logger = {
  log: (level: string, message: unknown) => void;
};

export type EarningsWhispersWeeklyTickerOptions = {
  getWithRetryFn: typeof getWithRetry;
  logger?: Logger | undefined;
  now: moment.Moment;
};

type EarningsWhispersWeeklyTickerCacheEntry = {
  loadedAtMs: number;
  tickers: Set<string>;
  weekStartDateStamp: string;
};

const logger = getLogger();
const earningsWhispersXProfileUrl = "https://x.com/eWhispers";
const jinaReaderUrlPrefix = "https://r.jina.ai/http://";
const earningsWhispersCacheTtlMs = 6 * 60 * 60_000;
const earningsWhispersXRequestHeaders = {
  "User-Agent": "Mozilla/5.0",
  "Accept": "text/markdown,text/plain,text/html;q=0.9,*/*;q=0.8",
};
const weeklyEarningsPattern = /#earnings\s+for\s+the\s+week\s+of\s+([A-Z][a-z]+\.?\s+\d{1,2},\s+20\d{2})([\s\S]*?)(?=\s+(?:Earnings\s+Whispers\s+@eWhispers|#earnings\s+for\s+the\s+week\s+of|The\s+most\s+anticipated\s+earnings\s+releases\s+for\s+the\s+week\s+of|Earnings\s+volatility\s+for\s+the\s+week\s+of)|$)/gi;
const cashtagPattern = /\$([A-Z][A-Z0-9]{0,5}(?:[./-][A-Z])?)(?![A-Z0-9])/g;
let earningsWhispersWeeklyTickerCache: EarningsWhispersWeeklyTickerCacheEntry | undefined;

export function clearEarningsWhispersWeeklyTickerCache() {
  earningsWhispersWeeklyTickerCache = undefined;
}

export async function loadEarningsWhispersWeeklyTickers({
  getWithRetryFn,
  logger: loggerInstance = logger,
  now,
}: EarningsWhispersWeeklyTickerOptions): Promise<Set<string>> {
  const weekStart = getUsEasternWeekStart(now);
  const weekStartDateStamp = weekStart.format(dateStampFormat);
  const loadedAtMs = Date.now();
  if (earningsWhispersWeeklyTickerCache &&
      earningsWhispersWeeklyTickerCache.weekStartDateStamp === weekStartDateStamp &&
      loadedAtMs - earningsWhispersWeeklyTickerCache.loadedAtMs < earningsWhispersCacheTtlMs) {
    return new Set(earningsWhispersWeeklyTickerCache.tickers);
  }

  try {
    const tickers = await loadUncachedEarningsWhispersWeeklyTickers(getWithRetryFn, weekStart);
    earningsWhispersWeeklyTickerCache = {
      loadedAtMs,
      tickers,
      weekStartDateStamp,
    };
    loggerInstance.log(
      "debug",
      {
        source: "earnings-whispers",
        tickerCount: tickers.size,
        weekStartDate: weekStartDateStamp,
        message: `Loaded ${tickers.size} Earnings Whispers weekly tickers for ${weekStartDateStamp}.`,
      },
    );
    return new Set(tickers);
  } catch (error: unknown) {
    loggerInstance.log(
      "debug",
      {
        source: "earnings-whispers",
        weekStartDate: weekStartDateStamp,
        message: `Could not load Earnings Whispers weekly tickers: ${error}`,
      },
    );
    return new Set();
  }
}

async function loadUncachedEarningsWhispersWeeklyTickers(
  getWithRetryFn: typeof getWithRetry,
  weekStart: moment.Moment,
): Promise<Set<string>> {
  const xProfileSourceText = await loadEarningsWhispersXSourceText(
    getWithRetryFn,
    earningsWhispersXProfileUrl,
  );
  const statusUrls = extractEarningsWhispersWeeklyStatusUrls(xProfileSourceText, weekStart);
  const statusTickers = await loadEarningsWhispersStatusTickers(getWithRetryFn, statusUrls, weekStart);
  if (0 < statusTickers.size) {
    return statusTickers;
  }

  return extractEarningsWhispersWeeklyTickers(xProfileSourceText, weekStart);
}

async function loadEarningsWhispersStatusTickers(
  getWithRetryFn: typeof getWithRetry,
  statusUrls: string[],
  weekStart: moment.Moment,
): Promise<Set<string>> {
  const tickers = new Set<string>();
  for (const statusUrl of statusUrls) {
    const statusSourceText = await loadEarningsWhispersXSourceText(getWithRetryFn, statusUrl);
    for (const ticker of extractEarningsWhispersWeeklyTickers(statusSourceText, weekStart)) {
      tickers.add(ticker);
    }
  }

  return tickers;
}

async function loadEarningsWhispersXSourceText(
  getWithRetryFn: typeof getWithRetry,
  url: string,
): Promise<string> {
  const response = await getWithRetryFn<string>(
    getJinaReaderUrl(url),
    {
      headers: earningsWhispersXRequestHeaders,
    },
    {
      maxAttempts: 2,
      timeoutMs: 10_000,
    },
  );
  return "string" === typeof response.data
    ? response.data
    : JSON.stringify(response.data);
}

export function extractEarningsWhispersWeeklyStatusUrls(
  sourceText: string,
  weekStart: moment.Moment = moment.tz(usEasternTimezone),
): string[] {
  const expectedWeekStartDateStamp = getUsEasternWeekStart(weekStart).format(dateStampFormat);
  const normalizedSourceText = normalizeEarningsWhispersSourceText(sourceText);
  const statusUrlById = new Map<string, string>();
  for (const statusMatch of normalizedSourceText.matchAll(/https:\/\/x\.com\/eWhispers\/status\/(\d+)/g)) {
    const statusId = statusMatch[1];
    if (undefined !== statusId) {
      statusUrlById.set(statusId, `https://x.com/eWhispers/status/${statusId}`);
    }
  }

  const statusUrls: string[] = [];
  for (const weeklyMatch of normalizedSourceText.matchAll(weeklyEarningsPattern)) {
    const weekLabel = weeklyMatch[1];
    if (undefined === weekLabel) {
      continue;
    }

    const parsedWeekStart = moment.tz(weekLabel.replace(".", ""), "MMMM D, YYYY", true, usEasternTimezone);
    if (false === parsedWeekStart.isValid() ||
        parsedWeekStart.format(dateStampFormat) !== expectedWeekStartDateStamp) {
      continue;
    }

    const sourcePrefix = normalizedSourceText.slice(0, weeklyMatch.index);
    const statusIdMatch = [...sourcePrefix.matchAll(/https:\/\/x\.com\/eWhispers\/status\/(\d+)/g)].at(-1);
    const statusId = statusIdMatch?.[1];
    const statusUrl = undefined === statusId ? undefined : statusUrlById.get(statusId);
    if (undefined !== statusUrl && false === statusUrls.includes(statusUrl)) {
      statusUrls.push(statusUrl);
    }
  }

  return statusUrls;
}

export function extractEarningsWhispersWeeklyTickers(
  sourceText: string,
  weekStart: moment.Moment = moment.tz(usEasternTimezone),
): Set<string> {
  const normalizedSourceText = normalizeEarningsWhispersSourceText(sourceText);
  const expectedWeekStartDateStamp = getUsEasternWeekStart(weekStart).format(dateStampFormat);
  const tickers = new Set<string>();

  for (const weeklyMatch of normalizedSourceText.matchAll(weeklyEarningsPattern)) {
    const weekLabel = weeklyMatch[1];
    const tickerText = weeklyMatch[2];
    if (undefined === weekLabel || undefined === tickerText) {
      continue;
    }

    const parsedWeekStart = moment.tz(weekLabel.replace(".", ""), "MMMM D, YYYY", true, usEasternTimezone);
    if (false === parsedWeekStart.isValid() ||
        parsedWeekStart.format(dateStampFormat) !== expectedWeekStartDateStamp) {
      continue;
    }

    for (const tickerMatch of tickerText.matchAll(cashtagPattern)) {
      const ticker = tickerMatch[1];
      if (undefined !== ticker) {
        tickers.add(normalizeEarningsWhispersTicker(ticker));
      }
    }
  }

  return tickers;
}

function getUsEasternWeekStart(date: moment.Moment): moment.Moment {
  return date.clone().tz(usEasternTimezone).startOf("isoWeek").startOf("day");
}

function getJinaReaderUrl(url: string): string {
  return `${jinaReaderUrlPrefix}${url}`;
}

function normalizeEarningsWhispersSourceText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\\u0023/gi, "#")
    .replace(/\\u0024/gi, "$")
    .replace(/\\n/g, " ")
    .replace(/\[([#$][^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<\/?script[^>]*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function normalizeEarningsWhispersTicker(value: string): string {
  return value.trim().toUpperCase().replaceAll("/", ".").replaceAll("-", ".");
}
