import type {Buffer} from "node:buffer";
import {callAiProviderJson, type AiProviderDependencies} from "./ai-provider.ts";

export type MncSummaryDependencies = AiProviderDependencies;

export type MncSummaryFields = {
  marketSetup: string[];
  stocksInFocus: string[];
  watchlist: string[];
};

const maxInlinePdfBytes = 14_000_000;
const maxDiscordSummaryLength = 1_930;
const maxMncSummaryAttempts = 2;
const stocksInFocusHeading = "**Stocks in focus**";
const watchlistHeading = "**Watchlist**";
// Strip a leading "-", "*", "•", or "–" bullet marker the model sometimes adds;
// the marker must be followed by whitespace so values like "-$3.5B" are kept.
const leadingBulletMarkerPattern = /^\s*[-*•–]\s+/;

// The model returns one bullet per array entry per section and the bot renders
// the Markdown itself, so the posted message always has the expected headings
// and bullets. This removes the class of failures where a complete free-form
// summary was discarded only because its headings or bullet markers did not
// match the shape the gate expected.
const mncSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    marketSetup: {
      type: "array",
      description: "2 short bullets on the market setup and the most important macro drivers.",
      items: {type: "string"},
    },
    stocksInFocus: {
      type: "array",
      description: "4 short bullets of company/ticker-specific news, earnings, guidance, analyst calls, or deal headlines.",
      items: {type: "string"},
    },
    watchlist: {
      type: "array",
      description: "1 short bullet for events, data releases, sectors, or risks traders should monitor.",
      items: {type: "string"},
    },
  },
  required: ["marketSetup", "stocksInFocus", "watchlist"],
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
    const fields = await requestMncSummaryFields(pdfBuffer, dependencies);
    if (undefined === fields) {
      continue;
    }

    if (false === isMncSummaryFieldsValid(fields)) {
      dependencies.logger.log(
        "warn",
        {
          message: `Discarding AI MNC summary (attempt ${attempt}/${maxMncSummaryAttempts}): a required section is empty.`,
          market_setup_count: fields.marketSetup.length,
          stocks_in_focus_count: fields.stocksInFocus.length,
          watchlist_count: fields.watchlist.length,
        },
      );
      continue;
    }

    const summary = renderMncSummary(fields);
    if ("" !== summary) {
      return summary;
    }
  }

  return undefined;
}

async function requestMncSummaryFields(
  pdfBuffer: Buffer,
  dependencies: MncSummaryDependencies,
): Promise<MncSummaryFields | undefined> {
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

  return {
    marketSetup: cleanBulletArray(parsedJson["marketSetup"]),
    stocksInFocus: cleanBulletArray(parsedJson["stocksInFocus"]),
    watchlist: cleanBulletArray(parsedJson["watchlist"]),
  };
}

// Assemble the structured fields into the posted Discord Markdown, then apply
// the inline-code/metric clean-ups and the Discord length budget. Exported so
// the rendering and normalization are covered without a provider round-trip.
export function renderMncSummary(fields: MncSummaryFields): string {
  let renderedSummary = "";
  for (const candidate of getCompactionCandidates(fields)) {
    renderedSummary = assembleSummary(candidate);
    if (renderedSummary.length <= maxDiscordSummaryLength) {
      return renderedSummary.trim();
    }
  }

  return hardTruncateSummary(renderedSummary).trim();
}

function assembleSummary(fields: MncSummaryFields): string {
  const lines = [
    ...fields.marketSetup.map(toBulletLine),
    "",
    stocksInFocusHeading,
    ...fields.stocksInFocus.map(toBulletLine),
    "",
    watchlistHeading,
    ...fields.watchlist.map(toBulletLine),
  ];

  return normalizeRenderedSummary(lines.join("\n"));
}

// Full summary first, then progressively fewer stock and watchlist bullets, so
// an over-budget summary keeps every section instead of being cut mid-list.
function* getCompactionCandidates(fields: MncSummaryFields): Generator<MncSummaryFields> {
  yield fields;
  for (const stockLimit of [4, 3]) {
    for (const watchlistLimit of [2, 1]) {
      yield {
        marketSetup: fields.marketSetup.slice(0, 2),
        stocksInFocus: fields.stocksInFocus.slice(0, stockLimit),
        watchlist: fields.watchlist.slice(0, watchlistLimit),
      };
    }
  }
}

function isMncSummaryFieldsValid(fields: MncSummaryFields): boolean {
  return fields.marketSetup.length >= 1
    && fields.stocksInFocus.length >= 1
    && fields.watchlist.length >= 1;
}

function toBulletLine(text: string): string {
  return `- ${text}`;
}

function cleanBulletArray(value: unknown): string[] {
  if (false === Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => "string" === typeof item)
    .map(item => item
      .replace(leadingBulletMarkerPattern, "")
      .replace(/\s*\n\s*/g, " ")
      .trim())
    .filter(item => "" !== item);
}

function getMncSummaryPrompt(): string {
  return [
    "Summarize this Refinitiv Morning News Call PDF for a Discord trading channel.",
    "Return only JSON matching the schema: three string arrays, one entry per bullet.",
    "Do not put Markdown headings or bullet markers inside the strings; the bot adds those.",
    "Populate the arrays:",
    "- marketSetup: exactly 2 bullets with the market setup and most important macro drivers.",
    "- stocksInFocus: exactly 4 bullets with company/ticker-specific news, earnings, guidance, analyst calls, or deal headlines.",
    "- watchlist: exactly 1 bullet for events, data releases, sectors, or risks traders should monitor.",
    "Rules:",
    "- Each bullet is one concise Discord line; keep the whole summary under 1,750 characters.",
    "- Prioritize concrete, market-moving information from the PDF.",
    "- Write in English only.",
    "- Format ticker symbols and quantitative metrics as inline code, e.g. `AAPL`, `$2.14`, `3.1%`, `10Y`, `250K`.",
    "- For metric ranges, write the range inside one inline-code token, e.g. `$1.26B-$1.36B`; do not turn range separators or table dashes into negative signs.",
    "- Use a negative sign only when the PDF explicitly reports a negative value, loss, charge, deficit, decline, or outflow.",
    "- In stocksInFocus bullets, start with Company Name `TICKER` when the PDF explicitly provides a ticker; common short company names are fine, e.g. Apple `AAPL`.",
    "- If the PDF does not explicitly provide a ticker, start with the company name without inventing a ticker.",
    "- Do not infer or invent tickers, prices, percentages, or attributions.",
    "- Do not use code blocks, tables, links, emojis, or disclaimers.",
  ].join("\n");
}

function normalizeRenderedSummary(value: string): string {
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
          removeUnexpectedScriptTokens(summary),
        ),
      ),
    ),
  ).trim();
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

function hardTruncateSummary(value: string): string {
  const suffix = "\n...";
  const maxBodyLength = maxDiscordSummaryLength - suffix.length;
  const lines: string[] = [];
  for (const line of value.split("\n")) {
    if ([...lines, line].join("\n").length > maxBodyLength) {
      break;
    }

    lines.push(line);
  }

  while (0 < lines.length && true === isDanglingSummaryLine(lines[lines.length - 1] ?? "")) {
    lines.pop();
  }

  const body = lines.join("\n").trimEnd();
  if ("" !== body) {
    return `${body}${suffix}`;
  }

  return `${value.slice(0, maxBodyLength).trimEnd()}${suffix}`;
}

function isDanglingSummaryLine(line: string): boolean {
  const normalizedLine = line.trim();
  return "" === normalizedLine || /^\*\*[^*]+\*\*$/.test(normalizedLine);
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
