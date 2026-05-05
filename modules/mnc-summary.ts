import type {Buffer} from "node:buffer";
import {callAiProviderJson, type AiProviderDependencies} from "./ai-provider.ts";

export type MncSummaryDependencies = AiProviderDependencies;

const maxInlinePdfBytes = 14_000_000;
const maxDiscordSummaryLength = 1_930;

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
  return "" === normalizedSummary ? undefined : truncateMarkdownSummary(normalizedSummary);
}

function getMncSummaryPrompt(): string {
  return [
    "Summarize this Refinitiv Morning News Call PDF for a Discord trading channel.",
    "Return only JSON matching the schema. Do not include markdown outside the JSON string.",
    "Write summaryMarkdown as a one-minute read in concise Discord Markdown.",
    "Required shape:",
    "**Morning News Call - TL;DR**",
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
    "- Format ticker symbols and quantitative metrics as inline code, e.g. `AAPL`, `$2.14`, `3.1%`, `10Y`, `250K`.",
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
    .trim();
  if (summary.startsWith("📰 **Morning News Call - TL;DR**")) {
    return summary.slice("📰 ".length);
  }

  return summary;
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
  if (-1 === tldrHeadingIndex || -1 === stocksHeadingIndex || -1 === watchlistHeadingIndex) {
    return undefined;
  }

  const tldrBullets = getBulletLines(lines.slice(tldrHeadingIndex + 1, stocksHeadingIndex)).slice(0, 2);
  const stockBullets = getBulletLines(lines.slice(stocksHeadingIndex + 1, watchlistHeadingIndex)).slice(0, stockBulletLimit);
  const watchlistBullets = getBulletLines(lines.slice(watchlistHeadingIndex + 1)).slice(0, watchlistBulletLimit);
  if (0 === tldrBullets.length || 0 === stockBullets.length || 0 === watchlistBullets.length) {
    return undefined;
  }

  return [
    lines[tldrHeadingIndex],
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
    .filter(line => line.startsWith("- "));
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
