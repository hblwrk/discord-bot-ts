import moment from "moment-timezone";
import {type EarningsEvent} from "./earnings.ts";
import {
  getCurrentPeriodColumnIndex,
  getMetricCandidateScore,
  getPositionedQuarterValues,
  hasGaapNarrativeBeforeAdjustment,
  isDefinitionalLine,
  isEmbeddedAlphaNumericValue,
  stripReferenceMarkers,
} from "./earnings-results-format-selection.ts";
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

type MetricLineSelection = {
  exclusive: boolean;
  lines: string[];
};

const discordBlankLineSpacer = "\u200B";

const earningsMetricDefinitions: MetricDefinition[] = [
  {
    key: "affo_per_share",
    label: "AFFO/share",
    patterns: [
      /\baffo\s+(?:and\s+affo\s+)?per\s+(?:common\s+)?share\b/i,
      /\badjusted\s+funds?\s+from\s+operations?\s+per\s+(?:common\s+)?share\b/i,
    ],
    valueType: "eps",
  },
  {
    key: "adjusted_eps",
    label: "Adj EPS",
    patterns: [
      /\badjusted\b(?:(?![.!?]\s)[^!?\n]){0,180}?(?<metricValue>-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+per\s+(?:common\s+)?(?:diluted\s+)?share(?:\s*[-–—]\s*diluted)?\b/i,
      /\badjusted\s+(?:\d{1,2}\s+)?(?:continuing(?:\s+operations?)?\s+)?(?:diluted\s+)?(?:earnings\s+per\s+(?:common\s+)?share|eps)\b/i,
      /\bnon-gaap\s+(?:fully\s+)?(?:diluted\s+)?eps\b/i,
      /\bnon-gaap\s+(?:diluted\s+)?(?:earnings\s+per\s+share|eps)\b/i,
      /\badjusted\s+profit\s+per\s+(?:common\s+)?share\b/i,
    ],
    // Guidance restates the same non-GAAP measure as a forward range, so without this
    // the low end of a full-year outlook is posted as the reported quarter.
    skipPattern: /\bguidance\b|\boutlook\b|\bforecast\b|\bexpects?\s+(?:non-gaap\s+)?(?:eps|adjusted)\b|\bto\s+be\s+(?:between|in\s+(?:a\s+)?range)\b/i,
    valueType: "eps",
  },
  {
    key: "gaap_eps",
    label: "EPS",
    patterns: [
      /\b(?:diluted\s+)?(?:earnings|net\s+income)\s+per\s+(?:common\s+)?share\b/i,
      /\b(?:earnings|profit|net\s+income)(?:\s*\/)?\s*\(loss(?:es)?\)\s+per\s+(?:common\s+|ordinary\s+)?share\b/i,
      /\bprofit\s+(?:\(loss\)\s+)?per\s+(?:common\s+|ordinary\s+)?(?:share|ADS)\b/i,
      /\bdiluted\s+eps\b/i,
      /\bgaap\s+(?:diluted\s+)?eps\b/i,
      /\b(?:reported\s+)?(?:net\s+)?earnings?\b(?:(?![.!?]\s)[^!?\n]){0,180}?(?<metricValue>-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+per\s+(?:common\s+)?(?:diluted\s+)?share(?:\s*[-–—]\s*diluted)?\b/i,
      /(?<metricValue>\(?-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?(?:\s*(?:cents?|¢))?)\s+per\s+(?:fully\s+)?(?:common\s+)?diluted\s+share\b/i,
      /\beps\b/i,
    ],
    skipPattern: /\badjusted\b|\bnon-gaap\b|\bguidance\b|\boutlook\b|\bforecast\b|\bexcept\s+(?:eps|per\s+share(?:\s+amounts?)?)\b/i,
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
    skipPattern: /\bcosts?\s+of\b|\bdeferred\b|\bunearned\b|\bguidance\b|\boutlook\b|\bsystemwide\s+sales\b|\b(?:U\.S\.|U\.K\.|US|international|domestic|non-US|segment)\s+(?:commercial\s+|government\s+)?revenues?\b|\bsince\s+(?:launch|inception)\b|\blife-to-date\b|\bcumulative\b|\bannuali[sz]ed\s+(?:revenue\s+)?run[-\s]*rate\b|\brevenue\s+run[-\s]*rate\b|\brevenue\s+\(expense\)|\bnon[-\s]insurance\s+warranty\s+revenue\b|\bnot\s+recognized\s+in\s+revenue\b|\bnon-cash\s+revenues?\b|\bsales\s+volumes?\b|\b(?:external\s+power|pipeline\s+gas|hydrocarbon|asset)\s+sales\b|\bproceeds\s+from\b|\bsales\s+of\s+pipeline\s+gas\b|\b(?:kbd|koebd|boepd|bpd|mboed|mmboe|bcfe|mmcf|mw|gw|kt)\b/i,
    valueType: "money",
  },
  {
    key: "net_income",
    label: "Net income",
    patterns: [
      /\bnet\s+income(?!\s+per\s+(?:common\s+)?share)\b/i,
      /\bnet\s+earnings(?!\s+per\s+(?:common\s+)?share)\b/i,
      /\bnet\s+\(loss(?:es)?\)\s+income\b/i,
      /\bnet\s+income\s*\/\s*\(loss(?:es)?\)(?!\s+per\s+(?:common\s+)?share)/i,
    ],
    // Skip income-statement subtotals, the noncontrolling-interest component and
    // reconciliation adjustment rows so the headline "net income/earnings attributable
    // to <company>" row wins rather than "net earnings before income tax", "net
    // earnings including NCI" or "increase to net loss / decrease to net income".
    skipPattern: /\beps\b|\bbefore\s+(?:income\s+)?tax(?:es)?\b|\b(?:including|attributable\s+to)\s+noncontrolling\b|\b(?:increase|decrease)\s+to\s+net\b/i,
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
    skipPattern: /\b(?:capacity|startup|on\s+plan|guidance|outlook|forecast)\b/i,
    valueType: "number",
  },
];
export function parseEarningsDocument(html: string): ParsedEarningsDocument {
  const text = htmlToText(html);
  const lines = getMeaningfulLines(text);
  const quarterLabel = getQuarterLabel(text);
  const documentCurrencyCode = getDocumentCurrencyCode(lines);
  return {
    headline: getDocumentHeadline(lines),
    metrics: extractEarningsMetrics(lines, quarterLabel, documentCurrencyCode),
    outlook: extractOutlookMetrics(lines, documentCurrencyCode),
    quarterLabel,
  };
}

function getDocumentCurrencyCode(lines: string[]): string | undefined {
  const headerLines = lines.slice(0, 60);
  const currencyDeclaration = headerLines
    .find(line => /\b(?:Canadian|New Taiwan|U\.S\.)\s+dollars?\b|\b(?:CAD|TWD|NTD|USD|EUR|GBP|JPY)\b|NT\s*\$/i.test(line));
  if (undefined !== currencyDeclaration) {
    return getDominantCurrencyCode(currencyDeclaration) ??
      getCurrencyCodeFromText(currencyDeclaration);
  }

  // A non-dollar reporting currency is often declared only as a column scale ("(€M)",
  // "(in € millions)"). It still governs statement rows that carry no symbol of their
  // own, which would otherwise be rendered as dollars.
  const scaleSymbolDeclaration = headerLines.find(line =>
    /\(\s*[€£¥]\s*(?:M|B|K|millions?|billions?|thousands?)\b/i.test(line) ||
    /\bin\s+[€£¥]\s*(?:millions?|billions?|thousands?)\b/i.test(line));
  return undefined === scaleSymbolDeclaration
    ? undefined
    : getCurrencyCodeFromText(scaleSymbolDeclaration);
}

// An inline-XBRL context header lists every unit the filing references
// ("iso4217:USD ... iso4217:EUR ... iso4217:USD"), so the reporting currency is the one
// named most often rather than whichever is checked first.
function getDominantCurrencyCode(text: string): string | undefined {
  const declaredCodes = [...text.matchAll(/\biso4217:([A-Z]{3})\b/g)]
    .map(codeMatch => codeMatch[1] ?? "");
  if (2 > declaredCodes.length) {
    return undefined;
  }

  const countByCode = new Map<string, number>();
  for (const code of declaredCodes) {
    countByCode.set(code, (countByCode.get(code) ?? 0) + 1);
  }

  let dominantCode: string | undefined;
  let dominantCount = 0;
  for (const [code, count] of countByCode) {
    if (count > dominantCount) {
      dominantCode = code;
      dominantCount = count;
    }
  }

  return dominantCode;
}

export function getMessageMetrics(
  secMetrics: EarningsResultMetric[],
  surprise: NasdaqSurprise | null,
  _event: EarningsEvent,
): EarningsResultMetric[] {
  const metrics = dropImplausibleMoneyMetrics(
    normalizeEpsMetrics([...secMetrics]),
    surprise,
  );
  const epsMetric = getProviderMatchedEpsMetric(metrics, surprise);
  if (epsMetric &&
      "number" === typeof surprise?.consensusEps &&
      true === canCompareAgainstUsdEstimate(epsMetric)) {
    epsMetric.estimate = formatEps(surprise.consensusEps);
    epsMetric.outcome = getOutcome(epsMetric.numericValue, surprise.consensusEps);
  }

  const revenueMetric = metrics.find(metric => "revenue" === metric.key);
  if (revenueMetric &&
      true === isProviderMatchedMetric(revenueMetric.numericValue, surprise?.actualRevenue, "money") &&
      "number" === typeof surprise?.consensusRevenue &&
      true === canCompareAgainstUsdEstimate(revenueMetric)) {
    revenueMetric.estimate = formatUsdCompact(surprise.consensusRevenue);
    revenueMetric.outcome = getOutcome(revenueMetric.numericValue, surprise.consensusRevenue);
  }

  return metrics.slice(0, 7);
}

// Plausibility guard: a company that reports per-share earnings has enough shares
// outstanding that its aggregate revenue and net income are at least in the millions.
// A sub-$1M revenue/net-income figure alongside a real EPS is therefore a scale or
// parse error (e.g. a dropped "(in millions)" header rendering "$903" for $903M), so
// omit it rather than post a wrong number.
function dropImplausibleMoneyMetrics(
  metrics: EarningsResultMetric[],
  surprise: NasdaqSurprise | null,
): EarningsResultMetric[] {
  const hasPlausibleEps =
    ("number" === typeof surprise?.actualEps && 0.01 <= Math.abs(surprise.actualEps)) ||
    metrics.some(metric => isEpsMetricKey(metric.key) &&
      "number" === typeof metric.numericValue &&
      Number.isFinite(metric.numericValue) &&
      0.01 <= Math.abs(metric.numericValue));
  if (false === hasPlausibleEps) {
    return metrics;
  }

  return metrics.filter(metric => {
    if (false === ("revenue" === metric.key || "net_income" === metric.key)) {
      return true;
    }

    return false === ("number" === typeof metric.numericValue &&
      Number.isFinite(metric.numericValue) &&
      Math.abs(metric.numericValue) < 1_000_000);
  });
}

function isEpsMetricKey(key: string): boolean {
  return "affo_per_share" === key ||
    "adjusted_eps" === key ||
    "gaap_eps" === key ||
    "nasdaq_eps" === key;
}

function canCompareAgainstUsdEstimate(metric: EarningsResultMetric): boolean {
  return undefined === metric.currencyCode || "USD" === metric.currencyCode;
}

function normalizeEpsMetrics(
  metrics: EarningsResultMetric[],
): EarningsResultMetric[] {
  const adjustedEpsMetric = metrics.find(metric => "adjusted_eps" === metric.key);
  const gaapEpsMetric = metrics.find(metric => "gaap_eps" === metric.key);

  if (adjustedEpsMetric &&
      gaapEpsMetric &&
      true === isImplausibleSecondaryGaapEps(gaapEpsMetric.numericValue, adjustedEpsMetric.numericValue)) {
    return metrics.filter(metric => "gaap_eps" !== metric.key);
  }

  return metrics;
}

function getProviderMatchedEpsMetric(
  metrics: EarningsResultMetric[],
  surprise: NasdaqSurprise | null,
): EarningsResultMetric | undefined {
  return metrics
    .filter(metric => true === isEpsMetricKey(metric.key))
    .find(metric => true === isProviderMatchedMetric(
      metric.numericValue,
      surprise?.actualEps,
      "eps",
    ));
}

function isProviderMatchedMetric(
  filingValue: number | undefined,
  providerValue: number | undefined,
  valueType: "eps" | "money",
): boolean {
  if ("number" !== typeof filingValue ||
      "number" !== typeof providerValue ||
      false === Number.isFinite(filingValue) ||
      false === Number.isFinite(providerValue)) {
    return false;
  }

  const largestValue = Math.max(Math.abs(filingValue), Math.abs(providerValue));
  const tolerance = "eps" === valueType
    ? Math.max(0.02, largestValue * 0.005)
    : Math.max(1_000_000, largestValue * 0.005);
  return Math.abs(filingValue - providerValue) <= tolerance;
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
      const metricLabel = metric.periodLabel
        ? `${metric.periodLabel} ${metric.label}`
        : metric.label;
      lines.push(`- **${metricLabel}:** ${formatOutlookValue(metric.value)}`);
    }
  }

  if (undefined !== summary && "" !== summary.trim()) {
    if (1 < lines.length) {
      lines.push("");
    }
    lines.push(`📝 ${summary.trim()}`);
  }

  lines.push(discordBlankLineSpacer);

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
    quantitativeTokenPattern,
    token => formatInlineCode(token.trim()),
  );
}

const quantitativeValuePattern = String.raw`-?(?:[$€£¥]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:trillion|billions?|millions?|thousands?|tn|bn|mm|[tbmk]|kbd|koebd|boepd|bpd|mmboe|bcfe|mmcf|mw|gw)\b|\s*%)?`;
const quantitativeTokenPattern = new RegExp(`${quantitativeValuePattern}(?:\\s*(?:-|–|—)\\s*${quantitativeValuePattern})?`, "gi");

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
    .map(line => stripReferenceMarkers(line).replace(/\s*\|\s*/g, " | ").replace(/\s+/g, " ").trim())
    .filter(line => line.length >= 3);
}

function getDocumentHeadline(lines: string[]): string | undefined {
  return lines.find(line => /earnings|results|reports|announces/i.test(line) && line.length <= 180);
}

function getQuarterLabel(text: string): string | undefined {
  const fiscalQuarterMatch = text.match(/\b(Q[1-4])\s+(?:fiscal\s+year|FY|FYE)\s*(20\d{2}|\d{2})\b/i);
  if (undefined !== fiscalQuarterMatch?.[1] && undefined !== fiscalQuarterMatch[2]) {
    return `${fiscalQuarterMatch[1].toUpperCase()} ${normalizeFiscalYear(fiscalQuarterMatch[2])}`;
  }

  const ordinalQuarterMatch = text.match(/\b([1-4])\s*(?:st|nd|rd|th)\s+quarter\s+(20\d{2})\b/i);
  if (undefined !== ordinalQuarterMatch?.[1] && undefined !== ordinalQuarterMatch[2]) {
    return `Q${ordinalQuarterMatch[1]} ${ordinalQuarterMatch[2]}`;
  }

  const writtenFiscalQuarterMatch = text.match(/\b(first|second|third|fourth)[\s–—-]+quarter(?:\s+and\s+full)?\s+(?:fiscal\s+year|FY)\s*(20\d{2}|\d{2})\b/i);
  if (undefined !== writtenFiscalQuarterMatch?.[1] && undefined !== writtenFiscalQuarterMatch[2]) {
    const quarter = getQuarterFromName(writtenFiscalQuarterMatch[1]);
    if (quarter) {
      return `${quarter} ${normalizeFiscalYear(writtenFiscalQuarterMatch[2])}`;
    }
  }

  const namedPeriodEndedQuarter = getNamedQuarterLabelFromPeriodEnded(text);
  if (undefined !== namedPeriodEndedQuarter) {
    return namedPeriodEndedQuarter;
  }

  const writtenQuarterMatch = text.match(/\b(first|second|third|fourth)[\s–—-]+quarter\s+(?:of\s+)?(20\d{2})\b/i);
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

function getNamedQuarterLabelFromPeriodEnded(text: string): string | undefined {
  const namedPeriodEndedMatch = text.match(
    /\b(first|second|third|fourth)[\s–—-]+quarter\s+ended\s+[A-Z][a-z]+\s+\d{1,2},\s+(20\d{2})\b/i,
  );
  if (undefined === namedPeriodEndedMatch?.[1] || undefined === namedPeriodEndedMatch[2]) {
    return undefined;
  }

  const quarter = getQuarterFromName(namedPeriodEndedMatch[1]);
  return quarter ? `${quarter} ${namedPeriodEndedMatch[2]}` : undefined;
}

function normalizeFiscalYear(value: string): string {
  return 2 === value.length ? `20${value}` : value;
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

function extractEarningsMetrics(
  lines: string[],
  quarterLabel: string | undefined,
  documentCurrencyCode: string | undefined,
): EarningsResultMetric[] {
  const metrics: EarningsResultMetric[] = [];
  const seenKeys = new Set<string>();
  const preferredSelection = getQuarterSpecificMetricLines(lines);

  for (const definition of earningsMetricDefinitions) {
    if (true === seenKeys.has(definition.key)) {
      continue;
    }

    const preferredMetric = extractMetric(
      preferredSelection.lines,
      definition,
      quarterLabel,
      documentCurrencyCode,
    );
    const metric = preferredMetric ?? (true === preferredSelection.exclusive
      ? null
      : extractMetric(lines, definition, quarterLabel, documentCurrencyCode));
    if (null === metric) {
      continue;
    }

    metrics.push(metric);
    seenKeys.add(metric.key);
  }

  return metrics;
}

function getQuarterSpecificMetricLines(lines: string[]): MetricLineSelection {
  const startIndex = lines.findIndex(line =>
    isQuarterSpecificSectionLine(line) || isMixedMonthQuarterResultsLine(line));
  if (-1 === startIndex) {
    return {
      exclusive: false,
      lines: [],
    };
  }

  const exclusive = isMixedMonthQuarterResultsLine(lines[startIndex] ?? "");
  const selectedLines: string[] = [];
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (undefined === line) {
      continue;
    }

    if (index > startIndex &&
        (true === isQuarterSpecificSectionBoundary(line) ||
        (true === exclusive && true === isMixedMonthQuarterSectionBoundary(line)))) {
      break;
    }

    selectedLines.push(line);
    if (selectedLines.length >= 16) {
      break;
    }
  }

  return {
    exclusive,
    lines: [...getGoverningScaleDeclarations(lines, startIndex), ...selectedLines],
  };
}

// The unit declaration governing a section's figures ("$ in millions") usually sits above
// the section heading. Selecting the section alone hides it, and every money value in the
// window is then read at face value — a $16.6B quarter rendered as $16.61K.
function getGoverningScaleDeclarations(lines: string[], startIndex: number): string[] {
  for (let index = startIndex - 1; index >= 0 && index >= startIndex - 40; index--) {
    const line = lines[index];
    if (undefined !== line && null !== getMoneyScaleFromContextText(line)) {
      return [line];
    }
  }

  return [];
}

function isMixedMonthQuarterResultsLine(line: string): boolean {
  return /\bmonth\s+and\s+quarter\s+ended\b/i.test(line) ||
    /\bquarter\s+and\s+month\s+ended\b/i.test(line);
}

function isMixedMonthQuarterSectionBoundary(line: string): boolean {
  return /^\s*(?:the\s+)?(?:comprehensive|consolidated)\s+(?:comprehensive\s+)?(?:income\s+)?statements?\b/i.test(line) ||
    /^\s*for\s+the\s+(?:month|year-to-date)\b/i.test(line);
}

function isQuarterSpecificSectionLine(line: string): boolean {
  if (/\b(?:guidance|outlook|forecast)\b/i.test(line)) {
    return false;
  }

  return /^\s*(?:for\s+)?Q[1-4]\s+(?:(?:fiscal\s+year|FY|FYE)\s*)?(?:20\d{2}|\d{2})(?:\s+(?:financial\s+overview|results?(?:\s+summary)?|earnings))?\s*:?$/i.test(line) ||
    /^\s*(?:for\s+)?(?:the\s+)?(?:first|second|third|fourth)[\s–—-]+quarter(?:\s+(?:of\s+)?(?:(?:fiscal\s+year|FY)\s*)?(?:20\d{2}|\d{2}))?(?:\s+(?:financial\s+overview|results?(?:\s+summary)?|earnings))?\s*:?$/i.test(line);
}

function isQuarterSpecificSectionBoundary(line: string): boolean {
  return /^\s*(?:outlook|guidance|financial\s+outlook|business\s+outlook|use\s+of\s+non-gaap|forward-looking|supplemental\s+financial\s+information)\b/i.test(line) ||
    /^\s*(?:the\s+)?company\s+(?:raises?|updates?|reaffirms?|provides?|issues?)\b.*\b(?:guidance|outlook)\b/i.test(line) ||
    /^\s*(?:fiscal\s+year|FY|FYE)\s*(?:20\d{2}|\d{2})\b/i.test(line) ||
    /^\s*for\s+fiscal\s+year\s+(?:20\d{2}|\d{2})\s*:?$/i.test(line);
}

function extractMetric(
  lines: string[],
  definition: MetricDefinition,
  quarterLabel: string | undefined,
  documentCurrencyCode: string | undefined,
): EarningsResultMetric | null {
  let bestCandidate: {metric: EarningsResultMetric; score: number} | null = null;
  for (const [lineIndex, line] of lines.entries()) {
    if (true === isDefinitionalLine(line)) {
      continue;
    }

    const hasExplicitGaapEps = "gaap_eps" === definition.key &&
      /\bgaap\s+(?:diluted\s+)?eps\b/i.test(line);
    const hasReportedGaapEps = "gaap_eps" === definition.key &&
      true === hasGaapNarrativeBeforeAdjustment(line, definition.patterns);
    if (definition.skipPattern?.test(line) &&
        false === hasExplicitGaapEps &&
        false === hasReportedGaapEps) {
      continue;
    }

    if ("net_income" === definition.key && true === isPerShareOnlyNetIncomeLine(line)) {
      continue;
    }

    const hasMetricLabel = definition.patterns.some(pattern => pattern.test(line));
    if (false === hasMetricLabel) {
      continue;
    }

    const metricLine = getMetricLineWithContinuation(lines, lineIndex, definition, quarterLabel);
    const pattern = definition.patterns.find(candidatePattern => candidatePattern.test(metricLine));
    if (!pattern) {
      continue;
    }

    const metricValue = extractMetricValue(
      metricLine,
      pattern,
      definition.valueType,
      getContextMoney(lines, lineIndex, documentCurrencyCode),
      isNearTableNoteColumn(lines, lineIndex),
      undefined !== quarterLabel && hasMixedMonthQuarterColumns(lines, lineIndex),
      getCurrentPeriodColumnIndex(lines, lineIndex, quarterLabel),
    );
    if (null === metricValue) {
      continue;
    }

    const metric: EarningsResultMetric = {
      currencyCode: metricValue.currencyCode,
      key: definition.key,
      label: definition.label,
      numericValue: metricValue.numericValue,
      value: metricValue.value,
    };
    Object.defineProperty(metric, "sourceSnippet", {
      configurable: false,
      enumerable: false,
      value: metricLine,
      writable: false,
    });
    const score = getMetricCandidateScore({
      lines,
      lineIndex,
      metricLine,
      pattern,
      quarterLabel,
      valueType: definition.valueType,
    });
    if (null === bestCandidate || score > bestCandidate.score) {
      bestCandidate = {metric, score};
    }
  }

  return bestCandidate?.metric ?? null;
}

function isPerShareOnlyNetIncomeLine(line: string): boolean {
  const hasCombinedAggregateLabel =
    /\bnet\s+income\b.*\band\b.*\bnet\s+income\s+per\s+(?:common\s+|diluted\s+)?share\b/i.test(line);
  return /\bper\s+(?:common\s+|diluted\s+)?share\b/i.test(line) &&
    false === hasCombinedAggregateLabel &&
    false === /\b(?:trillion|billion|million|thousand)s?\b/i.test(line);
}

function getMetricLineWithContinuation(
  lines: string[],
  lineIndex: number,
  definition: MetricDefinition,
  quarterLabel: string | undefined,
): string {
  const baseLine = lines[lineIndex] ?? "";
  const positionedQuarterValues = getPositionedQuarterValues(
    lines,
    lineIndex,
    quarterLabel,
  );
  if (0 < positionedQuarterValues.length) {
    return [baseLine, ...positionedQuarterValues].join(" ");
  }

  const metricLines = [baseLine];
  const isSummaryHeading = isSummaryMetricHeading(baseLine, definition);
  // A per-share block spans a basic and a diluted row of several period columns, each
  // rendered as its own line; stopping too early truncates the diluted row and leaves
  // only the basic figure to read.
  const continuationLimit = "eps" === definition.valueType ? 12 : 6;
  for (let index = lineIndex + 1; index < lines.length && index <= lineIndex + continuationLimit; index++) {
    const nextLine = lines[index];
    if (undefined === nextLine) {
      break;
    }

    if (true === isValueOnlyLine(nextLine) ||
        true === isPerShareMetricDetailLine(baseLine, nextLine)) {
      metricLines.push(nextLine);
      continue;
    }

    if (false === isSummaryHeading || true === isSummaryMetricHeadingLine(nextLine)) {
      break;
    }

    if ("money" === definition.valueType && true === isNarrativeMoneyDetailLine(nextLine)) {
      metricLines.push(nextLine);
      break;
    }

    if ("eps" === definition.valueType) {
      if (true === isNarrativePerShareDetailLine(nextLine)) {
        metricLines.push(nextLine);
        break;
      }

      if (true === isNarrativeMoneyDetailLine(nextLine)) {
        continue;
      }
    }

    break;
  }

  return metricLines.join(" ");
}

function isSummaryMetricHeading(line: string, definition: MetricDefinition): boolean {
  return line.length <= 180 &&
    false === /[$€£¥]|\b\d+(?:[.,]\d+)?\b/.test(line) &&
    definition.patterns.some(pattern => pattern.test(line));
}

function isSummaryMetricHeadingLine(line: string): boolean {
  if (line.length > 180 || /[$€£¥]|\b\d+(?:[.,]\d+)?\b/.test(line)) {
    return false;
  }

  return earningsMetricDefinitions.some(definition =>
    definition.patterns.some(pattern => pattern.test(line))) ||
    /\b(?:adjusted\s+ebitda|operating\s+income)\b/i.test(line);
}

function isNarrativeMoneyDetailLine(line: string): boolean {
  return /^\s*(?:[•◦▪–—-]\s*)?(?:\(?\s*)?(?:[$€£¥]\s*)?-?\d/i.test(line) &&
    /[$€£¥]|\b(?:trillion|billion|million|thousand)s?\b|\b(?:tn|bn|mm|[tbmk])\b/i.test(line);
}

function isNarrativePerShareDetailLine(line: string): boolean {
  return /^\s*(?:[•◦▪–—-]\s*)?(?:\(?\s*)?(?:[$€£¥]\s*)?-?\d/i.test(line) &&
    /\b(?:per\s+(?:common\s+)?share|eps|cents?)\b/i.test(line);
}

// Summary tables mark not-meaningful comparisons with "*", "--" or a bare "%", so those
// cells must not end the run of value cells belonging to the label above.
function isValueOnlyLine(line: string): boolean {
  return /^[\s|$€£¥(),.\-*\d%—–]+$/.test(line);
}

function isPerShareMetricDetailLine(baseLine: string, line: string): boolean {
  if (false === /\bper\s+(?:common\s+|ordinary\s+)?share\b/i.test(baseLine)) {
    return false;
  }

  // A label wrapped across table cells leaves its tail word ahead of the value columns
  // ("... per share attributable to owners of the" / "parent Basic 2.65 ... Diluted 2.61"),
  // so the per-share row is only reachable by joining the orphaned continuation.
  return /^\s*(?:basic|diluted)\b/i.test(line) ||
    /^\s*[A-Za-z]{1,12}\s+(?:basic|diluted)\b/i.test(line);
}

function extractMetricValue(
  line: string,
  pattern: RegExp,
  valueType: MetricValueType,
  contextMoney: MoneyContext,
  skipTableNoteRefs: boolean,
  preferQuarterColumn: boolean,
  currentPeriodColumnIndex: number,
): {currencyCode?: string | undefined; numericValue: number; value: string} | null {
  // Narrative prose states the reported figure first, whatever the surrounding table
  // layout is, so only rows with explicit value cells are read by column. A basic or
  // diluted per-share segment is a column run by construction and is always read by
  // column, which is what makes prior-year-first statements resolve correctly.
  const columnIndex = 2 <= (line.match(/\|/g)?.length ?? 0) ? currentPeriodColumnIndex : 0;
  pattern.lastIndex = 0;
  const patternMatch = pattern.exec(line);
  const capturedMetricValue = patternMatch?.groups?.["metricValue"];
  const searchText = capturedMetricValue ??
    (patternMatch ? line.slice(patternMatch.index + patternMatch[0].length) : line);
  const preferredSearchText = true === preferQuarterColumn
    ? getQuarterColumnSearchText(searchText)
    : searchText;
  const fallbackSearchText = patternMatch ? line.slice(0, patternMatch.index) : "";

  if ("eps" === valueType) {
    const perShareTableValue = findPerShareTableValue(preferredSearchText, currentPeriodColumnIndex);
    const preferredValue = findEpsValue(preferredSearchText, columnIndex);
    const fallbackValue = true === isMetricValuePrefix(fallbackSearchText)
      ? findEpsValue(fallbackSearchText, columnIndex)
      : null;
    const value = perShareTableValue ?? preferredValue ?? fallbackValue;
    if (null === value) {
      return null;
    }

    const metricText = null === perShareTableValue && null === preferredValue
      ? fallbackSearchText
      : preferredSearchText;
    const currencyCode = getCurrencyCodeFromText(metricText, contextMoney.currencyCode) ?? contextMoney.currencyCode;
    return {
      currencyCode,
      numericValue: value,
      value: formatEps(value, currencyCode),
    };
  }

  if ("money" === valueType) {
    const sentenceSearchText = getMetricValueSentenceText(preferredSearchText);
    const hasMetricLabelSuffixTableNote = isMetricLabelSuffixTableNote(sentenceSearchText);
    const searchValueMatch = true === hasMetricLabelSuffixTableNote ? null : findColumnValueMatch(sentenceSearchText, {
      minUncuedAbsValue: 10,
      requireMoneyCue: 1 === contextMoney.scale,
      skipTableNoteRefs,
      skipPercentages: true,
    }, columnIndex);
    const fallbackValueMatch = true === isMetricValuePrefix(fallbackSearchText) ? findNumericValueMatch(fallbackSearchText, {
      minUncuedAbsValue: 10,
      requireMoneyCue: 1 === contextMoney.scale,
      skipTableNoteRefs,
      skipPercentages: true,
    }) : null;
    const useFallbackValue = null !== fallbackValueMatch &&
      (null === searchValueMatch || true === hasMetricLabelSuffixTableNote);
    const parsedValueMatch = true === useFallbackValue
      ? fallbackValueMatch
      : searchValueMatch ?? fallbackValueMatch;
    if (null === parsedValueMatch) {
      return null;
    }

    const metricText = true === useFallbackValue ? fallbackSearchText : sentenceSearchText;
    const explicitScale = getExplicitMoneyScale(metricText, parsedValueMatch.endIndex);
    const currencyCode = getCurrencyCodeFromText(metricText, contextMoney.currencyCode) ?? contextMoney.currencyCode;
    const amount = parsedValueMatch.value * (explicitScale ?? contextMoney.scale);
    const maximumFractionDigits = getMoneyDisplayPrecision(
      metricText,
      parsedValueMatch.endIndex,
      explicitScale,
    );
    return {
      currencyCode,
      numericValue: amount,
      value: formatMoneyCompact(amount, currencyCode, maximumFractionDigits),
    };
  }

  const value = findNumericValue(preferredSearchText, {skipPercentages: true}) ??
    (true === isMetricValuePrefix(fallbackSearchText) ? findNumericValue(fallbackSearchText, {skipPercentages: true}) : null);
  if (null === value) {
    return null;
  }

  const trailingUnit = getTrailingUnit(preferredSearchText);
  if (null === trailingUnit) {
    return null;
  }

  return {
    numericValue: value,
    value: formatPlainNumber(value, trailingUnit),
  };
}

// A metric value must be in the same sentence as its label. Otherwise prose such
// as "162% of net earnings. During the quarter, the company paid $429 million in
// dividends" can mislabel the next sentence's first dollar amount as net income.
// Table rows remain intact because their label/value cells are separated by pipes,
// not sentence-ending punctuation followed by a new sentence.
function getMetricValueSentenceText(text: string): string {
  const boundaryMatch = /[.!?]\s+(?=[A-Z\d$€£¥])/u.exec(text);
  if (undefined === boundaryMatch?.index) {
    return text;
  }

  return text.slice(0, boundaryMatch.index + 1);
}

function hasMixedMonthQuarterColumns(lines: string[], lineIndex: number): boolean {
  const context = lines
    .slice(Math.max(0, lineIndex - 8), lineIndex + 1)
    .join(" ");
  const hasMonth = /\b(?:month|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(context);
  return hasMonth && /\bquarter\b/i.test(context) && /\bchange\b/i.test(context);
}

function getQuarterColumnSearchText(text: string): string {
  const groupBoundary = /\|\s*(?:%|NM|N\/A|N\.M\.)\s*\|/i.exec(text);
  if (undefined === groupBoundary?.index) {
    return text;
  }

  return text.slice(groupBoundary.index + groupBoundary[0].length);
}

function findEpsValue(text: string, columnIndex: number): number | null {
  const options = {
    maxAbsValue: 100,
    parseCents: true,
    skipPercentages: true,
  };
  const currencyValue = findPlausibleEpsValue(text, {
    ...options,
    requireMoneyCue: true,
  }, columnIndex);
  if (null !== currencyValue) {
    return currencyValue;
  }

  return true === isMetricLabelSuffixTableNote(text)
    ? null
    : findPlausibleEpsValue(text, options, columnIndex);
}

// Filings quote per-share amounts to the cent, so a fractional value in a per-share
// position is the figure. A large whole number there is an aggregate numerator from a
// reconciliation row ("... per share | Net income | 545 | 721 | (86)") or a leftover
// marker, and publishing it would misstate EPS by orders of magnitude.
function findPlausibleEpsValue(
  text: string,
  options: NumericValueOptions,
  columnIndex: number,
): number | null {
  const values = findNumericValues(text, options);
  const columnValue = values[columnIndex];
  if ("number" === typeof columnValue && false === Number.isInteger(columnValue)) {
    return columnValue;
  }

  return values.find(value => false === Number.isInteger(value)) ??
    values.find(value => Math.abs(value) < 20) ??
    null;
}

function findPerShareTableValue(text: string, columnIndex: number): number | null {
  const hasTableSegments = /\bBasic\b/i.test(text) || 2 <= (text.match(/\|/g)?.length ?? 0);
  if (false === hasTableSegments) {
    return null;
  }

  return getPerShareSegmentValue(text, "Diluted", columnIndex) ??
    getPerShareSegmentValue(text, "Basic", columnIndex);
}

// Read the reported period's cell out of the per-share row. Remaining cells are the
// prior-year quarter, the year-to-date pair and sometimes percentage changes.
function getPerShareSegmentValue(
  text: string,
  label: "Basic" | "Diluted",
  columnIndex: number,
): number | null {
  const segmentMatch = new RegExp(`\\b${label}\\b([\\s\\S]*?)(?:\\b(?:Basic|Diluted|Weighted-average)\\b|$)`, "i")
    .exec(text);
  const segment = segmentMatch?.[1];
  if (undefined === segment) {
    return null;
  }

  const values = findNumericValues(segment, {
    maxAbsValue: 100,
    parseCents: true,
    skipPercentages: true,
  });
  return values[columnIndex] ?? values[0] ?? null;
}

function getContextMoney(
  lines: string[],
  lineIndex: number,
  documentCurrencyCode: string | undefined,
): MoneyContext {
  const currencyCode = documentCurrencyCode;
  // Scan upward for the nearest "in millions / $ in thousands / ..." declaration
  // governing this row. Income statements interleave many empty separator rows
  // ("| |") between the unit header and the figures, so the lookback budget is
  // spent on content (letter-bearing) lines only — otherwise a header a few real
  // rows up but 100+ separator rows away is missed and the scale wrongly defaults
  // to 1 (rendering e.g. "$903" instead of "$903M").
  let contentLinesScanned = 0;
  for (let index = lineIndex; index >= 0 && contentLinesScanned <= 80; index--) {
    const line = lines[index];
    if (undefined === line) {
      continue;
    }

    const scale = getMoneyScaleFromContextText(line);
    if (null !== scale) {
      // Take the currency from the unit declaration that governs this table ("$ million",
      // "in € millions"). Reading it from any line scanned on the way up lets an incidental
      // prose mention — a euro-denominated bond redemption in a dollar-reporting filer —
      // relabel every figure below it.
      return {
        currencyCode: getCurrencyCodeFromText(line, currencyCode) ?? currencyCode,
        scale,
      };
    }

    if (/[A-Za-z]/.test(line)) {
      contentLinesScanned++;
    }
  }

  return {
    currencyCode,
    scale: 1,
  };
}

function isMetricLabelSuffixTableNote(text: string): boolean {
  return /^\s*\(?\d{1,2}\)?\s*$/.test(text);
}

function isMetricValuePrefix(text: string): boolean {
  const valuePrefix = text.replace(/\b(?:basic|diluted)\s*$/i, "");
  return "" !== valuePrefix.trim() && false === /[A-Za-z]/.test(valuePrefix);
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
  // Match a column/table-scale declaration ("(in millions)", "$ in thousands",
  // "($ millions)", "millions of dollars") but NOT an inline prose magnitude such
  // as "Operating Profit of $1,407 million" — there a digit immediately precedes
  // the unit, and that figure belongs to one line, not the whole table. Treating
  // inline magnitudes as a table scale mis-scales unrelated rows.
  const declarationMatch =
    /(?:\bin\s+|[$€£¥]\s*,?\s*)(thousand|million|billion)s?\b/i.exec(text) ??
    /\b(thousand|million|billion)s?\s+of\s+dollars\b/i.exec(text) ??
    /\(\s*(thousand|million|billion)s?\b/i.exec(text);
  const unit = declarationMatch?.[1]?.toLowerCase();
  if ("thousand" === unit) {
    return 1_000;
  }

  if ("million" === unit) {
    return 1_000_000;
  }

  if ("billion" === unit) {
    return 1_000_000_000;
  }

  return null;
}

function getCurrencyCodeFromText(
  text: string,
  dollarCurrencyCode = "USD",
): string | undefined {
  if (/NT\s*\$|\b(?:TWD|NTD)\b|\bNew Taiwan dollars?\b/i.test(text)) {
    return "TWD";
  }

  if (/(?:^|[^A-Za-z])C\s*\$/.test(text) || /\bCAD\b|\bCanadian dollars?\b/i.test(text)) {
    return "CAD";
  }

  if (text.includes("€") || /\bEUR\b/i.test(text)) {
    return "EUR";
  }

  if (text.includes("£") || /\bGBP\b/i.test(text)) {
    return "GBP";
  }

  if (text.includes("¥") || /\bJPY\b/i.test(text)) {
    return "JPY";
  }

  if (/US\s*\$|\bUSD\b|\bU\.S\. dollars?\b/i.test(text)) {
    return "USD";
  }

  if (text.includes("$")) {
    return dollarCurrencyCode;
  }

  return undefined;
}

function getExplicitMoneyScale(text: string, valueEndIndex: number): number | null {
  const afterValue = text.slice(valueEndIndex, valueEndIndex + 24);
  const unitMatch = afterValue.match(/^\s*(trillion|trillions|tn|billion|billions|bn|million|millions|mm|thousand|thousands|[kmbt])\b/i);
  const unit = unitMatch?.[1]?.toLowerCase();
  if (!unit) {
    return null;
  }

  if ("trillion" === unit || "trillions" === unit || "tn" === unit || "t" === unit) {
    return 1_000_000_000_000;
  }

  if ("billion" === unit || "billions" === unit || "bn" === unit || "b" === unit) {
    return 1_000_000_000;
  }

  if ("thousand" === unit || "thousands" === unit || "k" === unit) {
    return 1_000;
  }

  return 1_000_000;
}

function getMoneyDisplayPrecision(
  text: string,
  valueEndIndex: number,
  explicitScale: number | null,
): number {
  if (null === explicitScale) {
    return 2;
  }

  const valuePrefix = text.slice(0, valueEndIndex);
  const fractionDigits = /\.(\d+)\s*\)?$/.exec(valuePrefix)?.[1]?.length ?? 0;
  return Math.min(3, Math.max(2, fractionDigits));
}

type NumericValueOptions = {
  maxAbsValue?: number;
  minUncuedAbsValue?: number;
  parseCents?: boolean;
  requireMoneyCue?: boolean;
  skipPercentages?: boolean;
  skipTableNoteRefs?: boolean;
};

type NumericValueMatch = {
  endIndex: number;
  value: number;
};

function findNumericValue(
  text: string,
  options: NumericValueOptions = {},
): number | null {
  return findNumericValueMatch(text, options)?.value ?? null;
}

function findNumericValueMatch(
  text: string,
  options: NumericValueOptions = {},
): NumericValueMatch | null {
  return findNumericValueMatches(text, options)[0] ?? null;
}

function findColumnValueMatch(
  text: string,
  options: NumericValueOptions,
  columnIndex: number,
): NumericValueMatch | null {
  const matches = findNumericValueMatches(text, options);
  return matches[columnIndex] ?? matches[0] ?? null;
}

function findNumericValues(
  text: string,
  options: NumericValueOptions = {},
): number[] {
  return findNumericValueMatches(text, options).map(match => match.value);
}

function findNumericValueMatches(
  text: string,
  options: NumericValueOptions = {},
): NumericValueMatch[] {
  const values: NumericValueMatch[] = [];
  const numberMatches = text.matchAll(/\(?-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?/g);
  for (const numberMatch of numberMatches) {
    const token = numberMatch[0];
    const endIndex = numberMatch.index + token.length;
    if (true === isEmbeddedAlphaNumericValue(text, numberMatch.index, endIndex)) {
      continue;
    }

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

    // A tiny number with no money cue ($, explicit unit) next to a metric label is
    // a footnote/superscript reference ("eCommerce sales grew +19% 2", "Sales (1)"),
    // not a financial figure. Real revenue/income figures are either $-cued or large.
    if ("number" === typeof options.minUncuedAbsValue &&
        Math.abs(value) < options.minUncuedAbsValue &&
        false === hasMoneyCue(text, numberMatch.index, endIndex, token)) {
      continue;
    }

    if (true === options.skipTableNoteRefs &&
        true === isLikelyTableNoteReference(text, numberMatch.index, endIndex, token)) {
      continue;
    }

    // Skip bare calendar years in column headers ("2026 | 2025"). A grouped or
    // decimal token, or one carrying a money cue, is a figure that merely happens to
    // fall in that range — dropping it silently shifts the row to a later column
    // (e.g. "$ | 1,948" for a $1.95B quarter yielding the full-year column instead).
    if (value >= 1900 && value <= 2100 &&
        false === token.includes(",") &&
        false === token.includes(".") &&
        false === hasMoneyCue(text, numberMatch.index, endIndex, token)) {
      continue;
    }

    if ("number" === typeof options.maxAbsValue && Math.abs(value) > options.maxAbsValue) {
      continue;
    }

    values.push({
      endIndex,
      value,
    });
  }

  return values;
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
  const hasMonthBefore = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+$/i.test(beforeToken);
  if (false === hasMonthBefore) {
    return false;
  }

  return /^\s*(?:,\s*)?20\d{2}\b/.test(afterToken) ||
    /^\s*\|/.test(afterToken) ||
    /^\s*$/.test(afterToken);
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
    .replace(/NT\s*\$/gi, "")
    .replace(/C\s*\$/gi, "")
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

export function formatMoneyCompact(
  value: number,
  currencyCode = "USD",
  maximumFractionDigits = 2,
): string {
  const symbol = getCurrencySymbol(currencyCode);
  const absoluteValue = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absoluteValue >= 1_000_000_000_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000_000_000_000, maximumFractionDigits)}T`;
  }

  if (absoluteValue >= 1_000_000_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000_000_000, maximumFractionDigits)}B`;
  }

  if (absoluteValue >= 1_000_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000_000, maximumFractionDigits)}M`;
  }

  if (absoluteValue >= 1_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000, maximumFractionDigits)}K`;
  }

  return `${sign}${symbol}${formatDecimal(absoluteValue, maximumFractionDigits)}`;
}

function getCurrencySymbol(currencyCode: string): string {
  if ("TWD" === currencyCode) {
    return "NT$";
  }

  if ("CAD" === currencyCode) {
    return "C$";
  }

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

function formatDecimal(value: number, maximumFractionDigits = 2): string {
  return value.toFixed(maximumFractionDigits).replace(/\.?0+$/, "");
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
