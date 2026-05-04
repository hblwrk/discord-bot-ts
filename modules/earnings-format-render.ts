import {
  earningsWhenLabelByWhen,
  type EarningsEvent,
  type EarningsWhen,
  unknownValueLabel,
} from "./earnings-types.ts";
import {
  formatMarketCapUsdShort,
  getNormalizedString,
  getNumericValueFromNasdaqCapString,
} from "./earnings-utils.ts";
import {getFormattedExpectedMoveText, getFormattedExpectedMoveUnderlyingPriceText} from "./earnings-option-format.ts";

export type EarningsSectionRow = {
  event: EarningsEvent;
  lineOverride?: string;
  when: EarningsWhen;
};

type EarningsLineWidths = {
  ticker: number;
  marketCap: number;
};

export type EarningsMessageChunk = {
  eventCount: number;
  messageIndex: number;
  sections: EarningsMessageChunkSection[];
};

export type EarningsMessageChunkSection = {
  continuation: boolean;
  label: string;
  rows: EarningsSectionRow[];
};

function getEarningsLineWidths(rows: EarningsSectionRow[]): EarningsLineWidths {
  let tickerWidth = 1;
  let marketCapWidth = unknownValueLabel.length;

  for (const row of rows) {
    if (undefined !== row.lineOverride) {
      continue;
    }

    const {event: earningsEvent} = row;
    tickerWidth = Math.max(tickerWidth, earningsEvent.ticker.length);

    const marketCapText = getFormattedMarketCapText(
      earningsEvent.marketCap,
      earningsEvent.marketCapText
    );
    marketCapWidth = Math.max(marketCapWidth, marketCapText.length);
  }

  return {
    ticker: tickerWidth,
    marketCap: marketCapWidth,
  };
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
  continuationLabel: string,
  highlightedTickerSymbols: Set<string>,
  lineWidths: EarningsLineWidths
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

    sectionLines.push(row.lineOverride ?? getEarningsEventLine(
      row.event,
      highlightedTickerSymbols,
      lineWidths
    ));
  }

  return `${heading}\n${sectionLines.join("\n")}\n\n`;
}

export function getEmptyEarningsMessageChunk(messageIndex: number): EarningsMessageChunk {
  return {
    eventCount: 0,
    messageIndex,
    sections: [],
  };
}

export function getEarningsMessageChunkSection(
  label: string,
  rows: EarningsSectionRow[],
  continuation: boolean
): EarningsMessageChunkSection {
  return {
    continuation,
    label,
    rows: [...rows],
  };
}

export function canAppendToEarningsChunk(
  chunk: EarningsMessageChunk,
  section: EarningsMessageChunkSection,
  highlightedTickerSymbols: Set<string>,
  maxMessageLength: number,
  title: string,
  continuationLabel: string
): boolean {
  const candidateChunk = cloneEarningsChunk(chunk);
  appendToEarningsChunk(candidateChunk, section);
  return getEarningsChunkText(
    candidateChunk,
    title,
    highlightedTickerSymbols,
    continuationLabel
  ).length <= maxMessageLength;
}

export function appendToEarningsChunk(
  chunk: EarningsMessageChunk,
  section: EarningsMessageChunkSection
) {
  chunk.sections.push({
    ...section,
    rows: [...section.rows],
  });
  chunk.eventCount += section.rows.length;
}

export function cloneEarningsChunk(chunk: EarningsMessageChunk): EarningsMessageChunk {
  return {
    eventCount: chunk.eventCount,
    messageIndex: chunk.messageIndex,
    sections: chunk.sections.map(section => ({
      ...section,
      rows: [...section.rows],
    })),
  };
}

function getEarningsChunkRows(chunk: EarningsMessageChunk): EarningsSectionRow[] {
  return chunk.sections.flatMap(section => section.rows);
}

export function getEarningsChunkText(
  chunk: EarningsMessageChunk,
  title: string,
  highlightedTickerSymbols: Set<string>,
  continuationLabel: string
): string {
  const prefix = (0 === chunk.messageIndex && 0 < title.length) ? `${title}\n` : "";
  const lineWidths = getEarningsLineWidths(getEarningsChunkRows(chunk));
  const sectionText = chunk.sections.map(section => getEarningsSectionText(
    section.label,
    section.rows,
    section.continuation,
    continuationLabel,
    highlightedTickerSymbols,
    lineWidths
  )).join("");

  return `${prefix}${sectionText}`;
}

export function getTruncatedEarningsSectionRow(
  row: EarningsSectionRow,
  label: string,
  continuation: boolean,
  chunk: EarningsMessageChunk,
  highlightedTickerSymbols: Set<string>,
  maxMessageLength: number,
  title: string,
  continuationLabel: string
): EarningsSectionRow {
  const fullLine = getEarningsEventLine(
    row.event,
    highlightedTickerSymbols,
    getEarningsLineWidths([row])
  );
  let bestLine = "";
  let low = 0;
  let high = fullLine.length;

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidateLine = truncateEarningsLine(fullLine, midpoint);
    const candidateRow = {
      ...row,
      lineOverride: candidateLine,
    };
    const candidateSection = getEarningsMessageChunkSection(
      label,
      [candidateRow],
      continuation
    );

    if (true === canAppendToEarningsChunk(chunk, candidateSection, highlightedTickerSymbols, maxMessageLength, title, continuationLabel)) {
      bestLine = candidateLine;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return {
    ...row,
    lineOverride: bestLine,
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
  const marketCapText = getFormattedMarketCapText(earningsEvent.marketCap, earningsEvent.marketCapText);
  const epsConsensus = getFormattedEpsConsensusText(earningsEvent.epsConsensus);
  const marketCapPadding = getEarningsColumnPadding(
    marketCapText,
    lineWidths.marketCap
  );
  const expectedMoveText = getFormattedExpectedMoveText(earningsEvent);
  const underlyingPriceText = getFormattedExpectedMoveUnderlyingPriceText(earningsEvent);

  return `${ticker} 💰 MCap: \`${marketCapText}\`${marketCapPadding}${underlyingPriceText} 🔮 EPS: \`${epsConsensus}\`${expectedMoveText}`;
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

function getEarningsColumnPadding(
  text: string,
  width: number
): string {
  return " ".repeat(Math.max(0, width - text.length));
}

function getFormattedTicker(
  ticker: string,
  highlightedTickerSymbols: Set<string>,
  width: number
): string {
  const tickerPadding = getEarningsColumnPadding(ticker, width);
  if (true === highlightedTickerSymbols.has(ticker)) {
    return `**${ticker}**${tickerPadding}`;
  }

  return `\`${ticker}\`${tickerPadding}`;
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
