/* eslint-disable max-depth */
/* eslint-disable complexity */
/* eslint-disable unicorn/prefer-ternary */
/* eslint-disable @typescript-eslint/no-unnecessary-boolean-literal-compare */
/* eslint-disable yoda */
/* eslint-disable import/extensions */
import moment from "moment-timezone";
import { getLogger } from "./logging.js";
import { type Ticker } from "./tickers.js";
import { getWithRetry } from "./http-retry.js";

const logger = getLogger();
const earningsTruncationNote = "... weitere Earnings konnten wegen Discord-Limits nicht angezeigt werden.";

type EarningsWhen = "before_open" | "after_close" | "during_session";
export interface EarningsEvent {
  ticker: string;
  when: EarningsWhen;
  date: string;
  importance: number;
}

export type EarningsLoadStatus = "ok" | "blocked" | "error";

export const EARNINGS_MAX_MESSAGE_LENGTH = 1800;
export const EARNINGS_MAX_MESSAGES_TIMER = 8;
export const EARNINGS_MAX_MESSAGES_SLASH = 6;
export const EARNINGS_CONTINUATION_LABEL = "(Fortsetzung)";
export const EARNINGS_BLOCKED_MESSAGE = "Stocktwits zeigt aktuell eine \"Just a moment...\"-Seite (Cloudflare). Earnings konnten daher nicht geladen werden.";

export type EarningsMessageBatch = {
  messages: string[];
  truncated: boolean;
  totalEvents: number;
  includedEvents: number;
};

export type EarningsMessageOptions = {
  maxMessageLength?: number;
  maxMessages?: number;
  continuationLabel?: string;
};

type EarningsSection = {
  label: string;
  tickers: string[];
};

type EarningsMessageChunk = {
  content: string;
  eventCount: number;
};

type StocktwitsEarningsStock = {
  importance?: number;
  symbol?: string;
  date?: string;
  time?: string;
};

type StocktwitsEarningsResponse = {
  earnings?: Record<string, {
    stocks?: StocktwitsEarningsStock[];
  }>;
};

type StocktwitsBlockedErrorCode = "stocktwits_blocked";
type StocktwitsLoadResult = {
  data: StocktwitsEarningsResponse;
  watchlistFilterDropped: boolean;
};

export type EarningsLoadResult = {
  events: EarningsEvent[];
  status: EarningsLoadStatus;
  watchlistFilterDropped: boolean;
};

const stocktwitsEarningsEndpoint = "https://api.stocktwits.com/api/2/discover/earnings_calendar";
const stocktwitsRequestHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://stocktwits.com",
  "Referer": "https://stocktwits.com/sentiment/calendar",
  "X-Requested-With": "XMLHttpRequest",
};

export async function getEarnings(
  days: number,
  date: "today" | "tomorrow" | string,
  filter: string
): Promise<EarningsEvent[]> {
  const earningsResult = await getEarningsResult(days, date, filter);
  return earningsResult.events;
}

export async function getEarningsResult(
  days: number,
  date: "today" | "tomorrow" | string,
  filter: string
): Promise<EarningsLoadResult> {
  let dateStamp: string;

  let usEasternTime: moment.Moment = moment.tz("US/Eastern").set({
    // Testing
    /*
    year: 2022,
    month: 1,
    date: 3,
    hour: 9,
    minute: 30,
    second: 0,
    */
  });

  // During the weekend, use next Monday
  if (usEasternTime.day() === 6) {
    usEasternTime = moment(usEasternTime).day(8);
  } else if (usEasternTime.day() === 0) {
    usEasternTime = moment(usEasternTime).day(1);
  }

  if (null === days || 0 === days) {
    if ("today" === date || null === date) {
      dateStamp = usEasternTime.format("YYYY-MM-DD");
    } else if ("tomorrow" === date) {
      dateStamp = usEasternTime.add(1, "days").format("YYYY-MM-DD");
    } else {
      dateStamp = moment(date).tz("US/Eastern").format("YYYY-MM-DD");
    }
  } else {
    if (90 < days) {
      days = 90;
    }

    dateStamp = usEasternTime.add(days, "days").format("YYYY-MM-DD");
  }

  // let nyse open time always start at the same date as the dateStamp to handle tomorrow and other dates
  let nyseOpenTime: moment.Moment = moment.tz(dateStamp, "US/Eastern").set({
    // Testing
    /*
    year: 2022,
    month: 1,
    date: 3,
    */
    hour: 9,
    minute: 30,
    second: 0,
  });

  let nyseCloseTime: moment.Moment = moment.tz(dateStamp, "US/Eastern").set({
    // Testing
    /*
    year: 2022,
    month: 1,
    date: 3,
    */
    hour: 16,
    minute: 0,
    second: 0,
  });

  const earningsEvents: EarningsEvent[] = [];
  let watchlistFilterDropped = false;
  let status: EarningsLoadStatus = "ok";

  try {
    const stocktwitsEarnings = await loadStocktwitsEarnings(dateStamp, filter);
    watchlistFilterDropped = stocktwitsEarnings.watchlistFilterDropped;
    appendStocktwitsEarningsEvents(
      earningsEvents,
      stocktwitsEarnings.data,
      dateStamp,
      nyseOpenTime,
      nyseCloseTime
    );
  } catch (stocktwitsError) {
    if (true === isStocktwitsBlockedError(stocktwitsError)) {
      status = "blocked";
      logger.log(
        "error",
        "Loading earnings failed: Stocktwits request was blocked by a Cloudflare challenge."
      );
    } else {
      status = "error";
      logger.log("error", `Loading earnings failed: ${stocktwitsError}`);
    }
  }

  return {
    events: earningsEvents,
    status,
    watchlistFilterDropped,
  };
}

async function loadStocktwitsEarnings(
  dateStamp: string,
  filter: string
): Promise<StocktwitsLoadResult> {
  const query = new URLSearchParams({
    date_from: dateStamp,
    date_to: dateStamp,
  });
  const hasWatchlistFilter = "all" !== filter;

  if (true === hasWatchlistFilter) {
    query.set("watchlist", filter);
  }

  try {
    // https://api.stocktwits.com/api/2/discover/earnings_calendar?date_from=2023-01-05
    const response = await getWithRetry<StocktwitsEarningsResponse>(
      `${stocktwitsEarningsEndpoint}?${query.toString()}`,
      {
        headers: stocktwitsRequestHeaders,
      }
    );

    if (true === isStocktwitsBlockedResponse(response.data, response.headers)) {
      throw getStocktwitsBlockedError();
    }

    return {
      data: response.data ?? {},
      watchlistFilterDropped: false,
    };
  } catch (error) {
    if (
      false === hasWatchlistFilter ||
      false === (isHttpErrorStatus(error, 403) || isStocktwitsBlockedError(error))
    ) {
      throw error;
    }

    logger.log(
      "warn",
      "Stocktwits watchlist request was blocked (403 or challenge page). Retrying without watchlist filter."
    );
    query.delete("watchlist");
    const fallbackResponse = await getWithRetry<StocktwitsEarningsResponse>(
      `${stocktwitsEarningsEndpoint}?${query.toString()}`,
      {
        headers: stocktwitsRequestHeaders,
      }
    );

    if (true === isStocktwitsBlockedResponse(fallbackResponse.data, fallbackResponse.headers)) {
      throw getStocktwitsBlockedError();
    }

    return {
      data: fallbackResponse.data ?? {},
      watchlistFilterDropped: true,
    };
  }
}

function isHttpErrorStatus(error: unknown, statusCode: number): boolean {
  if ("object" !== typeof error || null === error) {
    return false;
  }

  const maybeError = error as {
    response?: {
      status?: number;
    };
  };

  return maybeError.response?.status === statusCode;
}

function isStocktwitsBlockedResponse(data: unknown, headers: unknown): boolean {
  const contentType = getHeaderValue(headers, "content-type");
  if ("string" === typeof contentType && true === contentType.toLowerCase().includes("text/html")) {
    return true;
  }

  if ("string" !== typeof data) {
    return false;
  }

  const normalizedData = data.toLowerCase();
  return (
    true === normalizedData.includes("just a moment") ||
    true === normalizedData.includes("enable javascript and cookies to continue") ||
    true === normalizedData.includes("__cf_chl_opt")
  );
}

function getHeaderValue(headers: unknown, key: string): string | undefined {
  if (
    "object" === typeof headers &&
    null !== headers &&
    "function" === typeof (headers as { get?: unknown }).get
  ) {
    const value = (headers as {
      get: (name: string) => unknown;
    }).get(key);
    if ("string" === typeof value) {
      return value;
    }
  }

  if ("object" !== typeof headers || null === headers) {
    return undefined;
  }

  const normalizedKey = key.toLowerCase();
  for (const [headerName, headerValue] of Object.entries(headers as Record<string, unknown>)) {
    if (headerName.toLowerCase() !== normalizedKey) {
      continue;
    }

    if ("string" === typeof headerValue) {
      return headerValue;
    }
  }

  return undefined;
}

function getStocktwitsBlockedError(): Error & { code: StocktwitsBlockedErrorCode } {
  const error = new Error(
    "Stocktwits returned a Cloudflare challenge page instead of JSON."
  ) as Error & {
    code: StocktwitsBlockedErrorCode;
  };
  error.code = "stocktwits_blocked";
  return error;
}

function isStocktwitsBlockedError(error: unknown): boolean {
  if ("object" !== typeof error || null === error) {
    return false;
  }

  const maybeError = error as {
    code?: string;
  };
  return maybeError.code === "stocktwits_blocked";
}

function appendStocktwitsEarningsEvents(
  earningsEvents: EarningsEvent[],
  stocktwitsResponse: StocktwitsEarningsResponse,
  dateStamp: string,
  nyseOpenTime: moment.Moment,
  nyseCloseTime: moment.Moment
) {
  const dateEarnings = stocktwitsResponse.earnings?.[dateStamp];
  if (!dateEarnings?.stocks || !Array.isArray(dateEarnings.stocks)) {
    return;
  }

  for (const stock of dateEarnings.stocks) {
    if (
      "string" !== typeof stock.symbol ||
      "string" !== typeof stock.date ||
      "string" !== typeof stock.time ||
      "number" !== typeof stock.importance ||
      stock.importance <= 0 ||
      stock.date !== dateStamp
    ) {
      continue;
    }

    earningsEvents.push({
      ticker: stock.symbol,
      date: stock.date,
      importance: stock.importance,
      when: getEarningsWhenFromClockTime(
        stock.date,
        stock.time,
        nyseOpenTime,
        nyseCloseTime
      ),
    });
  }
}

function getEarningsWhenFromClockTime(
  dateStamp: string,
  timeStamp: string,
  nyseOpenTime: moment.Moment,
  nyseCloseTime: moment.Moment
): EarningsWhen {
  const earningsTime: moment.Moment = moment.tz(
    `${dateStamp} ${timeStamp}`,
    ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm"],
    "US/Eastern"
  );

  let earningsWhen: EarningsWhen = "during_session";
  if (true === moment(earningsTime).isBefore(nyseOpenTime)) {
    earningsWhen = "before_open";
  } else if (true === moment(earningsTime).isSameOrAfter(nyseCloseTime)) {
    earningsWhen = "after_close";
  }

  return earningsWhen;
}

export function getEarningsText(
  earningsEvents: EarningsEvent[],
  when: "all" | "before_open" | "during_session" | "after_close" | string,
  tickers: Ticker[]
): string {
  let earningsText = "none";

  if (0 < earningsEvents.length) {
    let earningsBeforeOpen = "";
    let earningsDuringSession = "";
    let earningsAfterClose = "";

    // Sort by importance, ascending order
    earningsEvents = earningsEvents.sort(
      (first, second) => first.importance - second.importance
    );

    for (const earningEvent of earningsEvents) {
      // Highlight index tickers
      for (const ticker of tickers) {
        if (ticker.symbol === earningEvent.ticker) {
          earningEvent.ticker = `**${earningEvent.ticker}**`;
        }
      }

      switch (earningEvent.when) {
        case "before_open": {
          earningsBeforeOpen += `${earningEvent.ticker}, `;
          break;
        }

        case "during_session": {
          earningsDuringSession += `${earningEvent.ticker}, `;
          break;
        }

        case "after_close": {
          earningsAfterClose += `${earningEvent.ticker}, `;
          break;
        }
        // No default
      }
    }

    moment.locale("de");
    const friendlyDate = moment(earningsEvents[0].date).format(
      "dddd, Do MMMM YYYY"
    );

    earningsText = `Earnings am ${friendlyDate}:\n`;
    if (
      1 < earningsBeforeOpen.length &&
      ("all" === when || "before_open" === when)
    ) {
      earningsText += `**Vor open:**\n${earningsBeforeOpen.slice(0, -2)}\n\n`;
    }

    if (
      1 < earningsDuringSession.length &&
      ("all" === when || "during_session" === when)
    ) {
      earningsText += `**Während der Handelszeiten:**\n${earningsDuringSession.slice(
        0,
        -2
      )}\n\n`;
    }

    if (
      1 < earningsAfterClose.length &&
      ("all" === when || "after_close" === when)
    ) {
      earningsText += `**Nach close:**\n${earningsAfterClose.slice(0, -2)}`;
    }
  }

  return earningsText;
}

export function getEarningsMessages(
  earningsEvents: EarningsEvent[],
  when: "all" | "before_open" | "during_session" | "after_close" | string,
  tickers: Ticker[],
  options: EarningsMessageOptions = {}
): EarningsMessageBatch {
  const maxMessageLength = options.maxMessageLength ?? EARNINGS_MAX_MESSAGE_LENGTH;
  const maxMessages = options.maxMessages ?? Number.POSITIVE_INFINITY;
  const continuationLabel = options.continuationLabel ?? EARNINGS_CONTINUATION_LABEL;
  const selectedWhen = getSelectedEarningsWhen(when);
  const highlightedTickerSymbols = new Set(
    tickers.map(ticker => ticker.symbol)
  );

  const filteredAndSortedEvents = [...earningsEvents]
    .filter(event => selectedWhen.has(event.when))
    .sort((first, second) => first.importance - second.importance);

  if (0 === filteredAndSortedEvents.length) {
    return {
      messages: [],
      truncated: false,
      totalEvents: filteredAndSortedEvents.length,
      includedEvents: 0,
    };
  }

  const sections = getEarningsSections(
    filteredAndSortedEvents,
    highlightedTickerSymbols
  );
  if (0 === sections.length) {
    return {
      messages: [],
      truncated: false,
      totalEvents: filteredAndSortedEvents.length,
      includedEvents: 0,
    };
  }

  moment.locale("de");
  const friendlyDate = moment(filteredAndSortedEvents[0].date).format(
    "dddd, Do MMMM YYYY"
  );
  const title = `Earnings am ${friendlyDate}:`;

  const chunks: EarningsMessageChunk[] = [];
  let currentChunk = getEmptyEarningsMessageChunk(0, title);
  let contentTruncated = false;

  for (const section of sections) {
    const fullSectionText = getEarningsSectionText(
      section.label,
      section.tickers,
      false,
      continuationLabel
    );
    if (true === canAppendToEarningsChunk(currentChunk, fullSectionText, maxMessageLength)) {
      appendToEarningsChunk(currentChunk, fullSectionText, section.tickers.length);
      continue;
    }

    if (0 < currentChunk.eventCount) {
      chunks.push(cloneEarningsChunk(currentChunk));
      currentChunk = getEmptyEarningsMessageChunk(chunks.length, title);
    }

    if (true === canAppendToEarningsChunk(currentChunk, fullSectionText, maxMessageLength)) {
      appendToEarningsChunk(currentChunk, fullSectionText, section.tickers.length);
      continue;
    }

    let tickerIndex = 0;
    let continuation = false;
    while (tickerIndex < section.tickers.length) {
      const sectionTickers: string[] = [];
      while (tickerIndex < section.tickers.length) {
        const candidateTickers = [...sectionTickers, section.tickers[tickerIndex]];
        const candidateSectionText = getEarningsSectionText(
          section.label,
          candidateTickers,
          continuation,
          continuationLabel
        );

        if (canAppendToEarningsChunk(currentChunk, candidateSectionText, maxMessageLength)) {
          sectionTickers.push(section.tickers[tickerIndex]);
          tickerIndex++;
        } else {
          break;
        }
      }

      if (0 === sectionTickers.length) {
        const headingText = `${getEarningsSectionHeading(section.label, continuation, continuationLabel)}\n`;
        const availableTickerLength = maxMessageLength - getAppendedEarningsChunkText(currentChunk, headingText).length - 2;
        if (availableTickerLength <= 0 && 0 < currentChunk.eventCount) {
          chunks.push(cloneEarningsChunk(currentChunk));
          currentChunk = getEmptyEarningsMessageChunk(chunks.length, title);
          continue;
        }

        const rawTicker = section.tickers[tickerIndex];
        const truncatedTicker = truncateEarningsTicker(rawTicker, Math.max(availableTickerLength, 1));
        sectionTickers.push(truncatedTicker);
        tickerIndex++;
        if (rawTicker !== truncatedTicker) {
          contentTruncated = true;
        }
      }

      const sectionText = getEarningsSectionText(
        section.label,
        sectionTickers,
        continuation,
        continuationLabel
      );
      appendToEarningsChunk(currentChunk, sectionText, sectionTickers.length);

      if (tickerIndex < section.tickers.length) {
        chunks.push(cloneEarningsChunk(currentChunk));
        currentChunk = getEmptyEarningsMessageChunk(chunks.length, title);
        continuation = true;
      }
    }
  }

  if (0 < currentChunk.eventCount) {
    chunks.push(cloneEarningsChunk(currentChunk));
  }

  let truncatedByMessageCount = false;
  let visibleChunks = chunks;
  if (visibleChunks.length > maxMessages) {
    truncatedByMessageCount = true;
    visibleChunks = visibleChunks.slice(0, maxMessages);
  }

  const messages = visibleChunks.map(chunk => chunk.content.trimEnd());
  const includedEvents = visibleChunks.reduce(
    (sum, chunk) => sum + chunk.eventCount,
    0
  );

  if (true === truncatedByMessageCount && 0 < messages.length) {
    messages[messages.length - 1] = appendEarningsTruncationNote(
      messages[messages.length - 1],
      maxMessageLength
    );
  }

  return {
    messages,
    truncated: true === contentTruncated || true === truncatedByMessageCount,
    totalEvents: filteredAndSortedEvents.length,
    includedEvents,
  };
}

function getSelectedEarningsWhen(
  when: "all" | "before_open" | "during_session" | "after_close" | string
): Set<EarningsWhen> {
  const allWhen = new Set<EarningsWhen>([
    "before_open",
    "during_session",
    "after_close",
  ]);

  if ("before_open" === when) {
    return new Set<EarningsWhen>(["before_open"]);
  }

  if ("during_session" === when) {
    return new Set<EarningsWhen>(["during_session"]);
  }

  if ("after_close" === when) {
    return new Set<EarningsWhen>(["after_close"]);
  }

  return allWhen;
}

function getEarningsSections(
  earningsEvents: EarningsEvent[],
  highlightedTickerSymbols: Set<string>
): EarningsSection[] {
  const sectionMap = new Map<EarningsWhen, EarningsSection>();
  sectionMap.set("before_open", {label: "Vor open", tickers: []});
  sectionMap.set("during_session", {label: "Während der Handelszeiten", tickers: []});
  sectionMap.set("after_close", {label: "Nach close", tickers: []});

  for (const earningsEvent of earningsEvents) {
    const section = sectionMap.get(earningsEvent.when);
    if (!section) {
      continue;
    }

    if (true === highlightedTickerSymbols.has(earningsEvent.ticker)) {
      section.tickers.push(`**${earningsEvent.ticker}**`);
    } else {
      section.tickers.push(earningsEvent.ticker);
    }
  }

  const orderedSections: EarningsSection[] = [];
  for (const earningsWhen of ["before_open", "during_session", "after_close"] as const) {
    const section = sectionMap.get(earningsWhen);
    if (section && 0 < section.tickers.length) {
      orderedSections.push(section);
    }
  }

  return orderedSections;
}

function getEarningsSectionHeading(
  label: string,
  continuation: boolean,
  continuationLabel: string
): string {
  if (false === continuation) {
    return `**${label}:**`;
  }

  return `**${label} ${continuationLabel}:**`;
}

function getEarningsSectionText(
  label: string,
  tickers: string[],
  continuation: boolean,
  continuationLabel: string
): string {
  const heading = getEarningsSectionHeading(label, continuation, continuationLabel);
  return `${heading}\n${tickers.join(", ")}\n\n`;
}

function getEmptyEarningsMessageChunk(
  messageIndex: number,
  title: string
): EarningsMessageChunk {
  const prefix = 0 === messageIndex ? `${title}\n` : "";
  return {
    content: prefix,
    eventCount: 0,
  };
}

function getAppendedEarningsChunkText(
  chunk: EarningsMessageChunk,
  text: string
): string {
  if ("" === chunk.content) {
    return text;
  }

  if (chunk.content.endsWith("\n")) {
    return `${chunk.content}${text}`;
  }

  return `${chunk.content}\n${text}`;
}

function canAppendToEarningsChunk(
  chunk: EarningsMessageChunk,
  text: string,
  maxMessageLength: number
): boolean {
  return getAppendedEarningsChunkText(chunk, text).length <= maxMessageLength;
}

function appendToEarningsChunk(
  chunk: EarningsMessageChunk,
  text: string,
  eventCount: number
) {
  chunk.content = getAppendedEarningsChunkText(chunk, text);
  chunk.eventCount += eventCount;
}

function cloneEarningsChunk(chunk: EarningsMessageChunk): EarningsMessageChunk {
  return {
    content: chunk.content,
    eventCount: chunk.eventCount,
  };
}

function truncateEarningsTicker(ticker: string, maxLength: number): string {
  if (ticker.length <= maxLength) {
    return ticker;
  }

  if (maxLength <= 3) {
    return ticker.slice(0, maxLength);
  }

  return `${ticker.slice(0, maxLength - 3)}...`;
}

function appendEarningsTruncationNote(
  content: string,
  maxMessageLength: number
): string {
  const suffix = `\n${earningsTruncationNote}`;
  if (content.length + suffix.length <= maxMessageLength) {
    return `${content}${suffix}`;
  }

  const messageLengthWithoutSuffix = maxMessageLength - suffix.length;
  if (messageLengthWithoutSuffix <= 0) {
    return earningsTruncationNote.slice(0, maxMessageLength);
  }

  const trimmedContent = content.slice(0, messageLengthWithoutSuffix).trimEnd();
  return `${trimmedContent}${suffix}`;
}
