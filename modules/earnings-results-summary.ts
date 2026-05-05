import {callAiProviderJson, type AiProviderDependencies} from "./ai-provider.ts";
import {htmlToText} from "./earnings-results-format.ts";

export type EarningsAiSummaryInput = {
  companyName: string;
  filingForm: string;
  filingUrl: string;
  html: string;
  ticker: string;
};

type EarningsSummaryDependencies = AiProviderDependencies;

const maxSummaryOpeningTextLength = 12_000;
const maxSummaryGuidanceTextLength = 8_000;
const summaryGuidanceContextBeforeLines = 2;
const summaryGuidanceContextAfterLines = 8;
const maxSummaryLength = 700;

const earningsSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      maxLength: maxSummaryLength,
      description: "Exactly three concise plain-text sentences summarizing the earnings release.",
    },
  },
  required: ["summary"],
} satisfies Record<string, unknown>;

export async function summarizeEarningsWithAi(
  input: EarningsAiSummaryInput,
  dependencies: EarningsSummaryDependencies,
): Promise<string | null> {
  const filingText = getSummaryFilingText(input.html);
  if ("" === filingText) {
    return null;
  }

  const prompt = getSummaryPrompt(input, filingText);
  const jsonText = await callAiProviderJson(
    prompt,
    earningsSummarySchema,
    dependencies,
    `earnings summary for ${input.ticker}`,
    undefined,
    {
      timeoutMs: 30_000,
    },
  )
    .catch(error => {
      dependencies.logger.log(
        "warn",
        `AI earnings summary failed for ${input.ticker}: ${error}`,
      );
      return null;
    });
  if (null === jsonText) {
    return null;
  }

  const parsedJson = parseJson(jsonText);
  if (null === parsedJson) {
    dependencies.logger.log(
      "warn",
      `AI earnings summary returned invalid JSON for ${input.ticker}.`,
    );
    return null;
  }

  return parseSummary(parsedJson, input.ticker, input.companyName);
}

function getSummaryPrompt(input: EarningsAiSummaryInput, filingText: string): string {
  return [
    "Summarize this public SEC earnings release for a Discord earnings alert.",
    "Return only JSON matching the schema. Do not include markdown.",
    "Rules:",
    "- Write exactly three concise plain-text sentences.",
    "- Sentence 1 covers the reported period and headline performance.",
    "- Sentence 2 covers the most important business drivers, segment notes, or margin/profit details.",
    "- Sentence 3 covers outlook, guidance, or management expectations when present; otherwise state that no quantified outlook is provided.",
    "- Format ticker symbols and concrete metrics as inline code, e.g. `AAPL`, `$2.14`, `3.1%`, `180 bps`, `$42 billion`.",
    "- Do not mention the company name in the summary; the Discord alert title already identifies the company.",
    "- Use only the provided filing text and do not mention the SEC filing, source text, or any AI provider.",
    `Company: ${input.companyName}`,
    `Ticker: ${input.ticker}`,
    `Filing: ${input.filingForm} ${input.filingUrl}`,
    "Filing text:",
    filingText,
  ].join("\n");
}

function getSummaryFilingText(html: string): string {
  const lines = getSummaryLines(html);
  if (0 === lines.length) {
    return "";
  }

  const openingText = truncateSummaryText(lines.join("\n"), maxSummaryOpeningTextLength);
  const guidanceText = getGuidanceText(lines);
  if ("" === guidanceText) {
    return [
      "Opening excerpt:",
      openingText,
    ].join("\n");
  }

  return [
    "Opening excerpt:",
    openingText,
    "Guidance/outlook excerpt:",
    guidanceText,
  ].join("\n");
}

function getSummaryLines(html: string): string[] {
  return htmlToText(html)
    .split("\n")
    .map(line => line.replace(/\s*\|\s*/g, " | ").replace(/\s+/g, " ").trim())
    .filter(line => line.length >= 3);
}

function getGuidanceText(lines: string[]): string {
  const selectedLineIndexes = new Set<number>();
  for (const [lineIndex, line] of lines.entries()) {
    if (false === isGuidanceLine(line)) {
      continue;
    }

    for (
      let index = Math.max(0, lineIndex - summaryGuidanceContextBeforeLines);
      index <= Math.min(lines.length - 1, lineIndex + summaryGuidanceContextAfterLines);
      index++
    ) {
      selectedLineIndexes.add(index);
    }
  }

  const selectedText = [...selectedLineIndexes]
    .sort((first, second) => first - second)
    .map(lineIndex => lines[lineIndex])
    .filter((line): line is string => undefined !== line)
    .join("\n")
    .trim();
  return truncateSummaryText(selectedText, maxSummaryGuidanceTextLength);
}

function isGuidanceLine(line: string): boolean {
  return /\b(?:guidance|outlook|forecast|expects?|business\s+outlook|financial\s+outlook)\b/i.test(line);
}

function truncateSummaryText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const truncatedValue = value.slice(0, maxLength);
  const lastLineBreak = truncatedValue.lastIndexOf("\n");
  const excerpt = lastLineBreak > 0
    ? truncatedValue.slice(0, lastLineBreak)
    : truncatedValue;
  return `${excerpt.trimEnd()}\n[truncated]`;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseSummary(value: unknown, ticker: string, companyName: string): string | null {
  if (false === isRecord(value)) {
    return null;
  }

  const summary = value["summary"];
  if ("string" !== typeof summary) {
    return null;
  }

  const normalizedSummary = summary
    .replace(/\\[nr]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if ("" === normalizedSummary || normalizedSummary.length > maxSummaryLength) {
    return null;
  }

  return formatSummaryInlineCode(removeRedundantCompanyNameMentions(normalizedSummary, companyName), ticker);
}

function removeRedundantCompanyNameMentions(value: string, companyName: string): string {
  const companyNamePatterns = getCompanyNamePatterns(companyName);
  if (0 === companyNamePatterns.length) {
    return value;
  }

  let result = value;
  for (const companyNamePattern of companyNamePatterns) {
    result = result.replace(
      companyNamePattern,
      (_match, sentencePrefix: string, nextCharacter: string) => `${sentencePrefix}${capitalizeFirstLetter(nextCharacter)}`,
    );
  }

  return result;
}

function getCompanyNamePatterns(companyName: string): RegExp[] {
  const normalizedCompanyName = companyName.replace(/\s+/g, " ").trim();
  if ("" === normalizedCompanyName) {
    return [];
  }

  const aliases = new Set<string>([normalizedCompanyName]);
  const suffixlessCompanyName = normalizedCompanyName
    .replace(/,?\s+(?:incorporated|inc\.?|corporation|corp\.?|company|co\.?|limited|ltd\.?|plc|group|holdings?)\.?$/i, "")
    .trim();
  if ("" !== suffixlessCompanyName) {
    aliases.add(suffixlessCompanyName);
  }

  for (const alias of [...aliases]) {
    aliases.add(alias.replace(/^the\s+/i, "").trim());
  }

  return [...aliases]
    .filter(alias => "" !== alias)
    .sort((first, second) => second.length - first.length)
    .map(alias => new RegExp(`(^|[.!?]\\s+)${escapeRegExp(alias)}(?:\\s*\\([A-Z0-9.:-]+\\))?(?:\\s*'s)?(?:\\s+|\\s*[,;:.-]\\s*)(\\S)`, "gi"));
}

function capitalizeFirstLetter(value: string): string {
  return value.replace(/[A-Za-z]/, letter => letter.toUpperCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatSummaryInlineCode(value: string, ticker: string): string {
  return mapTextOutsideInlineCode(value, text => formatMetricInlineCode(formatTickerInlineCode(text, ticker)));
}

function formatTickerInlineCode(value: string, ticker: string): string {
  const normalizedTicker = ticker.trim().toUpperCase().replace(/[^A-Z0-9.]/g, "");
  if ("" === normalizedTicker) {
    return value;
  }

  const escapedTicker = normalizedTicker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(
    new RegExp(`(?<![A-Z0-9.])${escapedTicker}(?![A-Z0-9.])`, "g"),
    matchedTicker => `\`${matchedTicker}\``,
  );
}

function formatMetricInlineCode(value: string): string {
  return value.replace(
    /-?(?:(?:[$€£¥]\s*)\d[\d,]*(?:\.\d+)?(?:\s*(?:trillion|billions?|millions?|thousands?|tn|bn|mm|[tbmk])\b)?|\d[\d,]*(?:\.\d+)?(?:\s*(?:trillion|billions?|millions?|thousands?|tn|bn|mm|bps?|basis points?|points?|[tbmk])\b|\s*%))/gi,
    token => `\`${token.trim()}\``,
  );
}

function mapTextOutsideInlineCode(value: string, mapper: (text: string) => string): string {
  return value
    .split(/(`[^`]*`)/g)
    .map(part => part.startsWith("`") && part.endsWith("`") ? part : mapper(part))
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "[object Object]" === Object.prototype.toString.call(value);
}
