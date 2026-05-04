import moment from "moment-timezone";
import {type EarningsEvent} from "./earnings.ts";
import {
  extractOutlookMetrics,
  type EarningsOutlookMetric,
} from "./earnings-results-outlook.ts";

export type EarningsResultOutcome = "beat" | "inline" | "miss";

export type EarningsResultMetric = {
  estimate?: string | undefined;
  key: string;
  label: string;
  numericValue?: number | undefined;
  outcome?: EarningsResultOutcome | undefined;
  value: string;
};

export type ParsedEarningsDocument = {
  headline?: string | undefined;
  metrics: EarningsResultMetric[];
  outlook: EarningsOutlookMetric[];
  quarterLabel?: string | undefined;
};

export type NasdaqSurprise = {
  actualEps?: number | undefined;
  actualRevenue?: number | undefined;
  consensusEps?: number | undefined;
  consensusRevenue?: number | undefined;
  percentageSurprise?: number | undefined;
};

type SecCurrentFilingForMessage = {
  form: string;
  items: string[];
};

type MetricValueType = "eps" | "money" | "number";

type MetricDefinition = {
  key: string;
  label: string;
  patterns: RegExp[];
  skipPattern?: RegExp;
  valueType: MetricValueType;
};

const earningsMetricDefinitions: MetricDefinition[] = [
  {
    key: "adjusted_eps",
    label: "Adj EPS",
    patterns: [
      /\badjusted\s+(?:diluted\s+)?(?:earnings\s+per\s+(?:common\s+)?share|eps)\b/i,
      /\bnon-gaap\s+(?:diluted\s+)?(?:earnings\s+per\s+share|eps)\b/i,
    ],
    valueType: "eps",
  },
  {
    key: "gaap_eps",
    label: "EPS",
    patterns: [
      /\b(?:diluted\s+)?(?:earnings|net\s+income)\s+per\s+(?:common\s+)?share\b/i,
      /\bdiluted\s+eps\b/i,
      /\bgaap\s+(?:diluted\s+)?eps\b/i,
      /\beps\b/i,
    ],
    skipPattern: /\badjusted\b|\bnon-gaap\b|\bguidance\b|\boutlook\b|\bforecast\b/i,
    valueType: "eps",
  },
  {
    key: "revenue",
    label: "Revenue",
    patterns: [
      /\btotal\s+revenues?(?:\s+and\s+other\s+income)?\b/i,
      /\bnet\s+sales\b/i,
      /\brevenues?\b/i,
      /\bsales\b/i,
    ],
    skipPattern: /\bcost\s+of\b|\bdeferred\b|\bunearned\b|\bguidance\b|\boutlook\b|\bsince\s+(?:launch|inception)\b|\blife-to-date\b|\bcumulative\b|\brevenue\s+\(expense\)|\bnon[-\s]insurance\s+warranty\s+revenue\b/i,
    valueType: "money",
  },
  {
    key: "net_income",
    label: "Net income",
    patterns: [
      /\bnet\s+income(?!\s+per\s+(?:common\s+)?share)(?:\s+attributable[^|,]*)?\b/i,
      /\bnet\s+earnings(?!\s+per\s+(?:common\s+)?share)\b/i,
    ],
    skipPattern: /\beps\b/i,
    valueType: "money",
  },
  {
    key: "refinery_throughput",
    label: "Refinery throughput",
    patterns: [
      /\brefinery\s+throughput\b/i,
    ],
    valueType: "number",
  },
  {
    key: "production",
    label: "Production",
    patterns: [
      /\bproduction\b/i,
    ],
    valueType: "number",
  },
];
export function parseEarningsDocument(html: string): ParsedEarningsDocument {
  const text = htmlToText(html);
  const lines = getMeaningfulLines(text);
  return {
    headline: getDocumentHeadline(lines),
    metrics: extractEarningsMetrics(lines),
    outlook: extractOutlookMetrics(lines),
    quarterLabel: getQuarterLabel(text),
  };
}

export function getMessageMetrics(
  secMetrics: EarningsResultMetric[],
  surprise: NasdaqSurprise | null,
  event: EarningsEvent,
): EarningsResultMetric[] {
  const consensusEps = surprise?.consensusEps ?? parseNumber(event.epsConsensus) ?? undefined;
  const metrics = normalizeEpsMetrics([...secMetrics], surprise, consensusEps);
  const hasAdjustedEps = metrics.some(metric => "adjusted_eps" === metric.key);
  const hasGaapEps = metrics.some(metric => "gaap_eps" === metric.key);

  if ("number" === typeof surprise?.actualEps &&
      false === hasAdjustedEps &&
      false === hasGaapEps) {
    metrics.unshift({
      key: "nasdaq_eps",
      label: "EPS",
      numericValue: surprise.actualEps,
      value: formatEps(surprise.actualEps),
    });
  }

  const epsMetric = metrics.find(metric => "adjusted_eps" === metric.key) ??
    metrics.find(metric => "nasdaq_eps" === metric.key || "gaap_eps" === metric.key);
  if (epsMetric && "number" === typeof consensusEps) {
    epsMetric.estimate = formatEps(consensusEps);
    epsMetric.outcome = getOutcome(epsMetric.numericValue, consensusEps);
  }

  const revenueMetric = metrics.find(metric => "revenue" === metric.key);
  if (revenueMetric && "number" === typeof surprise?.consensusRevenue) {
    revenueMetric.estimate = formatUsdCompact(surprise.consensusRevenue);
    revenueMetric.outcome = getOutcome(revenueMetric.numericValue, surprise.consensusRevenue);
  }

  return metrics.slice(0, 7);
}

function normalizeEpsMetrics(
  metrics: EarningsResultMetric[],
  surprise: NasdaqSurprise | null,
  consensusEps: number | undefined,
): EarningsResultMetric[] {
  const actualEps = surprise?.actualEps;
  const adjustedEpsMetric = metrics.find(metric => "adjusted_eps" === metric.key);
  const gaapEpsMetric = metrics.find(metric => "gaap_eps" === metric.key);
  const primaryEpsMetric = adjustedEpsMetric ?? gaapEpsMetric;

  if ("number" === typeof actualEps &&
      undefined !== primaryEpsMetric &&
      true === isImplausibleSecEps(primaryEpsMetric.numericValue, actualEps, consensusEps)) {
    primaryEpsMetric.numericValue = actualEps;
    primaryEpsMetric.value = formatEps(actualEps);
  }

  if (adjustedEpsMetric &&
      gaapEpsMetric &&
      true === isImplausibleSecondaryGaapEps(gaapEpsMetric.numericValue, adjustedEpsMetric.numericValue)) {
    return metrics.filter(metric => "gaap_eps" !== metric.key);
  }

  return metrics;
}

function isImplausibleSecEps(
  secValue: number | undefined,
  actualEps: number,
  consensusEps: number | undefined,
): boolean {
  if ("number" !== typeof secValue || false === Number.isFinite(secValue)) {
    return false;
  }

  const referenceEps = consensusEps ?? actualEps;
  const closeEnoughTolerance = Math.max(0.25, Math.abs(actualEps) * 0.25);
  if (Math.abs(secValue - actualEps) <= closeEnoughTolerance) {
    return false;
  }

  if (Math.abs(secValue) >= 10 && Math.abs(referenceEps) < 5) {
    return true;
  }

  if (Math.sign(secValue) !== Math.sign(actualEps) &&
      Math.abs(secValue - actualEps) > 0.5) {
    return true;
  }

  return Math.abs(secValue - actualEps) > Math.max(1, Math.abs(referenceEps) * 2);
}

function isImplausibleSecondaryGaapEps(
  gaapValue: number | undefined,
  adjustedValue: number | undefined,
): boolean {
  if ("number" !== typeof gaapValue ||
      "number" !== typeof adjustedValue ||
      false === Number.isFinite(gaapValue) ||
      false === Number.isFinite(adjustedValue)) {
    return false;
  }

  if (Math.abs(gaapValue) >= 10 && Math.abs(adjustedValue) < 5) {
    return true;
  }

  return Math.abs(gaapValue - adjustedValue) > Math.max(10, Math.abs(adjustedValue) * 5);
}

export function getEarningsResultMessage({
  companyName,
  filing,
  filingUrl,
  metrics,
  parsedDocument,
  ticker,
}: {
  companyName: string;
  filing: SecCurrentFilingForMessage;
  filingUrl: string;
  metrics: EarningsResultMetric[];
  parsedDocument: ParsedEarningsDocument;
  ticker: string;
}): string {
  const titleParts = [`💰 **Earnings: ${companyName} (\`${ticker.trim().toUpperCase()}\`)`];
  if (parsedDocument.quarterLabel) {
    titleParts.push(` ${parsedDocument.quarterLabel}`);
  }
  titleParts.push("**");

  const lines = [titleParts.join("")];
  for (const metric of metrics) {
    lines.push(getMetricMessageLine(metric));
  }

  if (0 < parsedDocument.outlook.length) {
    lines.push("");
    lines.push("Outlook:");
    for (const metric of parsedDocument.outlook) {
      lines.push(`${metric.label}: \`${metric.value}\``);
    }
  }

  const filingItems = filing.items.length > 0 ? ` Item ${filing.items.join(", ")}` : "";
  const filingForm = "" === filingUrl ? filing.form : `[${filing.form}](${filingUrl})`;
  lines.push(`SEC: ${filingForm}${filingItems}`);
  return lines.join("\n");
}

function getMetricMessageLine(metric: EarningsResultMetric): string {
  const estimateText = metric.estimate ? ` vs est. \`${metric.estimate}\`` : "";
  const outcomeText = metric.outcome ? ` - ${metric.outcome}` : "";
  return `${metric.label}: \`${metric.value}\`${estimateText}${outcomeText}`;
}

function getOutcome(actual: number | undefined, estimate: number): EarningsResultOutcome | undefined {
  if ("number" !== typeof actual || false === Number.isFinite(actual)) {
    return undefined;
  }

  const tolerance = Math.max(Math.abs(estimate) * 0.001, 0.005);
  if (actual > estimate + tolerance) {
    return "beat";
  }

  if (actual < estimate - tolerance) {
    return "miss";
  }

  return "inline";
}

export function htmlToText(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexValue: string) => String.fromCodePoint(Number.parseInt(hexValue, 16)))
    .replace(/&#([0-9]+);/g, (_match, numericValue: string) => String.fromCodePoint(Number.parseInt(numericValue, 10)))
    .replace(/&amp;/gi, "&");
}

function getMeaningfulLines(text: string): string[] {
  return text
    .split("\n")
    .map(line => line.replace(/\s*\|\s*/g, " | ").replace(/\s+/g, " ").trim())
    .filter(line => line.length >= 3);
}

function getDocumentHeadline(lines: string[]): string | undefined {
  return lines.find(line => /earnings|results|reports|announces/i.test(line) && line.length <= 180);
}

function getQuarterLabel(text: string): string | undefined {
  const directQuarterMatch = text.match(/\b(Q[1-4])\s+(20\d{2})\b/i);
  if (undefined !== directQuarterMatch?.[1] && undefined !== directQuarterMatch[2]) {
    return `${directQuarterMatch[1].toUpperCase()} ${directQuarterMatch[2]}`;
  }

  const writtenQuarterMatch = text.match(/\b(first|second|third|fourth)\s+quarter\s+(?:of\s+)?(20\d{2})\b/i);
  if (undefined !== writtenQuarterMatch?.[1] && undefined !== writtenQuarterMatch[2]) {
    const quarterByName = new Map<string, string>([
      ["first", "Q1"],
      ["second", "Q2"],
      ["third", "Q3"],
      ["fourth", "Q4"],
    ]);
    const quarter = quarterByName.get(writtenQuarterMatch[1].toLowerCase());
    if (quarter) {
      return `${quarter} ${writtenQuarterMatch[2]}`;
    }
  }

  const quarterEndedMatch = text.match(/\bquarter\s+ended\s+([A-Z][a-z]+)\s+\d{1,2},\s+(20\d{2})\b/);
  if (undefined !== quarterEndedMatch?.[1] && undefined !== quarterEndedMatch[2]) {
    const month = moment(quarterEndedMatch[1], "MMMM", true);
    if (true === month.isValid()) {
      return `Q${Math.floor(month.month() / 3) + 1} ${quarterEndedMatch[2]}`;
    }
  }

  return undefined;
}

function extractEarningsMetrics(lines: string[]): EarningsResultMetric[] {
  const metrics: EarningsResultMetric[] = [];
  const seenKeys = new Set<string>();

  for (const definition of earningsMetricDefinitions) {
    if (true === seenKeys.has(definition.key)) {
      continue;
    }

    const metric = extractMetric(lines, definition);
    if (null === metric) {
      continue;
    }

    metrics.push(metric);
    seenKeys.add(metric.key);
  }

  return metrics;
}

function extractMetric(
  lines: string[],
  definition: MetricDefinition,
): EarningsResultMetric | null {
  for (const [lineIndex, line] of lines.entries()) {
    if (definition.skipPattern?.test(line)) {
      continue;
    }

    if ("net_income" === definition.key && true === isPerShareOnlyNetIncomeLine(line)) {
      continue;
    }

    const metricLine = getMetricLineWithContinuation(lines, lineIndex);
    const pattern = definition.patterns.find(candidatePattern => candidatePattern.test(metricLine));
    if (!pattern) {
      continue;
    }

    const metricValue = extractMetricValue(
      metricLine,
      pattern,
      definition.valueType,
      getContextMoneyScale(lines, lineIndex),
    );
    if (null === metricValue) {
      continue;
    }

    return {
      key: definition.key,
      label: definition.label,
      numericValue: metricValue.numericValue,
      value: metricValue.value,
    };
  }

  return null;
}

function isPerShareOnlyNetIncomeLine(line: string): boolean {
  return /\bper\s+(?:common\s+|diluted\s+)?share\b/i.test(line) &&
    false === /\b(?:trillion|billion|million|thousand)s?\b/i.test(line);
}

function getMetricLineWithContinuation(lines: string[], lineIndex: number): string {
  const line = lines[lineIndex] ?? "";
  const nextLine = lines[lineIndex + 1];
  if (undefined === nextLine || false === isValueOnlyLine(nextLine)) {
    return line;
  }

  return `${line} ${nextLine}`;
}

function isValueOnlyLine(line: string): boolean {
  return /^[\s|$€£¥(),.\-\d%—–]+$/.test(line);
}

function extractMetricValue(
  line: string,
  pattern: RegExp,
  valueType: MetricValueType,
  contextMoneyScale: number,
): {numericValue: number; value: string} | null {
  pattern.lastIndex = 0;
  const patternMatch = pattern.exec(line);
  const searchText = patternMatch ? line.slice(patternMatch.index + patternMatch[0].length) : line;

  if ("eps" === valueType) {
    const value = findNumericValue(searchText, {maxAbsValue: 100});
    return null === value ? null : {numericValue: value, value: formatEps(value)};
  }

  if ("money" === valueType) {
    const parsedValue = findNumericValue(searchText, {
      requireMoneyCue: 1 === contextMoneyScale,
      skipPercentages: true,
    });
    if (null === parsedValue) {
      return null;
    }

    const explicitScale = getExplicitMoneyScale(searchText);
    const amount = parsedValue * (explicitScale ?? contextMoneyScale);
    return {
      numericValue: amount,
      value: formatUsdCompact(amount),
    };
  }

  const value = findNumericValue(searchText, {skipPercentages: true});
  if (null === value) {
    return null;
  }

  const trailingUnit = getTrailingUnit(searchText);
  if (null === trailingUnit) {
    return null;
  }

  return {
    numericValue: value,
    value: formatPlainNumber(value, trailingUnit),
  };
}

function getContextMoneyScale(lines: string[], lineIndex: number): number {
  for (let index = lineIndex; index >= 0 && index >= lineIndex - 30; index--) {
    const line = lines[index];
    if (undefined === line) {
      continue;
    }

    const scale = getMoneyScaleFromContextText(line);
    if (null !== scale) {
      return scale;
    }
  }

  return 1;
}

function getMoneyScaleFromContextText(text: string): number | null {
  if (/\b(?:\$|amounts?|dollars?)?\s*(?:in\s+)?thousands(?:\s+of\s+dollars)?\b/i.test(text)) {
    return 1_000;
  }

  if (/\b(?:\$|amounts?|dollars?)?\s*(?:in\s+)?millions(?:\s+of\s+dollars)?\b/i.test(text)) {
    return 1_000_000;
  }

  if (/\b(?:\$|amounts?|dollars?)?\s*(?:in\s+)?billions(?:\s+of\s+dollars)?\b/i.test(text)) {
    return 1_000_000_000;
  }

  return null;
}

function getExplicitMoneyScale(text: string): number | null {
  const unitMatch = text.match(/\b(trillion|trillions|tn|billion|billions|bn|million|millions|mm|thousand|thousands)\b/i);
  const unit = unitMatch?.[1]?.toLowerCase();
  if (!unit) {
    return null;
  }

  if ("trillion" === unit || "trillions" === unit || "tn" === unit) {
    return 1_000_000_000_000;
  }

  if ("billion" === unit || "billions" === unit || "bn" === unit) {
    return 1_000_000_000;
  }

  if ("thousand" === unit || "thousands" === unit) {
    return 1_000;
  }

  return 1_000_000;
}

function findNumericValue(
  text: string,
  options: {maxAbsValue?: number; requireMoneyCue?: boolean; skipPercentages?: boolean;} = {},
): number | null {
  const numberMatches = text.matchAll(/\(?-?\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?/g);
  for (const numberMatch of numberMatches) {
    const token = numberMatch[0];
    const endIndex = numberMatch.index + token.length;
    if (true === options.skipPercentages && "%" === text.slice(endIndex, endIndex + 1)) {
      continue;
    }

    const value = parseNumber(token);
    if (null === value) {
      continue;
    }

    if (true === options.requireMoneyCue &&
        false === hasMoneyCue(text, numberMatch.index, endIndex, token)) {
      continue;
    }

    if (value >= 1900 && value <= 2100) {
      continue;
    }

    if ("number" === typeof options.maxAbsValue && Math.abs(value) > options.maxAbsValue) {
      continue;
    }

    return value;
  }

  return null;
}

function hasMoneyCue(text: string, startIndex: number, endIndex: number, token: string): boolean {
  if (token.includes("$")) {
    return true;
  }

  const beforeToken = text.slice(Math.max(0, startIndex - 8), startIndex);
  if (/\$[\s|()–-]*$/.test(beforeToken)) {
    return true;
  }

  const afterToken = text.slice(endIndex, endIndex + 18);
  return /^\s*(?:trillion|trillions|tn|billion|billions|bn|million|millions|mm|thousand|thousands)\b/i.test(afterToken);
}

export function parseNumber(value: unknown): number | null {
  if ("number" === typeof value) {
    return Number.isFinite(value) ? value : null;
  }

  if ("string" !== typeof value) {
    return null;
  }

  const normalizedValue = value
    .replace(/^\((.*)\)$/, "-$1")
    .replace(/^\((.*)$/, "-$1")
    .replaceAll("$", "")
    .replaceAll(",", "")
    .replaceAll("%", "")
    .trim()
    .toLowerCase();

  if ("" === normalizedValue || "--" === normalizedValue || "n/a" === normalizedValue) {
    return null;
  }

  const centsMatch = normalizedValue.match(/^(-?\d+(?:\.\d+)?)\s*c$/);
  if (undefined !== centsMatch?.[1]) {
    return Number.parseFloat(centsMatch[1]) / 100;
  }

  const parsedValue = Number.parseFloat(normalizedValue);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

export function formatEps(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2).replace(/\.?0+$/, "")}`;
}

export function formatUsdCompact(value: number): string {
  const absoluteValue = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absoluteValue >= 1_000_000_000_000) {
    return `${sign}$${formatDecimal(absoluteValue / 1_000_000_000_000)}T`;
  }

  if (absoluteValue >= 1_000_000_000) {
    return `${sign}$${formatDecimal(absoluteValue / 1_000_000_000)}B`;
  }

  if (absoluteValue >= 1_000_000) {
    return `${sign}$${formatDecimal(absoluteValue / 1_000_000)}M`;
  }

  if (absoluteValue >= 1_000) {
    return `${sign}$${formatDecimal(absoluteValue / 1_000)}K`;
  }

  return `${sign}$${formatDecimal(absoluteValue)}`;
}

function formatDecimal(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatPlainNumber(value: number, unit: string | null): string {
  const numberText = Number.isInteger(value)
    ? value.toLocaleString("en-US", {maximumFractionDigits: 0})
    : value.toLocaleString("en-US", {maximumFractionDigits: 2});
  return unit ? `${numberText} ${unit}` : numberText;
}

function getTrailingUnit(text: string): string | null {
  const unitMatch = text.match(/\b(kbd|koebd|boepd|bpd|mmboe|bcfe|mmcf|mw|gw)\b/i);
  return unitMatch?.[1] ?? null;
}

export function normalizeTickerSymbol(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replaceAll("/", ".")
    .replaceAll("-", ".");
}

export function normalizeCik(value: unknown): string | null {
  if ("number" === typeof value && Number.isFinite(value)) {
    return String(Math.trunc(value)).padStart(10, "0");
  }

  if ("string" !== typeof value) {
    return null;
  }

  const normalizedValue = value.trim().replace(/^0+/, "");
  if (!/^\d{1,10}$/.test(normalizedValue)) {
    return null;
  }

  return normalizedValue.padStart(10, "0");
}

export function getNormalizedString(value: unknown): string | null {
  if ("string" !== typeof value) {
    return null;
  }

  const normalizedValue = value.trim();
  return "" === normalizedValue ? null : normalizedValue;
}
