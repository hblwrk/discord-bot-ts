import type {Buffer} from "node:buffer";
import {callAiProviderJson, type AiProviderDependencies} from "./ai-provider.ts";

export type MncSummaryDependencies = AiProviderDependencies;

const maxInlinePdfBytes = 14_000_000;
const maxDiscordSummaryLength = 1_930;
const maxMncSummaryAttempts = 2;
const minMncSummaryBullets = 5;
// Long enough that a discarded summary's preview reaches the stocks/watchlist
// region, not just the intro bullet, so a structural rejection can be diagnosed.
const mncSummaryDiscardPreviewLength = 700;

// The model is asked for "**Stocks in focus**" / "**Watchlist**" but routinely
// varies the casing, adds a trailing colon, a leading 📰, or a Markdown "#"
// heading marker. Match those benign variants so a usable summary is not
// discarded, while still requiring the section to be a heading on its own line.
const stocksInFocusHeadingPattern = /^\s*(?:#{1,3}\s*)?(?:📰\s*)?(?:\*\*|__)?\s*stocks in focus\s*:?\s*(?:\*\*|__)?\s*$/i;
const watchlistHeadingPattern = /^\s*(?:#{1,3}\s*)?(?:📰\s*)?(?:\*\*|__)?\s*watchlist\s*:?\s*(?:\*\*|__)?\s*$/i;
// The model also welds the section name onto the first bullet of the section as
// a bold lead-in label instead of writing a standalone heading, e.g.
// "- **Stocks in focus:** Apple `AAPL` ...". Promote that lead-in to a real
// heading so the structural gate and section compaction recognise the section.
// A bold (or "#") wrapper is required so prose that merely mentions the phrase
// mid-bullet is not mistaken for a heading. Capture group 1 is the trailing
// content, which becomes the section's first bullet (empty for a bare label).
const stocksInFocusLeadInPattern = /^\s*(?:[-*•–]\s+)?(?:#{1,3}\s+)?(?:📰\s*)?(?:\*\*|__)\s*stocks in focus\s*:?\s*(?:\*\*|__)\s*:?\s*(.*)$/i;
const watchlistLeadInPattern = /^\s*(?:[-*•–]\s+)?(?:#{1,3}\s+)?(?:📰\s*)?(?:\*\*|__)\s*watchlist\s*:?\s*(?:\*\*|__)\s*:?\s*(.*)$/i;
// Accept "-", "*", "•", or "–" bullet markers; "**bold**" lines are not bullets
// because the marker must be followed by whitespace.
const bulletLinePattern = /^[-*•–]\s+\S/;
const bulletLineCanonicalPattern = /^(\s*)[-*•–]\s+(.*)$/;

const mncSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summaryMarkdown: {
      type: "string",
      description: "A concise one-minute Morning News Call summary formatted in Discord-compatible Markdown.",
    },
  },
  required: ["summaryMarkdown"],
} satisfies Record<string, unknown>;

export async function getMncSummary(
  pdfBuffer: Buffer,
  dependencies: MncSummaryDependencies,
): Promise<string | undefined> {
  if (pdfBuffer.length > maxInlinePdfBytes) {
    dependencies.logger.log(
      "warn",
      "Skipping MNC AI summary: PDF is too large for inline provider processing.",
    );
    return undefined;
  }

  for (let attempt = 1; attempt <= maxMncSummaryAttempts; attempt++) {
    const normalizedSummary = await requestNormalizedMncSummary(pdfBuffer, dependencies);
    if (undefined === normalizedSummary) {
      continue;
    }

    const structure = describeMncSummaryStructure(normalizedSummary);
    if (false === isMncSummaryStructureValid(structure)) {
      dependencies.logger.log(
        "warn",
        {
          message: `Discarding malformed AI MNC summary (attempt ${attempt}/${maxMncSummaryAttempts}): missing a required section heading or too few bullets.`,
          has_stocks_heading: structure.hasStocksHeading,
          has_watchlist_heading: structure.hasWatchlistHeading,
          bullet_count: structure.bulletCount,
          min_bullets: minMncSummaryBullets,
          summary_preview: normalizedSummary.slice(0, mncSummaryDiscardPreviewLength),
        },
      );
      continue;
    }

    const finalSummary = finalizeNormalizedSummary(normalizedSummary);
    if ("" !== finalSummary) {
      return finalSummary;
    }
  }

  return undefined;
}

async function requestNormalizedMncSummary(
  pdfBuffer: Buffer,
  dependencies: MncSummaryDependencies,
): Promise<string | undefined> {
  const jsonText = await callAiProviderJson(
    getMncSummaryPrompt(),
    mncSummarySchema,
    dependencies,
    "MNC summary",
    {
      data: pdfBuffer.toString("base64"),
      filename: "morning-news-call.pdf",
      mimeType: "application/pdf",
    },
    {
      timeoutMs: 60_000,
    },
  ).catch(error => {
    dependencies.logger.log(
      "warn",
      `AI MNC summary failed: ${error}`,
    );
    return null;
  });
  if (null === jsonText) {
    return undefined;
  }

  const parsedJson = parseJson(jsonText);
  if (false === isRecord(parsedJson)) {
    dependencies.logger.log(
      "warn",
      "AI MNC summary returned invalid JSON.",
    );
    return undefined;
  }

  const summaryMarkdown = parsedJson["summaryMarkdown"];
  if ("string" !== typeof summaryMarkdown) {
    dependencies.logger.log(
      "warn",
      "AI MNC summary response did not contain summaryMarkdown.",
    );
    return undefined;
  }

  const normalizedSummary = normalizeMarkdownSummary(summaryMarkdown);
  return "" === normalizedSummary ? undefined : normalizedSummary;
}

export function formatMncSummary(summaryMarkdown: string): string {
  return finalizeNormalizedSummary(normalizeMarkdownSummary(summaryMarkdown));
}

function finalizeNormalizedSummary(normalizedSummary: string): string {
  return removeMncTldrHeading(truncateMarkdownSummary(normalizedSummary)).trim();
}

export type MncSummaryStructure = {
  hasStocksHeading: boolean;
  hasWatchlistHeading: boolean;
  bulletCount: number;
};

export function describeMncSummaryStructure(summary: string): MncSummaryStructure {
  const lines = summary.split("\n");
  return {
    hasStocksHeading: lines.some(line => isStocksInFocusHeadingLine(line)),
    hasWatchlistHeading: lines.some(line => isWatchlistHeadingLine(line)),
    bulletCount: getBulletLines(lines).length,
  };
}

// Recognise a section whether it is a standalone heading or a bold lead-in label
// on a bullet, so the structural gate agrees with canonicalizeSummaryStructure
// regardless of whether the summary has been normalized yet.
function isStocksInFocusHeadingLine(line: string): boolean {
  return stocksInFocusHeadingPattern.test(line) || stocksInFocusLeadInPattern.test(line);
}

function isWatchlistHeadingLine(line: string): boolean {
  return watchlistHeadingPattern.test(line) || watchlistLeadInPattern.test(line);
}

function isMncSummaryStructureValid(structure: MncSummaryStructure): boolean {
  return true === structure.hasStocksHeading
    && true === structure.hasWatchlistHeading
    && structure.bulletCount >= minMncSummaryBullets;
}

export function isStructurallyValidMncSummary(summary: string): boolean {
  return isMncSummaryStructureValid(describeMncSummaryStructure(summary));
}

function getMncSummaryPrompt(): string {
  return [
    "Summarize this Refinitiv Morning News Call PDF for a Discord trading channel.",
    "Return only JSON matching the schema. Do not include markdown outside the JSON string.",
    "Write summaryMarkdown as a one-minute read in concise Discord Markdown.",
    "Required shape:",
    "- Exactly 2 bullets with the market setup and most important macro drivers.",
    "",
    "**Stocks in focus**",
    "- Exactly 4 bullets with company/ticker-specific news, earnings, guidance, analyst calls, or deal headlines.",
    "",
    "**Watchlist**",
    "- Exactly 1 bullet for events, data releases, sectors, or risks traders should monitor.",
    "Rules:",
    "- Keep the full summary under 1,750 characters.",
    "- Use exactly 7 bullets total; each bullet should fit one Discord line.",
    "- Prioritize concrete, market-moving information from the PDF.",
    "- Do not include a Morning News Call heading; the Discord message title already provides it.",
    "- Write in English only.",
    "- Format ticker symbols and quantitative metrics as inline code, e.g. `AAPL`, `$2.14`, `3.1%`, `10Y`, `250K`.",
    "- For metric ranges, write the range inside one inline-code token, e.g. `$1.26B-$1.36B`; do not turn range separators or table dashes into negative signs.",
    "- Use a negative sign only when the PDF explicitly reports a negative value, loss, charge, deficit, decline, or outflow.",
    "- In stock-specific bullets, start with Company Name `TICKER` when the PDF explicitly provides a ticker; common short company names are fine, e.g. Apple `AAPL`.",
    "- If the PDF does not explicitly provide a ticker, start with the company name without inventing a ticker.",
    "- Do not infer or invent tickers, prices, percentages, or attributions.",
    "- Do not use code blocks, tables, links, emojis, or disclaimers.",
  ].join("\n");
}

function normalizeMarkdownSummary(value: string): string {
  const summary = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trimEnd())
    .filter(line => false === /^```/.test(line.trim()))
    .join("\n")
    .replace(/\\([$€£¥])/g, "$1")
    .replace(/\${2,}/g, "$")
    .trim();

  return normalizeInlineCodeWhitespace(
    normalizeInlineCodeMetricSigns(
      normalizeInlineCodeRanges(
        normalizeInlineCodeWhitespace(
          canonicalizeSummaryStructure(removeUnexpectedScriptTokens(removeMncTldrHeading(summary))),
        ),
      ),
    ),
  ).trim();
}

// Rewrite tolerated heading and bullet variants to the canonical "**Stocks in
// focus**" / "**Watchlist**" / "- " forms so the posted message, the structural
// gate, and the section compaction all see one consistent shape.
function canonicalizeSummaryStructure(value: string): string {
  return value
    .split("\n")
    .flatMap(canonicalizeSummaryLine)
    .join("\n");
}

function canonicalizeSummaryLine(line: string): string[] {
  if (stocksInFocusHeadingPattern.test(line)) {
    return ["**Stocks in focus**"];
  }

  if (watchlistHeadingPattern.test(line)) {
    return ["**Watchlist**"];
  }

  const stocksLeadIn = line.match(stocksInFocusLeadInPattern);
  if (null !== stocksLeadIn) {
    return buildSectionHeadingLines("**Stocks in focus**", stocksLeadIn[1] ?? "");
  }

  const watchlistLeadIn = line.match(watchlistLeadInPattern);
  if (null !== watchlistLeadIn) {
    return buildSectionHeadingLines("**Watchlist**", watchlistLeadIn[1] ?? "");
  }

  const bulletMatch = line.match(bulletLineCanonicalPattern);
  if (null !== bulletMatch) {
    return [`- ${bulletMatch[2]}`];
  }

  return [line];
}

function buildSectionHeadingLines(heading: string, trailingContent: string): string[] {
  const remainder = trailingContent.trim();
  if ("" === remainder) {
    return [heading];
  }

  return [heading, `- ${remainder}`];
}

function removeMncTldrHeading(value: string): string {
  return value
    .split("\n")
    .filter(line => false === isMncTldrHeading(line))
    .join("\n")
    .trim();
}

function isMncTldrHeading(line: string): boolean {
  return /^\s*(?:📰\s*)?\*\*Morning News Call\s*-\s*TL;?DR\*\*\s*$/i.test(line);
}

function removeUnexpectedScriptTokens(value: string): string {
  return value
    .split("\n")
    .map(line => line
      .replace(/\S*[\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\S*/gu, "")
      .replace(/\s+([,.;:])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trimEnd())
    .join("\n");
}

function normalizeInlineCodeRanges(value: string): string {
  return value.replace(
    /`([^`\n]+)`\s*([-–—])\s*`([^`\n]+)`/g,
    (match, firstValue: string, separator: string, secondValue: string) => {
      const firstToken = firstValue.trim();
      const secondToken = secondValue.trim();
      if (false === isRangeInlineCodeToken(firstToken) || false === isRangeInlineCodeToken(secondToken)) {
        return match;
      }

      return `\`${firstToken}${separator}${secondToken}\``;
    },
  );
}

function isRangeInlineCodeToken(value: string): boolean {
  return /[$€£¥]|\d/.test(value);
}

function normalizeInlineCodeWhitespace(value: string): string {
  return value.replace(
    /`([^`\n]*)`/g,
    (_match, token: string) => `\`${normalizeInlineCodeTokenWhitespace(token)}\``,
  );
}

function normalizeInlineCodeTokenWhitespace(value: string): string {
  const trimmedValue = value.trim();
  if (false === /[$€£¥]|\d/.test(trimmedValue)) {
    return trimmedValue;
  }

  return trimmedValue
    .replace(/([$€£¥])\s+(?=[\d(])/g, "$1")
    .replace(/(\d(?:[\d,.]*))\s+((?:tn|bn|mm|[tbmk])\b)/gi, "$1$2");
}

function normalizeInlineCodeMetricSigns(value: string): string {
  return value
    .split("\n")
    .map(line => normalizeInlineCodeMetricSignsInLine(line))
    .join("\n");
}

function normalizeInlineCodeMetricSignsInLine(line: string): string {
  const withoutSpacedTableDashes = line.replace(
    /`[-−]\s+([$€£¥]\s*\d[^`\n]*)`/g,
    (_match, metricText: string) => `\`${metricText.trim()}\``,
  );

  if (false === isLikelyPositiveGuidanceRangeLine(withoutSpacedTableDashes)) {
    return withoutSpacedTableDashes;
  }

  return withoutSpacedTableDashes.replace(
    /`-([$€£¥]\s*\d[\d,.]*(?:\.\d+)?(?:\s*(?:tn|bn|mm|[tbmk]|trillions?|billions?|millions?|thousands?)\b)?)([-–—])([$€£¥]\s*\d[\d,.]*(?:\.\d+)?(?:\s*(?:tn|bn|mm|[tbmk]|trillions?|billions?|millions?|thousands?)\b)?)`/gi,
    (_match, firstValue: string, separator: string, secondValue: string) =>
      `\`${firstValue.trim()}${separator}${secondValue.trim()}\``,
  );
}

function isLikelyPositiveGuidanceRangeLine(line: string): boolean {
  if (/\b(?:loss|negative|deficit|charge|impairment|outflow|cash\s+burn)\b/i.test(line)) {
    return false;
  }

  return /\b(?:guidance|guided|forecast|outlook|expects?|raised|revenue|sales|eps|earnings\s+per\s+share)\b/i.test(line);
}

function truncateMarkdownSummary(value: string): string {
  if (value.length <= maxDiscordSummaryLength) {
    return value;
  }

  const compactedSummary = getCompactedSectionSummary(value);
  if (undefined !== compactedSummary && compactedSummary.length <= maxDiscordSummaryLength) {
    return compactedSummary;
  }

  const suffix = "\n...";
  const maxBodyLength = maxDiscordSummaryLength - suffix.length;
  const lines: string[] = [];
  for (const line of value.split("\n")) {
    const candidate = [...lines, line].join("\n");
    if (candidate.length > maxBodyLength) {
      break;
    }

    lines.push(line);
  }

  while (0 < lines.length && true === isDanglingSummaryLine(lines[lines.length - 1] ?? "")) {
    lines.pop();
  }

  const summary = lines.join("\n").trimEnd();
  if ("" !== summary) {
    return `${summary}${suffix}`;
  }

  return `${value.slice(0, maxBodyLength).trimEnd()}${suffix}`;
}

function isDanglingSummaryLine(line: string): boolean {
  const normalizedLine = line.trim();
  return "" === normalizedLine || /^\*\*[^*]+\*\*$/.test(normalizedLine);
}

function getCompactedSectionSummary(value: string): string | undefined {
  const lines = value.split("\n");
  for (const stockBulletLimit of [4, 3]) {
    for (const watchlistBulletLimit of [2, 1]) {
      const compactedSummary = buildCompactedSectionSummary(lines, stockBulletLimit, watchlistBulletLimit);
      if (undefined !== compactedSummary && compactedSummary.length <= maxDiscordSummaryLength) {
        return compactedSummary;
      }
    }
  }

  return buildCompactedSectionSummary(lines, 3, 1);
}

function buildCompactedSectionSummary(
  lines: string[],
  stockBulletLimit: number,
  watchlistBulletLimit: number,
): string | undefined {
  const tldrHeadingIndex = lines.findIndex(line => line.includes("Morning News Call - TL;DR"));
  const stocksHeadingIndex = lines.findIndex(line => line.trim() === "**Stocks in focus**");
  const watchlistHeadingIndex = lines.findIndex(line => line.trim() === "**Watchlist**");
  if (-1 === stocksHeadingIndex || -1 === watchlistHeadingIndex) {
    return undefined;
  }

  const tldrStartIndex = -1 === tldrHeadingIndex ? 0 : tldrHeadingIndex + 1;
  const tldrBullets = getBulletLines(lines.slice(tldrStartIndex, stocksHeadingIndex)).slice(0, 2);
  const stockBullets = getBulletLines(lines.slice(stocksHeadingIndex + 1, watchlistHeadingIndex)).slice(0, stockBulletLimit);
  const watchlistBullets = getBulletLines(lines.slice(watchlistHeadingIndex + 1)).slice(0, watchlistBulletLimit);
  if (0 === tldrBullets.length || 0 === stockBullets.length || 0 === watchlistBullets.length) {
    return undefined;
  }

  return [
    ...tldrBullets,
    "",
    "**Stocks in focus**",
    ...stockBullets,
    "",
    "**Watchlist**",
    ...watchlistBullets,
  ].join("\n").trim();
}

function getBulletLines(lines: string[]): string[] {
  return lines
    .map(line => line.trim())
    .filter(line => bulletLinePattern.test(line));
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "[object Object]" === Object.prototype.toString.call(value);
}
