import {type EarningsEvent} from "./earnings.ts";
import {
  getCurrentPeriodColumnIndex,
  getMetricCandidateScore,
  hasGaapNarrativeBeforeAdjustment,
  isDefinitionalLine,
} from "./earnings-results-format-selection.ts";
import {extractOutlookMetrics} from "./earnings-results-outlook.ts";
import {
  getDocumentCurrencyCode,
  getDocumentHeadline,
  getMeaningfulLines,
  getQuarterLabel,
  htmlToText,
  type ParsedEarningsDocument,
} from "./earnings-results-document.ts";
import {
  earningsMetricDefinitions,
  getMetricLineWithContinuation,
  getQuarterSpecificMetricLines,
  hasMixedMonthQuarterColumns,
  isNearTableNoteColumn,
  isPerShareOnlyNetIncomeLine,
  type EarningsResultMetric,
  type MetricDefinition,
  type MetricValueType,
} from "./earnings-results-metrics.ts";
import {getOutcome} from "./earnings-results-message.ts";
import {
  findColumnValueMatch,
  findEpsValue,
  findNumericValue,
  findNumericValueMatch,
  findPerShareTableValue,
  formatEps,
  formatMoneyCompact,
  formatPlainNumber,
  formatUsdCompact,
  getCurrencyCodeFromText,
  getExplicitMoneyScale,
  getMoneyDisplayPrecision,
  getMoneyScaleFromContextText,
  getTrailingUnit,
  isMetricLabelSuffixTableNote,
  type MoneyContext,
} from "./earnings-results-money.ts";

export {decodeHtmlEntities, htmlToText} from "./earnings-results-document.ts";
export {getEarningsResultMessage} from "./earnings-results-message.ts";
export {formatEps, formatMoneyCompact, formatUsdCompact, parseNumber} from "./earnings-results-money.ts";
export type {ParsedEarningsDocument} from "./earnings-results-document.ts";
export type {EarningsResultMetric, EarningsResultOutcome} from "./earnings-results-metrics.ts";

export type NasdaqSurprise = {
  actualEps?: number | undefined;
  actualRevenue?: number | undefined;
  consensusEps?: number | undefined;
  consensusRevenue?: number | undefined;
  percentageSurprise?: number | undefined;
};

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

function getQuarterColumnSearchText(text: string): string {
  const groupBoundary = /\|\s*(?:%|NM|N\/A|N\.M\.)\s*\|/i.exec(text);
  if (undefined === groupBoundary?.index) {
    return text;
  }

  return text.slice(groupBoundary.index + groupBoundary[0].length);
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

function isMetricValuePrefix(text: string): boolean {
  const valuePrefix = text.replace(/\b(?:basic|diluted)\s*$/i, "");
  return "" !== valuePrefix.trim() && false === /[A-Za-z]/.test(valuePrefix);
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
