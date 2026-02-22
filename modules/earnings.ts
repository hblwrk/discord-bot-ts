/* eslint-disable max-depth */
/* eslint-disable complexity */
/* eslint-disable unicorn/prefer-ternary */
/* eslint-disable @typescript-eslint/no-unnecessary-boolean-literal-compare */
/* eslint-disable yoda */
/* eslint-disable import/extensions */
import moment from "moment-timezone";
import {getLogger} from "./logging.js";
import {type Ticker} from "./tickers.js";
import {getWithRetry} from "./http-retry.js";

type EarningsWhen = "before_open" | "after_close" | "during_session";

const logger = getLogger();
const earningsTruncationNote = "... weitere Earnings konnten wegen Discord-Limits nicht angezeigt werden.";
const usEasternTimezone = "US/Eastern";
const dateStampFormat = "YYYY-MM-DD";
const maxEarningsDays = 10;
const unknownValueLabel = "n/a";
const earningsWhenByNasdaqTimeToken = new Map<string, EarningsWhen>([
  ["time-pre-market", "before_open"],
  ["time-after-hours", "after_close"],
  ["time-not-supplied", "during_session"],
]);
const earningsWhenSortRankByWhen = new Map<EarningsWhen, number>([
  ["before_open", 0],
  ["during_session", 1],
  ["after_close", 2],
]);
const earningsWhenLabelByWhen = new Map<EarningsWhen, string>([
  ["before_open", "Vor Handelsbeginn"],
  ["during_session", "Während der Handelszeiten oder unbekannter Zeitpunkt"],
  ["after_close", "Nach Handelsschluss"],
]);
const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
export interface EarningsEvent {
  ticker: string;
  when: EarningsWhen;
  date: string;
  importance: number;
  companyName?: string;
  marketCap?: number | null;
  marketCapText?: string;
  epsConsensus?: string;
}

export type EarningsLoadStatus = "ok" | "error";

export const EARNINGS_MAX_MESSAGE_LENGTH = 1800;
export const EARNINGS_MAX_MESSAGES_TIMER = 8;
export const EARNINGS_MAX_MESSAGES_SLASH = 6;
export const EARNINGS_CONTINUATION_LABEL = "(Fortsetzung)";

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

type EarningsSectionRow = {
  when: EarningsWhen;
  line: string;
};

type EarningsSection = {
  label: string;
  rows: EarningsSectionRow[];
};

type EarningsMessageChunk = {
  content: string;
  eventCount: number;
};

type NasdaqEarningsRow = {
  symbol?: string;
  name?: string;
  time?: string;
  marketCap?: string | number;
  marketcap?: string | number;
  mktCap?: string | number;
  epsForecast?: string | number;
  epsConsensus?: string | number;
  consensusEPS?: string | number;
  consensusEps?: string | number;
  eps?: string | number;
};

type NasdaqEarningsResponse = {
  data?: {
    rows?: NasdaqEarningsRow[];
  };
  status?: {
    rCode?: number;
    bCodeMessage?: string | null;
    developerMessage?: string | null;
  };
  message?: string | null;
};

export type EarningsLoadResult = {
  events: EarningsEvent[];
  status: EarningsLoadStatus;
};

const nasdaqEarningsEndpoint = "https://api.nasdaq.com/api/calendar/earnings";
const nasdaqRequestHeaders = {
  "User-Agent": "Mozilla/5.0",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://www.nasdaq.com/",
};

export async function getEarnings(
  days: number,
  date: "today" | "tomorrow" | string
): Promise<EarningsEvent[]> {
  const earningsResult = await getEarningsResult(days, date);
  return earningsResult.events;
}

export async function getEarningsResult(
  days: number,
  date: "today" | "tomorrow" | string
): Promise<EarningsLoadResult> {
  const usEasternTime = getCurrentUsEasternTime();
  const isMultiDayRangeRequest = false === (null === days || 0 === days);
  const {dateFromStamp, dateToStamp} = resolveRequestedDateRange(days, date, usEasternTime);

  const earningsEvents: EarningsEvent[] = [];
  let status: EarningsLoadStatus = "ok";

  const dateStamps = getDateStampsInRange(
    dateFromStamp,
    dateToStamp,
    {
      skipWeekends: isMultiDayRangeRequest,
    }
  );
  const settledRequests = await Promise.allSettled(
    dateStamps.map(dateStamp => loadNasdaqEarnings(dateStamp))
  );
  let successfulRequestCount = 0;

  for (const [requestIndex, settledRequest] of settledRequests.entries()) {
    const dateStamp = dateStamps[requestIndex];
    if ("fulfilled" === settledRequest.status) {
      successfulRequestCount++;
      appendNasdaqEarningsEvents(
        earningsEvents,
        settledRequest.value,
        dateStamp
      );
      continue;
    }

    logger.log(
      "error",
      `Loading Nasdaq earnings failed for ${dateStamp}: ${settledRequest.reason}`
    );
  }

  if (0 === successfulRequestCount) {
    status = "error";
    logger.log(
      "error",
      `Loading earnings failed: Nasdaq requests were unsuccessful for ${getDateRangeLabel(dateFromStamp, dateToStamp)}.`
    );
  } else {
    logger.log(
      "info",
      `Loaded ${earningsEvents.length} earnings from Nasdaq for ${getDateRangeLabel(dateFromStamp, dateToStamp)}.`
    );
  }

  return {
    events: earningsEvents,
    status,
  };
}

function getCurrentUsEasternTime(): moment.Moment {
  return moment.tz(usEasternTimezone).set({
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
}

function resolveRequestedDateRange(
  days: number,
  date: "today" | "tomorrow" | string,
  usEasternTime: moment.Moment
): {dateFromStamp: string; dateToStamp: string} {
  if (null === days || 0 === days) {
    if ("today" === date || null === date) {
      const dateStamp = getUsEasternTradingDayOnOrAfter(usEasternTime).format(dateStampFormat);
      return {
        dateFromStamp: dateStamp,
        dateToStamp: dateStamp,
      };
    }

    if ("tomorrow" === date) {
      const dateStamp = addUsEasternTradingDays(usEasternTime, 1).format(dateStampFormat);
      return {
        dateFromStamp: dateStamp,
        dateToStamp: dateStamp,
      };
    }

    const dateStamp = getUsEasternDateStampFromInput(date);
    return {
      dateFromStamp: dateStamp,
      dateToStamp: dateStamp,
    };
  }

  let normalizedDays = Math.trunc(days);
  if (normalizedDays < 1) {
    normalizedDays = 1;
  }
  if (maxEarningsDays < normalizedDays) {
    normalizedDays = maxEarningsDays;
  }

  const dateFromStamp = addUsEasternTradingDays(usEasternTime, 1).format(dateStampFormat);
  const dateToStamp = addUsEasternTradingDays(usEasternTime, normalizedDays).format(dateStampFormat);
  return {
    dateFromStamp,
    dateToStamp,
  };
}

function getUsEasternTradingDayOnOrAfter(date: moment.Moment): moment.Moment {
  const tradingDay = moment(date).tz(usEasternTimezone).startOf("day");
  while (true === isUsEasternWeekend(tradingDay)) {
    tradingDay.add(1, "day");
  }

  return tradingDay;
}

function addUsEasternTradingDays(date: moment.Moment, tradingDays: number): moment.Moment {
  const cursor = moment(date).tz(usEasternTimezone).startOf("day");
  let addedTradingDays = 0;

  while (addedTradingDays < tradingDays) {
    cursor.add(1, "day");
    if (true === isUsEasternWeekend(cursor)) {
      continue;
    }

    addedTradingDays++;
  }

  return cursor;
}

function isUsEasternWeekend(date: moment.Moment): boolean {
  return date.day() === 0 || date.day() === 6;
}

function getUsEasternDateStampFromInput(dateInput: string): string {
  const normalizedDateInput = dateInput.trim();

  const dateOnly = moment.tz(
    normalizedDateInput,
    dateStampFormat,
    true,
    usEasternTimezone
  );
  if (true === dateOnly.isValid()) {
    return dateOnly.format(dateStampFormat);
  }

  const inputContainsExplicitTimezone = /(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/.test(normalizedDateInput);
  if (true === inputContainsExplicitTimezone) {
    const parsedWithOffset = moment.parseZone(normalizedDateInput, moment.ISO_8601, true);
    if (true === parsedWithOffset.isValid()) {
      return parsedWithOffset.tz(usEasternTimezone).format(dateStampFormat);
    }
  }

  const parsedInUsEastern = moment.tz(normalizedDateInput, moment.ISO_8601, true, usEasternTimezone);
  if (true === parsedInUsEastern.isValid()) {
    return parsedInUsEastern.format(dateStampFormat);
  }

  return moment.tz(normalizedDateInput, usEasternTimezone).format(dateStampFormat);
}

async function loadNasdaqEarnings(
  dateStamp: string
): Promise<NasdaqEarningsResponse> {
  const query = new URLSearchParams({
    date: dateStamp,
  });
  const response = await getWithRetry<NasdaqEarningsResponse>(
    `${nasdaqEarningsEndpoint}?${query.toString()}`,
    {
      headers: nasdaqRequestHeaders,
    }
  );

  if (
    "number" === typeof response.data?.status?.rCode &&
    response.data.status.rCode !== 200
  ) {
    throw new Error(
      `Nasdaq response failed with status code ${response.data.status.rCode}.`
    );
  }

  if ("object" !== typeof response.data || null === response.data) {
    throw new Error("Nasdaq returned a non-JSON response.");
  }

  return response.data;
}

function getDateStampsInRange(
  dateFromStamp: string,
  dateToStamp: string,
  options: {
    skipWeekends?: boolean;
  } = {}
): string[] {
  const skipWeekends = options.skipWeekends ?? false;
  const dateStamps: string[] = [];
  const cursor = moment.tz(dateFromStamp, usEasternTimezone).startOf("day");
  const end = moment.tz(dateToStamp, usEasternTimezone).startOf("day");

  while (true === cursor.isSameOrBefore(end, "day")) {
    if (false === skipWeekends || false === isUsEasternWeekend(cursor)) {
      dateStamps.push(cursor.format(dateStampFormat));
    }
    cursor.add(1, "day");
  }

  return dateStamps;
}

function getDateRangeLabel(dateFromStamp: string, dateToStamp: string): string {
  if (dateFromStamp === dateToStamp) {
    return dateFromStamp;
  }

  return `${dateFromStamp} to ${dateToStamp}`;
}

function appendNasdaqEarningsEvents(
  earningsEvents: EarningsEvent[],
  nasdaqResponse: NasdaqEarningsResponse,
  dateStamp: string
) {
  if (!Array.isArray(nasdaqResponse.data?.rows)) {
    return;
  }

  for (const row of nasdaqResponse.data.rows) {
    const ticker = getNormalizedString(row.symbol);
    if (null === ticker) {
      continue;
    }

    const companyName = getNormalizedString(row.name) ?? "";
    const marketCap = getNasdaqMarketCap(row);
    const epsConsensus = getNasdaqEpsConsensus(row);

    earningsEvents.push({
      ticker,
      date: dateStamp,
      importance: 1,
      when: getEarningsWhenFromNasdaqTimeToken(row.time),
      companyName,
      marketCap: marketCap.value,
      marketCapText: marketCap.text,
      epsConsensus,
    });
  }
}

function getEarningsWhenFromNasdaqTimeToken(timeToken: unknown): EarningsWhen {
  if ("string" !== typeof timeToken) {
    return "during_session";
  }

  const normalizedTimeToken = timeToken.trim().toLowerCase();
  return earningsWhenByNasdaqTimeToken.get(normalizedTimeToken) ?? "during_session";
}

function getNormalizedString(value: unknown): string | null {
  if ("string" !== typeof value) {
    return null;
  }

  const normalizedValue = value.trim();
  if (0 === normalizedValue.length) {
    return null;
  }

  return normalizedValue;
}

function getNasdaqMarketCap(row: NasdaqEarningsRow): {value: number | null; text: string} {
  const rawValue = row.marketCap ?? row.marketcap ?? row.mktCap;
  if ("number" === typeof rawValue && Number.isFinite(rawValue) && rawValue >= 0) {
    return {
      value: rawValue,
      text: formatMarketCapUsdShort(rawValue),
    };
  }

  const normalizedRawValue = getNormalizedString(rawValue);
  if (null === normalizedRawValue) {
    return {
      value: null,
      text: unknownValueLabel,
    };
  }

  const marketCapSortValue = getNumericValueFromNasdaqCapString(normalizedRawValue);
  if (null === marketCapSortValue) {
    return {
      value: null,
      text: unknownValueLabel,
    };
  }

  return {
    value: marketCapSortValue,
    text: formatMarketCapUsdShort(marketCapSortValue),
  };
}

function getNumericValueFromNasdaqCapString(value: string): number | null {
  const normalizedValue = value
    .replaceAll(",", "")
    .replaceAll("$", "")
    .trim()
    .toUpperCase();

  const unitMatch = normalizedValue.match(/^([0-9]*\.?[0-9]+)\s*([TMBK])$/);
  if (null !== unitMatch) {
    const parsedValue = Number.parseFloat(unitMatch[1]);
    if (false === Number.isFinite(parsedValue)) {
      return null;
    }

    if ("T" === unitMatch[2]) {
      return parsedValue * 1_000_000_000_000;
    }

    if ("B" === unitMatch[2]) {
      return parsedValue * 1_000_000_000;
    }

    if ("M" === unitMatch[2]) {
      return parsedValue * 1_000_000;
    }

    return parsedValue * 1_000;
  }

  const directNumber = Number.parseFloat(normalizedValue);
  if (false === Number.isFinite(directNumber)) {
    return null;
  }

  return directNumber;
}

function getNasdaqEpsConsensus(row: NasdaqEarningsRow): string {
  const valueCandidates = [
    row.epsForecast,
    row.epsConsensus,
    row.consensusEPS,
    row.consensusEps,
    row.eps,
  ];
  for (const valueCandidate of valueCandidates) {
    if ("number" === typeof valueCandidate && Number.isFinite(valueCandidate)) {
      return String(valueCandidate);
    }

    const normalizedString = getNormalizedString(valueCandidate);
    if (null === normalizedString) {
      continue;
    }

    if (unknownValueLabel === normalizedString.toLowerCase() || "--" === normalizedString) {
      continue;
    }

    return normalizedString;
  }

  return unknownValueLabel;
}

export function getEarningsText(
  earningsEvents: EarningsEvent[],
  when: "all" | "before_open" | "during_session" | "after_close" | string,
  tickers: Ticker[]
): string {
  const earningsBatch = getEarningsMessages(earningsEvents, when, tickers, {
    maxMessageLength: Number.MAX_SAFE_INTEGER,
    maxMessages: 1,
  });
  if (0 === earningsBatch.messages.length) {
    return "none";
  }

  return earningsBatch.messages[0];
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
    .sort(compareEarningsEvents);

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

  const title = getEarningsTitle(filteredAndSortedEvents);

  const chunks: EarningsMessageChunk[] = [];
  let currentChunk = getEmptyEarningsMessageChunk(0, title);
  let contentTruncated = false;

  for (const section of sections) {
    const fullSectionText = getEarningsSectionText(
      section.label,
      section.rows,
      false,
      continuationLabel
    );
    if (true === canAppendToEarningsChunk(currentChunk, fullSectionText, maxMessageLength)) {
      appendToEarningsChunk(currentChunk, fullSectionText, section.rows.length);
      continue;
    }

    if (0 < currentChunk.eventCount) {
      chunks.push(cloneEarningsChunk(currentChunk));
      currentChunk = getEmptyEarningsMessageChunk(chunks.length, title);
    }

    if (true === canAppendToEarningsChunk(currentChunk, fullSectionText, maxMessageLength)) {
      appendToEarningsChunk(currentChunk, fullSectionText, section.rows.length);
      continue;
    }

    let rowIndex = 0;
    let continuation = false;
    while (rowIndex < section.rows.length) {
      const sectionRows: EarningsSectionRow[] = [];
      while (rowIndex < section.rows.length) {
        const candidateRows = [...sectionRows, section.rows[rowIndex]];
        const candidateSectionText = getEarningsSectionText(
          section.label,
          candidateRows,
          continuation,
          continuationLabel
        );

        if (canAppendToEarningsChunk(currentChunk, candidateSectionText, maxMessageLength)) {
          sectionRows.push(section.rows[rowIndex]);
          rowIndex++;
        } else {
          break;
        }
      }

      if (0 === sectionRows.length) {
        const rawRow = section.rows[rowIndex];
        const headingText = `${getEarningsSectionHeading(section.label, continuation, continuationLabel)}\n${getEarningsWhenSubheading(rawRow.when)}\n`;
        const availableRowLength = maxMessageLength - getAppendedEarningsChunkText(currentChunk, headingText).length - 1;
        if (availableRowLength <= 0 && 0 < currentChunk.eventCount) {
          chunks.push(cloneEarningsChunk(currentChunk));
          currentChunk = getEmptyEarningsMessageChunk(chunks.length, title);
          continue;
        }

        const truncatedRow = {
          ...rawRow,
          line: truncateEarningsLine(rawRow.line, Math.max(availableRowLength, 1)),
        };
        sectionRows.push(truncatedRow);
        rowIndex++;
        if (rawRow.line !== truncatedRow.line) {
          contentTruncated = true;
        }
      }

      const sectionText = getEarningsSectionText(
        section.label,
        sectionRows,
        continuation,
        continuationLabel
      );
      appendToEarningsChunk(currentChunk, sectionText, sectionRows.length);

      if (rowIndex < section.rows.length) {
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

function getEarningsTitle(earningsEvents: EarningsEvent[]): string {
  const earliestDate = earningsEvents[0].date;
  const latestDate = earningsEvents[earningsEvents.length - 1].date;
  const earliestFriendlyDate = getFriendlyDate(earliestDate);
  if (earliestDate === latestDate) {
    return "";
  }

  const latestFriendlyDate = getFriendlyDate(latestDate);
  return `**Zeitraum:** ${earliestFriendlyDate} bis ${latestFriendlyDate}`;
}

function getSelectedEarningsWhen(
  when: "all" | "before_open" | "during_session" | "after_close" | string
): Set<EarningsWhen> {
  const allWhen = new Set<EarningsWhen>([
    "before_open",
    "during_session",
    "after_close",
  ]);

  if (allWhen.has(when as EarningsWhen)) {
    return new Set<EarningsWhen>([when as EarningsWhen]);
  }

  return allWhen;
}

function getEarningsSections(
  earningsEvents: EarningsEvent[],
  highlightedTickerSymbols: Set<string>
): EarningsSection[] {
  const orderedSections: EarningsSection[] = [];
  let previousDateStamp = "";

  for (const earningsEvent of earningsEvents) {
    if (earningsEvent.date !== previousDateStamp) {
      orderedSections.push({
        label: getFriendlyDate(earningsEvent.date),
        rows: [],
      });
      previousDateStamp = earningsEvent.date;
    }

    orderedSections[orderedSections.length - 1].rows.push({
      when: earningsEvent.when,
      line: getEarningsEventLine(
        earningsEvent,
        highlightedTickerSymbols
      ),
    });
  }

  return orderedSections;
}

function getFriendlyDate(dateStamp: string): string {
  return moment(dateStamp).locale("de").format("dddd, Do MMMM YYYY");
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
  rows: EarningsSectionRow[],
  continuation: boolean,
  continuationLabel: string
): string {
  const heading = getEarningsSectionHeading(label, continuation, continuationLabel);
  const sectionLines: string[] = [];
  let previousWhen: EarningsWhen | null = null;

  for (const row of rows) {
    if (row.when !== previousWhen) {
      sectionLines.push("");
      sectionLines.push(getEarningsWhenSubheading(row.when));
      previousWhen = row.when;
    }

    sectionLines.push(row.line);
  }

  return `${heading}\n${sectionLines.join("\n")}\n\n`;
}

function getEmptyEarningsMessageChunk(
  messageIndex: number,
  title: string
): EarningsMessageChunk {
  const prefix = (0 === messageIndex && 0 < title.length) ? `${title}\n` : "";
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

function truncateEarningsLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) {
    return line;
  }

  if (maxLength <= 3) {
    return line.slice(0, maxLength);
  }

  return `${line.slice(0, maxLength - 3)}...`;
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

function compareEarningsEvents(first: EarningsEvent, second: EarningsEvent): number {
  if (first.date !== second.date) {
    return first.date.localeCompare(second.date);
  }

  const firstWhenRank = getEarningsWhenSortRank(first.when);
  const secondWhenRank = getEarningsWhenSortRank(second.when);
  if (firstWhenRank !== secondWhenRank) {
    return firstWhenRank - secondWhenRank;
  }

  const firstMarketCap = getSortableMarketCap(first.marketCap);
  const secondMarketCap = getSortableMarketCap(second.marketCap);
  if (firstMarketCap !== secondMarketCap) {
    return secondMarketCap - firstMarketCap;
  }

  if (first.ticker !== second.ticker) {
    return first.ticker.localeCompare(second.ticker);
  }

  return first.importance - second.importance;
}

function getSortableMarketCap(marketCap: number | null | undefined): number {
  if ("number" !== typeof marketCap || false === Number.isFinite(marketCap)) {
    return Number.NEGATIVE_INFINITY;
  }

  return marketCap;
}

function getEarningsWhenSortRank(earningsWhen: EarningsWhen): number {
  return earningsWhenSortRankByWhen.get(earningsWhen) ?? Number.MAX_SAFE_INTEGER;
}

function getEarningsEventLine(
  earningsEvent: EarningsEvent,
  highlightedTickerSymbols: Set<string>
): string {
  const ticker = getFormattedTicker(earningsEvent.ticker, highlightedTickerSymbols);
  const companyName = getEarningsCompanyName(earningsEvent.companyName);
  const marketCapText = getFormattedMarketCapText(earningsEvent.marketCap, earningsEvent.marketCapText);
  const epsConsensus = getNormalizedString(earningsEvent.epsConsensus) ?? unknownValueLabel;

  return `${ticker} ${companyName} | MCap: ${marketCapText} | 🔮 EPS: ${epsConsensus}`;
}

function getFormattedMarketCapText(
  marketCap: number | null | undefined,
  marketCapText: string | undefined
): string {
  if ("number" === typeof marketCap && Number.isFinite(marketCap) && marketCap >= 0) {
    return formatMarketCapUsdShort(marketCap);
  }

  const normalizedMarketCapText = getNormalizedString(marketCapText);
  if (null === normalizedMarketCapText) {
    return unknownValueLabel;
  }

  const parsedMarketCap = getNumericValueFromNasdaqCapString(normalizedMarketCapText);
  if (null === parsedMarketCap) {
    return unknownValueLabel;
  }

  return formatMarketCapUsdShort(parsedMarketCap);
}

function formatMarketCapUsdShort(value: number): string {
  return `$${compactUsdFormatter.format(value)}`;
}

function getFormattedTicker(
  ticker: string,
  highlightedTickerSymbols: Set<string>
): string {
  const tickerText = `\`${ticker}\``;
  if (true === highlightedTickerSymbols.has(ticker)) {
    return `**${tickerText}**`;
  }

  return tickerText;
}

function getEarningsCompanyName(companyName: string | undefined): string {
  if ("string" !== typeof companyName) {
    return "Unternehmen unbekannt";
  }

  const normalizedCompanyName = companyName.trim();
  if (0 === normalizedCompanyName.length) {
    return "Unternehmen unbekannt";
  }

  return normalizedCompanyName;
}

function getEarningsWhenLabel(earningsWhen: EarningsWhen): string {
  const label = earningsWhenLabelByWhen.get(earningsWhen);
  if (undefined !== label) {
    return label;
  }

  return "Während der Handelszeiten oder unbekannter Zeitpunkt";
}

function getEarningsWhenSubheading(earningsWhen: EarningsWhen): string {
  return `**${getEarningsWhenLabel(earningsWhen)}:**`;
}
