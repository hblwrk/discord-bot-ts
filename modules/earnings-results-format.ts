import moment from "moment-timezone";
import {type EarningsEvent} from "./earnings.ts";
import {
  extractOutlookMetrics,
  type EarningsOutlookMetric,
} from "./earnings-results-outlook.ts";

export type EarningsResultOutcome = "beat" | "inline" | "miss";

export type EarningsResultMetric = {
  currencyCode?: string | undefined;
  estimate?: string | undefined;
  key: string;
  label: string;
  numericValue?: number | undefined;
  outcome?: EarningsResultOutcome | undefined;
  sourceSnippet?: string | undefined;
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

type MoneyContext = {
  currencyCode?: string | undefined;
  scale: number;
};

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
  if (epsMetric && "number" === typeof consensusEps && true === canCompareAgainstUsdEstimate(epsMetric)) {
    epsMetric.estimate = formatEps(consensusEps);
    epsMetric.outcome = getOutcome(epsMetric.numericValue, consensusEps);
  }

  const revenueMetric = metrics.find(metric => "revenue" === metric.key);
  if (revenueMetric &&
      "number" === typeof surprise?.consensusRevenue &&
      true === canCompareAgainstUsdEstimate(revenueMetric)) {
    revenueMetric.estimate = formatUsdCompact(surprise.consensusRevenue);
    revenueMetric.outcome = getOutcome(revenueMetric.numericValue, surprise.consensusRevenue);
  }

  return metrics.slice(0, 7);
}

function canCompareAgainstUsdEstimate(metric: EarningsResultMetric): boolean {
  return undefined === metric.currencyCode || "USD" === metric.currencyCode;
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
  summary,
  ticker,
}: {
  companyName: string;
  filing: SecCurrentFilingForMessage;
  filingUrl: string;
  metrics: EarningsResultMetric[];
  parsedDocument: ParsedEarningsDocument;
  summary?: string | undefined;
  ticker: string;
}): string {
  const normalizedTicker = ticker.trim().toUpperCase().replaceAll("`", "'");
  const titleParts = [`**${companyName} (\`${normalizedTicker}\`)**`];
  if (parsedDocument.quarterLabel) {
    titleParts.push(` - ${parsedDocument.quarterLabel}`);
  }
  titleParts.push(` - ${getFilingFormText(filing, filingUrl)}`);

  const lines = [titleParts.join("")];
  if (undefined !== summary && "" !== summary.trim()) {
    lines.push(`📝 ${summary.trim()}`);
  }

  if (0 < metrics.length) {
    if (1 < lines.length) {
      lines.push("");
    }
    lines.push("📊 **Results**");
    for (const metric of metrics) {
      lines.push(getMetricMessageLine(metric));
    }
  }

  if (0 < parsedDocument.outlook.length) {
    if (1 < lines.length) {
      lines.push("");
    }
    lines.push("🔮 **Outlook**");
    for (const metric of parsedDocument.outlook) {
      lines.push(`- **${metric.label}:** ${formatOutlookValue(metric.value)}`);
    }
  }

  return lines.join("\n");
}

function getFilingFormText(filing: SecCurrentFilingForMessage, filingUrl: string): string {
  return "" === filingUrl ? filing.form : `[${filing.form}](${filingUrl})`;
}

function getMetricMessageLine(metric: EarningsResultMetric): string {
  const estimateText = metric.estimate ? ` vs est. ${formatInlineCode(metric.estimate)}` : "";
  const outcomeText = metric.outcome ? ` (${getOutcomeIndicator(metric.outcome)} ${metric.outcome})` : "";
  return `- **${metric.label}:** ${formatInlineCode(metric.value)}${estimateText}${outcomeText}`;
}

function formatOutlookValue(value: string): string {
  if (false === isQuantitativeText(value)) {
    return value;
  }

  return formatQuantitativeTokens(value);
}

function isQuantitativeText(value: string): boolean {
  return /[$€£¥]|\d/.test(value);
}

function formatQuantitativeTokens(value: string): string {
  return value.replace(
    /-?(?:[$€£¥]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:trillion|billions?|millions?|thousands?|tn|bn|mm|[tbmk]|kbd|koebd|boepd|bpd|mmboe|bcfe|mmcf|mw|gw)\b|\s*%)?/gi,
    token => formatInlineCode(token.trim()),
  );
}

function formatInlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function getOutcomeIndicator(outcome: EarningsResultOutcome): string {
  if ("beat" === outcome) {
    return "🟢";
  }

  if ("miss" === outcome) {
    return "🔴";
  }

  return "⚪";
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
  const writtenQuarterMatch = text.match(/\b(first|second|third|fourth)\s+quarter\s+(?:of\s+)?(20\d{2})\b/i);
  if (undefined !== writtenQuarterMatch?.[1] && undefined !== writtenQuarterMatch[2]) {
    const quarter = getQuarterFromName(writtenQuarterMatch[1]);
    if (quarter) {
      return `${quarter} ${writtenQuarterMatch[2]}`;
    }
  }

  const periodEndedQuarter = getQuarterLabelFromPeriodEnded(text);
  if (undefined !== periodEndedQuarter) {
    return periodEndedQuarter;
  }

  const directQuarterMatch = text.match(/\b(Q[1-4])\s+(20\d{2})\b/i);
  if (undefined !== directQuarterMatch?.[1] && undefined !== directQuarterMatch[2]) {
    return `${directQuarterMatch[1].toUpperCase()} ${directQuarterMatch[2]}`;
  }

  return undefined;
}

function getQuarterLabelFromPeriodEnded(text: string): string | undefined {
  const periodEndedMatch = text.match(
    /\b(?:three\s+months|quarter)\s+ended\s+([A-Z][a-z]+)\s+\d{1,2},\s+(20\d{2})\b/,
  );
  if (undefined === periodEndedMatch?.[1] || undefined === periodEndedMatch[2]) {
    return undefined;
  }

  const month = moment(periodEndedMatch[1], "MMMM", true);
  if (false === month.isValid()) {
    return undefined;
  }

  return `Q${Math.floor(month.month() / 3) + 1} ${periodEndedMatch[2]}`;
}

function getQuarterFromName(name: string): string | undefined {
  const quarterByName = new Map<string, string>([
    ["first", "Q1"],
    ["second", "Q2"],
    ["third", "Q3"],
    ["fourth", "Q4"],
  ]);
  return quarterByName.get(name.toLowerCase());
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
      getContextMoney(lines, lineIndex),
      isNearTableNoteColumn(lines, lineIndex),
    );
    if (null === metricValue) {
      continue;
    }

    return {
      currencyCode: metricValue.currencyCode,
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
  const metricLines = [lines[lineIndex] ?? ""];
  for (let index = lineIndex + 1; index < lines.length && index <= lineIndex + 6; index++) {
    const nextLine = lines[index];
    if (undefined === nextLine || false === isValueOnlyLine(nextLine)) {
      break;
    }

    metricLines.push(nextLine);
  }

  return metricLines.join(" ");
}

function isValueOnlyLine(line: string): boolean {
  return /^[\s|$€£¥(),.\-\d%—–]+$/.test(line);
}

function extractMetricValue(
  line: string,
  pattern: RegExp,
  valueType: MetricValueType,
  contextMoney: MoneyContext,
  skipTableNoteRefs: boolean,
): {currencyCode?: string | undefined; numericValue: number; value: string} | null {
  pattern.lastIndex = 0;
  const patternMatch = pattern.exec(line);
  const searchText = patternMatch ? line.slice(patternMatch.index + patternMatch[0].length) : line;

  if ("eps" === valueType) {
    const value = findNumericValue(searchText, {
      maxAbsValue: 100,
      parseCents: true,
    });
    return null === value ? null : {numericValue: value, value: formatEps(value)};
  }

  if ("money" === valueType) {
    const parsedValue = findNumericValue(searchText, {
      requireMoneyCue: 1 === contextMoney.scale,
      skipTableNoteRefs,
      skipPercentages: true,
    });
    if (null === parsedValue) {
      return null;
    }

    const explicitScale = getExplicitMoneyScale(searchText);
    const currencyCode = getCurrencyCodeFromText(searchText) ?? contextMoney.currencyCode;
    const amount = parsedValue * (explicitScale ?? contextMoney.scale);
    return {
      currencyCode,
      numericValue: amount,
      value: formatMoneyCompact(amount, currencyCode),
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

function getContextMoney(lines: string[], lineIndex: number): MoneyContext {
  let currencyCode: string | undefined;
  for (let index = lineIndex; index >= 0 && index >= lineIndex - 80; index--) {
    const line = lines[index];
    if (undefined === line) {
      continue;
    }

    currencyCode ??= getCurrencyCodeFromText(line);
    const scale = getMoneyScaleFromContextText(line);
    if (null !== scale) {
      return {
        currencyCode,
        scale,
      };
    }
  }

  return {
    currencyCode,
    scale: 1,
  };
}

function isNearTableNoteColumn(lines: string[], lineIndex: number): boolean {
  for (let index = lineIndex; index >= 0 && index >= lineIndex - 5; index--) {
    const line = lines[index];
    if (undefined !== line && /\bnote\b/i.test(line)) {
      return true;
    }
  }

  return false;
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

function getCurrencyCodeFromText(text: string): string | undefined {
  if (text.includes("€") || /\bEUR\b/i.test(text)) {
    return "EUR";
  }

  if (text.includes("£") || /\bGBP\b/i.test(text)) {
    return "GBP";
  }

  if (text.includes("¥") || /\bJPY\b/i.test(text)) {
    return "JPY";
  }

  if (text.includes("$") || /\bUSD\b/i.test(text) || /\bdollars?\b/i.test(text)) {
    return "USD";
  }

  return undefined;
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
  options: {
    maxAbsValue?: number;
    parseCents?: boolean;
    requireMoneyCue?: boolean;
    skipPercentages?: boolean;
    skipTableNoteRefs?: boolean;
  } = {},
): number | null {
  const numberMatches = text.matchAll(/\(?-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?/g);
  for (const numberMatch of numberMatches) {
    const token = numberMatch[0];
    const endIndex = numberMatch.index + token.length;
    if (true === options.skipPercentages && "%" === text.slice(endIndex, endIndex + 1)) {
      continue;
    }

    if (true === isCalendarDayValue(text, numberMatch.index, endIndex)) {
      continue;
    }

    const parsedNumber = parseNumber(token);
    const value = true === options.parseCents && null !== parsedNumber
      ? normalizeCentsValue(text, endIndex, token, parsedNumber)
      : parsedNumber;
    if (null === value) {
      continue;
    }

    if (true === options.requireMoneyCue &&
        false === hasMoneyCue(text, numberMatch.index, endIndex, token)) {
      continue;
    }

    if (true === options.skipTableNoteRefs &&
        true === isLikelyTableNoteReference(text, numberMatch.index, endIndex, token)) {
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

function normalizeCentsValue(text: string, endIndex: number, token: string, value: number): number {
  if (/[$€£¥]/.test(token) || Math.abs(value) < 1) {
    return value;
  }

  const afterToken = text.slice(endIndex, endIndex + 24);
  return /^\s*(?:cents?|¢|c\b)/i.test(afterToken)
    ? value / 100
    : value;
}

function isCalendarDayValue(text: string, startIndex: number, endIndex: number): boolean {
  const beforeToken = text.slice(Math.max(0, startIndex - 16), startIndex);
  const afterToken = text.slice(endIndex, endIndex + 8);
  return /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+$/i.test(beforeToken) &&
    /^\s*,?\s*(?:20\d{2})?\b/.test(afterToken);
}

function isLikelyTableNoteReference(text: string, startIndex: number, endIndex: number, token: string): boolean {
  if (!/^\(?-?\d{1,2}\)?$/.test(token.trim())) {
    return false;
  }

  if (true === hasMoneyCue(text, startIndex, endIndex, token)) {
    return false;
  }

  const beforeToken = text.slice(Math.max(0, startIndex - 16), startIndex);
  const afterToken = text.slice(endIndex, endIndex + 80);
  return /\|[\s|()–-]*$/.test(beforeToken) &&
    /^\s*(?:\||$)/.test(afterToken) &&
    /\d/.test(afterToken);
}

function hasMoneyCue(text: string, startIndex: number, endIndex: number, token: string): boolean {
  if (/[$€£¥]/.test(token)) {
    return true;
  }

  const beforeToken = text.slice(Math.max(0, startIndex - 8), startIndex);
  if (/[$€£¥][\s|()–-]*$/.test(beforeToken)) {
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
    .replace(/[$€£¥]/g, "")
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

export function formatEps(value: number, currencyCode = "USD"): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}${getCurrencySymbol(currencyCode)}${Math.abs(value).toFixed(2)}`;
}

export function formatUsdCompact(value: number): string {
  return formatMoneyCompact(value, "USD");
}

export function formatMoneyCompact(value: number, currencyCode = "USD"): string {
  const symbol = getCurrencySymbol(currencyCode);
  const absoluteValue = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absoluteValue >= 1_000_000_000_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000_000_000_000)}T`;
  }

  if (absoluteValue >= 1_000_000_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000_000_000)}B`;
  }

  if (absoluteValue >= 1_000_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000_000)}M`;
  }

  if (absoluteValue >= 1_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000)}K`;
  }

  return `${sign}${symbol}${formatDecimal(absoluteValue)}`;
}

function getCurrencySymbol(currencyCode: string): string {
  if ("EUR" === currencyCode) {
    return "€";
  }

  if ("GBP" === currencyCode) {
    return "£";
  }

  if ("JPY" === currencyCode) {
    return "¥";
  }

  return "$";
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
