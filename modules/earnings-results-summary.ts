import {callAiProviderJson, type AiProviderDependencies} from "./ai-provider.ts";
import {htmlToText, type EarningsResultMetric} from "./earnings-results-format.ts";

export type EarningsAiSummaryInput = {
  companyName: string;
  filingForm: string;
  filingUrl: string;
  html: string;
  metrics?: EarningsResultMetric[] | undefined;
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

  return parseSummary(parsedJson, input);
}

function getSummaryPrompt(input: EarningsAiSummaryInput, filingText: string): string {
  const displayedMetricsText = getDisplayedMetricsText(input.metrics ?? []);
  return [
    "Summarize this public SEC earnings release for a Discord earnings alert.",
    "Return only JSON matching the schema. Do not include markdown.",
    "Rules:",
    "- Write exactly three concise plain-text sentences.",
    "- Sentence 1 covers the reported period and headline performance.",
    "- Sentence 2 covers the most important business drivers, segment notes, or margin/profit details.",
    "- Sentence 3 covers outlook, guidance, or management expectations when present; otherwise state that no quantified outlook is provided.",
    "- Return plain text only; do not include markdown, backticks, bullets, headings, or labels.",
    "- The Discord bot formats ticker symbols and concrete metrics after validation.",
    "- Do not mention the company name in the summary; the Discord alert title already identifies the company.",
    "- If you mention any displayed result metric, use exactly the displayed value and do not mention a different value for the same metric.",
    "- Use only the provided filing text and do not mention the SEC filing, source text, or any AI provider.",
    `Company: ${input.companyName}`,
    `Ticker: ${input.ticker}`,
    `Filing: ${input.filingForm} ${input.filingUrl}`,
    ...(0 === displayedMetricsText.length ? [] : [
      "Displayed result metrics:",
      displayedMetricsText,
    ]),
    "Filing text:",
    filingText,
  ].join("\n");
}

function getDisplayedMetricsText(metrics: EarningsResultMetric[]): string {
  return metrics
    .map(metric => `- ${metric.label}: ${metric.value}`)
    .join("\n");
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

function parseSummary(value: unknown, input: EarningsAiSummaryInput): string | null {
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
  if ("" === normalizedSummary ||
      normalizedSummary.length > maxSummaryLength ||
      true === hasUnexpectedMarkdown(normalizedSummary) ||
      true === hasCorrectionArtifact(normalizedSummary) ||
      true === hasUnexpectedCjkCharacters(normalizedSummary)) {
    return null;
  }

  if (true === hasDisplayedMetricConflict(normalizedSummary, input.metrics ?? [])) {
    return null;
  }

  return formatSummaryInlineCode(removeRedundantCompanyNameMentions(normalizedSummary, input.companyName), input.ticker);
}

function hasDisplayedMetricConflict(summary: string, metrics: EarningsResultMetric[]): boolean {
  return getSummarySentences(summary).some(sentence =>
    metrics.some(metric => true === hasMetricConflict(sentence, metric)));
}

function getSummarySentences(summary: string): string[] {
  return summary
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => "" !== sentence);
}

function hasMetricConflict(sentence: string, metric: EarningsResultMetric): boolean {
  if ("number" !== typeof metric.numericValue) {
    return false;
  }

  if (true === isForwardLookingMetricSentence(sentence)) {
    return false;
  }

  if ("net_income" === metric.key) {
    const metricLabelMatch = /\bnet\s+(?:income|earnings)\b/i.exec(sentence);
    if (null === metricLabelMatch ||
        true === /\bper\s+share\b/i.test(getMetricValueSegment(sentence, metricLabelMatch))) {
      return false;
    }

    return hasConflictingMoneyValue(getMetricValueSegment(sentence, metricLabelMatch), metric.numericValue);
  }

  if ("revenue" === metric.key) {
    const metricLabelMatch = /\b(?:revenue|sales)\b/i.exec(sentence);
    if (null === metricLabelMatch) {
      return false;
    }

    return hasConflictingMoneyValue(getMetricValueSegment(sentence, metricLabelMatch), metric.numericValue);
  }

  return false;
}

function getMetricValueSegment(sentence: string, metricLabelMatch: RegExpExecArray): string {
  const afterMetricLabel = sentence.slice(metricLabelMatch.index + metricLabelMatch[0].length);
  const nextMetricLabelMatch = /\b(?:adjusted\s+eps|eps|earnings\s+per\s+share|revenue|sales|net\s+(?:income|earnings)|ffo|ebitda|cash\s+flow|production|guidance|outlook)\b/i.exec(afterMetricLabel);
  const endIndex = Math.min(nextMetricLabelMatch?.index ?? afterMetricLabel.length, 140);
  return afterMetricLabel.slice(0, endIndex);
}

function isForwardLookingMetricSentence(sentence: string): boolean {
  return /\b(?:guidance|guided|outlook|forecast|expects?|expectations?|target|range)\b/i.test(sentence);
}

function hasUnexpectedCjkCharacters(value: string): boolean {
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(value);
}

function hasUnexpectedMarkdown(value: string): boolean {
  return /[`*_#]|\n\s*[-*]\s+/.test(value);
}

function hasCorrectionArtifact(value: string): boolean {
  return /\b(?:no|yes),\s+(?:we|i)\s+(?:reiterate|should|will|can|need|must|mean)\b/i.test(value) ||
    /-\?\s*(?:no|yes)?\s*,/i.test(value);
}

function hasConflictingMoneyValue(sentence: string, expectedValue: number): boolean {
  const moneyValues = extractMoneyValues(sentence);
  return moneyValues.some(value => false === isCloseMetricValue(value, expectedValue));
}

function extractMoneyValues(sentence: string): number[] {
  const values: number[] = [];
  const matches = sentence.matchAll(/\(?-?(?:(?:[$€£¥]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:trillion|trillions|tn|billion|billions|bn|million|millions|mm|thousand|thousands|[tbmk]))|[$€£¥]\s*\d[\d,]*(?:\.\d+)?)\)?/gi);
  for (const match of matches) {
    const parsedValue = parseMoneyValue(match[0]);
    if (null !== parsedValue) {
      values.push(parsedValue);
    }
  }

  return values;
}

function parseMoneyValue(value: string): number | null {
  const normalizedValue = value.trim();
  const numberMatch = normalizedValue.match(/\(?-?(?:[$€£¥]\s*)?([\d,]+(?:\.\d+)?)\)?/);
  if (undefined === numberMatch?.[1]) {
    return null;
  }

  const parsedNumber = Number.parseFloat(numberMatch[1].replaceAll(",", ""));
  if (false === Number.isFinite(parsedNumber)) {
    return null;
  }

  const sign = /^\s*\(|^\s*-/.test(normalizedValue) ? -1 : 1;
  return sign * parsedNumber * getMoneyUnitScale(normalizedValue);
}

function getMoneyUnitScale(value: string): number {
  if (/\b(?:trillion|trillions|tn)\b|[\d)]\s*t\b/i.test(value)) {
    return 1_000_000_000_000;
  }

  if (/\b(?:billion|billions|bn)\b|[\d)]\s*b\b/i.test(value)) {
    return 1_000_000_000;
  }

  if (/\b(?:million|millions|mm)\b|[\d)]\s*m\b/i.test(value)) {
    return 1_000_000;
  }

  if (/\b(?:thousand|thousands)\b|[\d)]\s*k\b/i.test(value)) {
    return 1_000;
  }

  return 1;
}

function isCloseMetricValue(actualValue: number, expectedValue: number): boolean {
  const tolerance = Math.max(1, Math.abs(expectedValue) * 0.01);
  return Math.abs(actualValue - expectedValue) <= tolerance;
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
