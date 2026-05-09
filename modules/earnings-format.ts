import moment from "moment-timezone";
import {type Ticker} from "./tickers.ts";
import {
  bluechipMinMarketCap,
  EARNINGS_CONTINUATION_LABEL,
  EARNINGS_MAX_MESSAGE_LENGTH,
  earningsTruncationNote,
  earningsWhenSortRankByWhen,
  type EarningsEvent,
  type EarningsMessageBatch,
  type EarningsMessageOptions,
  type EarningsWhen,
} from "./earnings-types.ts";
import {
  appendToEarningsChunk,
  canAppendToEarningsChunk,
  cloneEarningsChunk,
  getEarningsChunkText,
  getEarningsMessageChunkSection,
  getEmptyEarningsMessageChunk,
  getTruncatedEarningsSectionRow,
  type EarningsMessageChunk,
  type EarningsSectionRow,
} from "./earnings-format-render.ts";

type EarningsSection = {
  label: string;
  rows: EarningsSectionRow[];
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
  const mostAnticipatedTickerSymbols = options.mostAnticipatedTickerSymbols ?? new Set<string>();

  const filteredAndSortedEvents = [...earningsEvents]
    .filter(event => selectedWhen.has(event.when))
    .filter(event => true === mostAnticipatedTickerSymbols.has(event.ticker)
      || isIncludedByMarketCapFilter(event, selectedMarketCapFilter))
    .sort(compareEarningsEventsForDisplay);

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
    mostAnticipatedTickerSymbols,
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
    mostAnticipatedTickerSymbols,
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
    mostAnticipatedTickerSymbols,
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
  mostAnticipatedTickerSymbols: ReadonlySet<string>,
  options: {
    maxMessageLength: number;
    maxMessages: number;
    continuationLabel: string;
  }
): EarningsMessageBatch {
  const {maxMessageLength, maxMessages, continuationLabel} = options;
  const sections = getEarningsSections(
    filteredAndSortedEvents
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
  let currentChunk = getEmptyEarningsMessageChunk(0);
  let contentTruncated = false;

  for (const section of sections) {
    const fullSection = getEarningsMessageChunkSection(
      section.label,
      section.rows,
      false
    );
    if (true === canAppendToEarningsChunk(currentChunk, fullSection, highlightedTickerSymbols, mostAnticipatedTickerSymbols, maxMessageLength, title, continuationLabel)) {
      appendToEarningsChunk(currentChunk, fullSection);
      continue;
    }

    if (0 < currentChunk.eventCount) {
      chunks.push(cloneEarningsChunk(currentChunk));
      currentChunk = getEmptyEarningsMessageChunk(chunks.length);
    }

    if (true === canAppendToEarningsChunk(currentChunk, fullSection, highlightedTickerSymbols, mostAnticipatedTickerSymbols, maxMessageLength, title, continuationLabel)) {
      appendToEarningsChunk(currentChunk, fullSection);
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
        const candidateSection = getEarningsMessageChunkSection(
          section.label,
          candidateRows,
          continuation
        );

        if (canAppendToEarningsChunk(currentChunk, candidateSection, highlightedTickerSymbols, mostAnticipatedTickerSymbols, maxMessageLength, title, continuationLabel)) {
          sectionRows.push(nextRow);
          rowIndex++;
        } else {
          break;
        }
      }

      if (0 === sectionRows.length) {
        if (0 < currentChunk.eventCount) {
          chunks.push(cloneEarningsChunk(currentChunk));
          currentChunk = getEmptyEarningsMessageChunk(chunks.length);
          continue;
        }

        const rawRow = section.rows[rowIndex];
        if (undefined === rawRow) {
          break;
        }

        const truncatedRow = getTruncatedEarningsSectionRow(
          rawRow,
          section.label,
          continuation,
          currentChunk,
          highlightedTickerSymbols,
          mostAnticipatedTickerSymbols,
          maxMessageLength,
          title,
          continuationLabel
        );
        sectionRows.push(truncatedRow);
        rowIndex++;
        if (undefined !== truncatedRow.lineOverride) {
          contentTruncated = true;
        }
      }

      const sectionChunk = getEarningsMessageChunkSection(
        section.label,
        sectionRows,
        continuation
      );
      appendToEarningsChunk(currentChunk, sectionChunk);

      if (rowIndex < section.rows.length) {
        chunks.push(cloneEarningsChunk(currentChunk));
        currentChunk = getEmptyEarningsMessageChunk(chunks.length);
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

  const messages = visibleChunks.map(chunk => getEarningsChunkText(
    chunk,
    title,
    highlightedTickerSymbols,
    mostAnticipatedTickerSymbols,
    continuationLabel
  ).trimEnd());
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
  mostAnticipatedTickerSymbols: ReadonlySet<string>,
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
    ).sort(compareEarningsEventsForDisplay);
    const candidateBatch = buildEarningsMessageBatch(
      selectedEvents,
      highlightedTickerSymbols,
      mostAnticipatedTickerSymbols,
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

function getEarningsSections(earningsEvents: EarningsEvent[]): EarningsSection[] {
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

    const currentSection = orderedSections[orderedSections.length - 1];
    if (undefined === currentSection) {
      continue;
    }

    currentSection.rows.push({
      event: earningsEvent,
      when: earningsEvent.when,
    });
  }

  return orderedSections;
}

function getFriendlyDate(dateStamp: string): string {
  return moment(dateStamp).locale("de").format("dddd, Do MMMM YYYY");
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

export function compareEarningsEventsForDisplay(first: EarningsEvent, second: EarningsEvent): number {
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
