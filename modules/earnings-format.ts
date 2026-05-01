/* eslint-disable max-depth */
/* eslint-disable complexity */
/* eslint-disable unicorn/prefer-ternary */
/* eslint-disable @typescript-eslint/no-unnecessary-boolean-literal-compare */
/* eslint-disable yoda */
/* eslint-disable import/extensions */
import moment from "moment-timezone";
import {type Ticker} from "./tickers.ts";
import {
  bluechipMinMarketCap,
  EARNINGS_CONTINUATION_LABEL,
  EARNINGS_MAX_MESSAGE_LENGTH,
  earningsTruncationNote,
  earningsWhenLabelByWhen,
  earningsWhenSortRankByWhen,
  type EarningsEvent,
  type EarningsMessageBatch,
  type EarningsMessageOptions,
  type EarningsWhen,
  unknownValueLabel,
} from "./earnings-types.ts";
import {
  formatMarketCapUsdShort,
  getNormalizedString,
  getNumericValueFromNasdaqCapString,
} from "./earnings-utils.ts";

type EarningsSectionRow = {
  when: EarningsWhen;
  line: string;
};

type EarningsSection = {
  label: string;
  rows: EarningsSectionRow[];
};

type EarningsLineWidths = {
  ticker: number;
  marketCap: number;
  eps: number;
};

type EarningsMessageChunk = {
  content: string;
  eventCount: number;
};

type EventsByDateBucket = {
  dateStamp: string;
  eventsByMarketCap: EarningsEvent[];
};

type EarningsMarketCapFilter = "all" | "bluechips";

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

  return earningsBatch.messages[0] ?? "none";
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
  const selectedMarketCapFilter = getSelectedEarningsMarketCapFilter(options.marketCapFilter);
  const highlightedTickerSymbols = new Set(
    tickers.map(ticker => ticker.symbol)
  );

  const filteredAndSortedEvents = [...earningsEvents]
    .filter(event => selectedWhen.has(event.when))
    .filter(event => isIncludedByMarketCapFilter(event, selectedMarketCapFilter))
    .sort(compareEarningsEvents);

  const totalEvents = filteredAndSortedEvents.length;
  if (0 === filteredAndSortedEvents.length) {
    return {
      messages: [],
      truncated: false,
      totalEvents,
      includedEvents: 0,
    };
  }

  const initialBatch = buildEarningsMessageBatch(
    filteredAndSortedEvents,
    highlightedTickerSymbols,
    {
      maxMessageLength,
      maxMessages,
      continuationLabel,
    }
  );

  if (initialBatch.includedEvents === totalEvents) {
    return initialBatch;
  }

  const marketCapBalancedEvents = getMarketCapBalancedEventsForMultiDayFit(
    filteredAndSortedEvents,
    highlightedTickerSymbols,
    {
      maxMessageLength,
      maxMessages,
      continuationLabel,
    }
  );
  if (null === marketCapBalancedEvents) {
    return ensureBatchHasTruncationNote(initialBatch, maxMessageLength, totalEvents);
  }

  const balancedBatch = buildEarningsMessageBatch(
    marketCapBalancedEvents,
    highlightedTickerSymbols,
    {
      maxMessageLength,
      maxMessages,
      continuationLabel,
    }
  );
  return ensureBatchHasTruncationNote(balancedBatch, maxMessageLength, totalEvents);
}

function buildEarningsMessageBatch(
  filteredAndSortedEvents: EarningsEvent[],
  highlightedTickerSymbols: Set<string>,
  options: {
    maxMessageLength: number;
    maxMessages: number;
    continuationLabel: string;
  }
): EarningsMessageBatch {
  const {maxMessageLength, maxMessages, continuationLabel} = options;
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
        const nextRow = section.rows[rowIndex];
        if (undefined === nextRow) {
          break;
        }

        const candidateRows = [...sectionRows, nextRow];
        const candidateSectionText = getEarningsSectionText(
          section.label,
          candidateRows,
          continuation,
          continuationLabel
        );

        if (canAppendToEarningsChunk(currentChunk, candidateSectionText, maxMessageLength)) {
          sectionRows.push(nextRow);
          rowIndex++;
        } else {
          break;
        }
      }

      if (0 === sectionRows.length) {
        const rawRow = section.rows[rowIndex];
        if (undefined === rawRow) {
          break;
        }

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
    const lastMessage = messages[messages.length - 1];
    if (undefined !== lastMessage) {
      messages[messages.length - 1] = appendEarningsTruncationNote(
        lastMessage,
        maxMessageLength
      );
    }
  }

  return {
    messages,
    truncated: true === contentTruncated || true === truncatedByMessageCount,
    totalEvents: filteredAndSortedEvents.length,
    includedEvents,
  };
}

function getMarketCapBalancedEventsForMultiDayFit(
  filteredAndSortedEvents: EarningsEvent[],
  highlightedTickerSymbols: Set<string>,
  options: {
    maxMessageLength: number;
    maxMessages: number;
    continuationLabel: string;
  }
): EarningsEvent[] | null {
  const buckets = getEventsByDateBuckets(filteredAndSortedEvents);
  if (buckets.length < 2) {
    return null;
  }

  const largestBucketSize = buckets.reduce(
    (max, bucket) => Math.max(max, bucket.eventsByMarketCap.length),
    0
  );
  for (let perDayCap = largestBucketSize; perDayCap >= 1; perDayCap--) {
    const selectedEvents = getSelectedEventsByPerDayCap(
      buckets,
      perDayCap
    ).sort(compareEarningsEvents);
    const candidateBatch = buildEarningsMessageBatch(
      selectedEvents,
      highlightedTickerSymbols,
      options
    );
    if (candidateBatch.includedEvents === selectedEvents.length) {
      return selectedEvents;
    }
  }

  return null;
}

function getEventsByDateBuckets(
  sortedEvents: EarningsEvent[]
): EventsByDateBucket[] {
  const buckets: EventsByDateBucket[] = [];
  let previousDateStamp = "";

  for (const event of sortedEvents) {
    if (event.date !== previousDateStamp) {
      buckets.push({
        dateStamp: event.date,
        eventsByMarketCap: [],
      });
      previousDateStamp = event.date;
    }

    buckets.at(-1)?.eventsByMarketCap.push(event);
  }

  for (const bucket of buckets) {
    bucket.eventsByMarketCap.sort(compareEventsByMarketCapPriority);
  }

  return buckets;
}

function compareEventsByMarketCapPriority(
  first: EarningsEvent,
  second: EarningsEvent
): number {
  const firstMarketCap = getSortableMarketCap(first.marketCap);
  const secondMarketCap = getSortableMarketCap(second.marketCap);
  if (firstMarketCap !== secondMarketCap) {
    return secondMarketCap - firstMarketCap;
  }

  const firstWhenRank = getEarningsWhenSortRank(first.when);
  const secondWhenRank = getEarningsWhenSortRank(second.when);
  if (firstWhenRank !== secondWhenRank) {
    return firstWhenRank - secondWhenRank;
  }

  if (first.ticker !== second.ticker) {
    return first.ticker.localeCompare(second.ticker);
  }

  return first.importance - second.importance;
}

function getSelectedEventsByPerDayCap(
  buckets: EventsByDateBucket[],
  perDayCap: number
): EarningsEvent[] {
  const selectedEvents: EarningsEvent[] = [];

  for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
    if (perDayCap <= 0) {
      continue;
    }

    const bucket = buckets[bucketIndex];
    if (undefined !== bucket) {
      selectedEvents.push(
        ...bucket.eventsByMarketCap.slice(0, perDayCap)
      );
    }
  }

  return selectedEvents;
}

function ensureBatchHasTruncationNote(
  batch: EarningsMessageBatch,
  maxMessageLength: number,
  totalEvents: number
): EarningsMessageBatch {
  if (batch.messages.length === 0 || batch.includedEvents >= totalEvents) {
    return {
      ...batch,
      totalEvents,
    };
  }

  const updatedMessages = [...batch.messages];
  const lastMessageIndex = updatedMessages.length - 1;
  const lastMessage = updatedMessages[lastMessageIndex];
  if (undefined !== lastMessage && false === lastMessage.includes(earningsTruncationNote)) {
    updatedMessages[lastMessageIndex] = appendEarningsTruncationNote(
      lastMessage,
      maxMessageLength
    );
  }

  return {
    messages: updatedMessages,
    truncated: true,
    totalEvents,
    includedEvents: batch.includedEvents,
  };
}

function getEarningsTitle(earningsEvents: EarningsEvent[]): string {
  const earliestDate = earningsEvents[0]?.date;
  const latestDate = earningsEvents[earningsEvents.length - 1]?.date;
  if (undefined === earliestDate || undefined === latestDate) {
    return "";
  }

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

function getSelectedEarningsMarketCapFilter(
  marketCapFilter: "all" | "bluechips" | string | undefined
): EarningsMarketCapFilter {
  if ("bluechips" === marketCapFilter) {
    return "bluechips";
  }

  return "all";
}

function isIncludedByMarketCapFilter(
  event: EarningsEvent,
  marketCapFilter: EarningsMarketCapFilter
): boolean {
  if ("bluechips" !== marketCapFilter) {
    return true;
  }

  return isBluechipMarketCap(event.marketCap);
}

function isBluechipMarketCap(marketCap: number | null | undefined): boolean {
  if ("number" !== typeof marketCap || false === Number.isFinite(marketCap)) {
    return false;
  }

  return marketCap >= bluechipMinMarketCap;
}

function getEarningsSections(
  earningsEvents: EarningsEvent[],
  highlightedTickerSymbols: Set<string>
): EarningsSection[] {
  const orderedSections: EarningsSection[] = [];
  const lineWidths = getEarningsLineWidths(earningsEvents);
  let previousDateStamp = "";

  for (const earningsEvent of earningsEvents) {
    if (earningsEvent.date !== previousDateStamp) {
      orderedSections.push({
        label: getFriendlyDate(earningsEvent.date),
        rows: [],
      });
      previousDateStamp = earningsEvent.date;
    }

    const currentSection = orderedSections[orderedSections.length - 1];
    if (undefined === currentSection) {
      continue;
    }

    currentSection.rows.push({
      when: earningsEvent.when,
      line: getEarningsEventLine(
        earningsEvent,
        highlightedTickerSymbols,
        lineWidths
      ),
    });
  }

  return orderedSections;
}

function getEarningsLineWidths(
  earningsEvents: EarningsEvent[]
): EarningsLineWidths {
  let tickerWidth = 1;
  let marketCapWidth = unknownValueLabel.length;
  let epsWidth = unknownValueLabel.length;

  for (const earningsEvent of earningsEvents) {
    tickerWidth = Math.max(tickerWidth, earningsEvent.ticker.length);

    const marketCapText = getFormattedMarketCapText(
      earningsEvent.marketCap,
      earningsEvent.marketCapText
    );
    marketCapWidth = Math.max(marketCapWidth, marketCapText.length);

    const epsConsensus = getFormattedEpsConsensusText(earningsEvent.epsConsensus);
    epsWidth = Math.max(epsWidth, epsConsensus.length);
  }

  return {
    ticker: tickerWidth,
    marketCap: marketCapWidth,
    eps: epsWidth,
  };
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
  highlightedTickerSymbols: Set<string>,
  lineWidths: EarningsLineWidths
): string {
  const ticker = getFormattedTicker(
    earningsEvent.ticker,
    highlightedTickerSymbols,
    lineWidths.ticker
  );
  const companyName = getEarningsCompanyName(earningsEvent.companyName);
  const marketCapText = getFormattedMarketCapText(earningsEvent.marketCap, earningsEvent.marketCapText);
  const epsConsensus = getFormattedEpsConsensusText(earningsEvent.epsConsensus);
  const paddedMarketCapText = getPaddedEarningsColumnText(
    marketCapText,
    lineWidths.marketCap
  );
  const paddedEpsConsensus = getPaddedEarningsColumnText(
    epsConsensus,
    lineWidths.eps
  );

  return `${ticker} MCap: \`${paddedMarketCapText}\` 🔮 EPS: \`${paddedEpsConsensus}\` ${companyName}`;
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

function getFormattedEpsConsensusText(
  epsConsensus: string | undefined
): string {
  return getNormalizedString(epsConsensus) ?? unknownValueLabel;
}

function getPaddedEarningsColumnText(
  text: string,
  width: number
): string {
  return text.padEnd(width, " ");
}

function getFormattedTicker(
  ticker: string,
  highlightedTickerSymbols: Set<string>,
  width: number
): string {
  const tickerText = `\`${getPaddedEarningsColumnText(ticker, width)}\``;
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
