import type {Buffer} from "node:buffer";
import {callGeminiJson, type GeminiDependencies} from "./gemini.ts";

export type MncSummaryDependencies = GeminiDependencies;

const maxInlinePdfBytes = 14_000_000;
const maxDiscordSummaryLength = 1_700;

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
      "Skipping MNC Gemini summary: PDF is too large for inline Gemini processing.",
    );
    return undefined;
  }

  const jsonText = await callGeminiJson(
    getMncSummaryPrompt(),
    mncSummarySchema,
    dependencies,
    "MNC summary",
    {
      data: pdfBuffer.toString("base64"),
      mimeType: "application/pdf",
    },
    {
      timeoutMs: 60_000,
    },
  ).catch(error => {
    dependencies.logger.log(
      "warn",
      `Gemini MNC summary failed: ${error}`,
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
      "Gemini MNC summary returned invalid JSON.",
    );
    return undefined;
  }

  const summaryMarkdown = parsedJson["summaryMarkdown"];
  if ("string" !== typeof summaryMarkdown) {
    dependencies.logger.log(
      "warn",
      "Gemini MNC summary response did not contain summaryMarkdown.",
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
    "- 2-3 bullets with the market setup and most important macro drivers.",
    "",
    "**Stocks in focus**",
    "- 4-6 bullets with company/ticker-specific news, earnings, guidance, analyst calls, or deal headlines.",
    "",
    "**Watchlist**",
    "- 1-3 bullets for events, data releases, sectors, or risks traders should monitor.",
    "Rules:",
    "- Keep the full summary under 1,500 characters.",
    "- Use 8-12 bullets total; each bullet should fit one Discord line.",
    "- Prioritize concrete, market-moving information from the PDF.",
    "- Format ticker symbols and quantitative metrics as inline code, e.g. `AAPL`, `$2.14`, `3.1%`, `10Y`, `250K`.",
    "- In stock-specific bullets, start with an inline-code ticker only when the PDF explicitly provides the ticker; otherwise format the company name itself as inline code.",
    "- Do not infer or invent tickers, prices, percentages, or attributions.",
    "- Do not use code blocks, tables, links, emojis, or disclaimers.",
  ].join("\n");
}

function normalizeMarkdownSummary(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trimEnd())
    .filter(line => false === /^```/.test(line.trim()))
    .join("\n")
    .trim();
}

function truncateMarkdownSummary(value: string): string {
  if (value.length <= maxDiscordSummaryLength) {
    return value;
  }

  const truncatedValue = value.slice(0, maxDiscordSummaryLength - 20);
  const lastLineBreak = truncatedValue.lastIndexOf("\n");
  const summary = lastLineBreak > 0
    ? truncatedValue.slice(0, lastLineBreak)
    : truncatedValue;
  return `${summary.trimEnd()}\n- ...`;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && false === Array.isArray(value);
}
