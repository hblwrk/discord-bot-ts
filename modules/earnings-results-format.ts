import {type EarningsEvent} from "./earnings.ts";
import {
  getCurrentPeriodColumnIndex,
  getMetricCandidateScore,
  hasGaapNarrativeBeforeAdjustment,
  isDefinitionalLine,
} from "./earnings-results-format-selection.ts";
import {extractOutlookMetrics} from "./earnings-results-outlook.ts";
import {gaapTermSource} from "./earnings-results-terms.ts";
import {
  getDocumentCurrencyCode,
  getDilutedShareMantissa,
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
  isAdjustedEpsReconciliationRow,
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
  const metrics = extractEarningsMetrics(lines, quarterLabel, documentCurrencyCode);
  return {
    dilutedShareMantissa: getDilutedShareMantissa(lines),
    headline: getDocumentHeadline(lines),
    metrics: dropOrdinaryShareEpsForAdsIssuer(metrics, lines),
    outlook: extractOutlookMetrics(lines, documentCurrencyCode),
    quarterLabel,
  };
}

// An ADS-listed foreign issuer can report earnings only per ordinary share even though the
// security watched in the US represents several of those shares. Posting that unconverted
// figure as EPS is misleading (and can turn a real ADS loss into "$0.00"). Unless the filing
// states an ADS value explicitly, omit the per-share metric rather than inventing a conversion.
function dropOrdinaryShareEpsForAdsIssuer(
  metrics: EarningsResultMetric[],
  lines: string[],
): EarningsResultMetric[] {
  const hasAdsEquivalence = lines.some(line =>
    /\bequivalent\s+to\s+(?:about\s+)?[\d,]+\s+ADSs?\b/i.test(line) ||
    /\bone\s+ADS\s+(?:is\s+equivalent\s+to|represents)\s+[\d,]+\s+ordinary\s+shares?\b/i.test(line));
  if (false === hasAdsEquivalence) {
    return metrics;
  }

  return metrics.filter(metric =>
    false === isEpsMetricKey(metric.key) || /\bper\s+ADS\b/i.test(metric.sourceSnippet ?? ""));
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
      true === isImplausibleSecondaryGaapEps(gaapEpsMetric.numericValue, adjustedEpsMetric.numericValue) &&
      false === isExplicitLargeGaapLoss(gaapEpsMetric)) {
    return metrics.filter(metric => "gaap_eps" !== metric.key);
  }

  return metrics;
}

function isExplicitLargeGaapLoss(metric: EarningsResultMetric): boolean {
  return "number" === typeof metric.numericValue &&
    metric.numericValue < 0 &&
    /\bGAAP\s+net\s+loss\b/i.test(metric.sourceSnippet ?? "") &&
    /\bper\s+(?:fully\s+)?(?:common\s+)?diluted\s+share\b/i.test(metric.sourceSnippet ?? "");
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

    const hasMetricLabel = definition.patterns.some(pattern => pattern.test(line)) ||
      ("adjusted_eps" === definition.key &&
        true === isAdjustedEpsReconciliationRow(lines, lineIndex));
    if (false === hasMetricLabel) {
      continue;
    }

    const metricLine = getMetricLineWithContinuation(lines, lineIndex, definition, quarterLabel);

    // An explicitly GAAP-labelled line overrides the "adjusted" skip, but must never
    // override a forward-looking one: "Increasing full year GAAP EPS guidance to a range
    // of $0.09 to $0.11" would otherwise post the low end of an annual outlook as the
    // reported quarter.
    const isForwardLooking = isForwardLookingLine(metricLine);
    const hasExplicitGaapEps = "gaap_eps" === definition.key &&
      false === isForwardLooking &&
      explicitGaapEpsPattern.test(metricLine);
    const hasReportedGaapEps = "gaap_eps" === definition.key &&
      false === isForwardLooking &&
      true === hasGaapNarrativeBeforeAdjustment(metricLine, definition.patterns);
    const hasReportedGaapNetIncome = "net_income" === definition.key &&
      false === isForwardLooking &&
      true === hasMetricValueBeforeAdjustment(metricLine, definition.patterns);
    const hasReportedRevenueBeforeGuidance = "revenue" === definition.key &&
      true === hasMetricValueBeforeGuidance(metricLine, definition.patterns);
    if (true === isSkippedMetricLine(metricLine, definition) &&
        false === hasExplicitGaapEps &&
        false === hasReportedGaapEps &&
        false === hasReportedGaapNetIncome &&
        false === hasReportedRevenueBeforeGuidance) {
      continue;
    }

    if ("net_income" === definition.key && true === isPerShareOnlyNetIncomeLine(metricLine)) {
      continue;
    }

    // Restructuring and other adjustment commentary often translates a charge into its
    // per-share impact. That amount is neither GAAP nor adjusted EPS, even when the phrase
    // between "impact" and the value repeats the full per-share metric caption.
    if ("eps" === definition.valueType && true === isPerShareImpactOnlyLine(metricLine)) {
      continue;
    }

    // A sentence can state the GAAP loss and then its non-GAAP counterpart. Once the
    // leading reported value has made the line eligible, read only that leading clause;
    // otherwise an earlier pattern in the definition can match the later non-GAAP income.
    const valueMetricLine = true === hasReportedGaapNetIncome
      ? metricLine.slice(0, metricLine.search(/\badjusted\b|\bnon-gaap\b/i))
      : metricLine;
    const pattern = definition.patterns.find(candidatePattern => candidatePattern.test(valueMetricLine));
    if (!pattern) {
      continue;
    }

    const metricValue = extractMetricValue(
      valueMetricLine,
      pattern,
      definition.valueType,
      getContextMoney(lines, lineIndex, documentCurrencyCode),
      isNearTableNoteColumn(lines, lineIndex),
      undefined !== quarterLabel && hasMixedMonthQuarterColumns(lines, lineIndex),
      getCurrentPeriodColumnIndex(lines, lineIndex, quarterLabel, documentCurrencyCode),
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
      metricKey: definition.key,
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

function isPerShareImpactOnlyLine(line: string): boolean {
  const impactIndex = line.search(/\b(?:accretive|dilutive|favorable|unfavorable)?\s*impact\b/i);
  if (-1 === impactIndex) {
    return false;
  }

  const textBeforeImpact = line.slice(0, impactIndex);
  const hasReportedEpsBeforeImpact = /\b(?:eps|(?:earnings|income|loss)\s+per\s+(?:fully\s+)?(?:common\s+)?(?:diluted\s+)?share)\b[^.!?]{0,40}\b(?:was|were|of)\s+\(?-?[$€£¥]?\s*\d/i
    .test(textBeforeImpact);
  if (true === hasReportedEpsBeforeImpact) {
    return false;
  }

  const perShareIndex = line.search(/\bper\s+(?:fully\s+)?(?:common\s+)?(?:diluted\s+)?share\b/i);
  return -1 !== perShareIndex && impactIndex < perShareIndex;
}

function hasMetricValueBeforeAdjustment(line: string, patterns: RegExp[]): boolean {
  return hasMetricValueBeforeQualifier(line, patterns, /\badjusted\b|\bnon-gaap\b/i);
}

// A results bullet can compare an already stated actual with guidance on the same line:
// "Total revenue of $46.5 million ... within guidance of $46-48 million". The guidance
// skip applies only to the trailing comparison, while a line whose first value follows the
// guidance label remains forward-looking and must still be discarded.
function hasMetricValueBeforeGuidance(line: string, patterns: RegExp[]): boolean {
  return hasMetricValueBeforeQualifier(
    line,
    patterns,
    /\b(?:guidance|outlook|forecast)\b/i,
  );
}

function hasMetricValueBeforeQualifier(
  line: string,
  patterns: RegExp[],
  qualifierPattern: RegExp,
): boolean {
  const qualifierIndex = line.search(qualifierPattern);
  if (0 >= qualifierIndex) {
    return false;
  }

  const reportedText = line.slice(0, qualifierIndex);
  return patterns.some(pattern => {
    pattern.lastIndex = 0;
    const patternMatch = pattern.exec(reportedText);
    if (null === patternMatch) {
      return false;
    }

    const valueText = reportedText.slice(patternMatch.index + patternMatch[0].length);
    return /[$€£¥]\s*\(?-?\d|\b\(?-?\d[\d,]*(?:\.\d+)?\)?\s+(?:trillions?|billions?|millions?|thousands?|tn|bn|mm|[tbmk])\b/i
      .test(valueText);
  });
}

// Disqualifiers are matched against the whole line, which is right for a statement row or
// a sentence. Some filers emit an entire statement as one unbroken line, though, and there
// a single "Cost of revenue" caption would discard every figure in the statement. For those
// each occurrence of the label is judged on the qualifier directly ahead of it instead.
const collapsedStatementLineLength = 600;
const labelQualifierWindow = 60;

function isSkippedMetricLine(line: string, definition: MetricDefinition): boolean {
  const skipPattern = definition.skipPattern;
  if (undefined === skipPattern) {
    return false;
  }

  // A long prose paragraph is not a collapsed statement. Judge its forward-looking or
  // adjusted qualifier against the whole sentence; the per-caption window below exists only
  // for dense table text where many unrelated rows were flattened together.
  const isUnseparatedStatement = /\b(?:consolidated\s+)?statements?\s+of\s+(?:income|operations)\b/i
    .test(line);
  if (line.length <= collapsedStatementLineLength ||
      (4 > (line.match(/\|/g)?.length ?? 0) && false === isUnseparatedStatement)) {
    return skipPattern.test(line);
  }

  // Testing the whole prefix would let an unrelated earlier row disqualify a later one —
  // "Loss before income taxes" sitting above the "Net loss" row it is meant to leave alone.
  for (const pattern of definition.patterns) {
    const scanPattern = new RegExp(pattern.source, pattern.flags.replace("g", "") + "g");
    for (const patternMatch of line.matchAll(scanPattern)) {
      const windowText = line.slice(
        Math.max(0, patternMatch.index - labelQualifierWindow),
        patternMatch.index + patternMatch[0].length,
      );
      if (false === skipPattern.test(windowText)) {
        return false;
      }
    }
  }

  return true;
}

// A line naming only the non-GAAP measure must not override the adjusted skip, so this uses
// the shared GAAP term rather than a bare \bgaap.
const explicitGaapEpsPattern = new RegExp(String.raw`${gaapTermSource}\s+(?:diluted\s+)?eps\b`, "i");

function isForwardLookingLine(line: string): boolean {
  return /\b(?:guidance|outlook|forecast)\b/i.test(line) ||
    /\b(?:expects?|expecting|anticipates?)\b/i.test(line) ||
    /\bto\s+be\s+(?:between|in\s+(?:(?:a|the)\s+)?range)\b/i.test(line);
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
  // A row captioned as a loss states its magnitude, with the sign carried by the caption
  // ("Net loss of $541 million", "Non-GAAP Loss per Share Was $0.13"). A bracketed cell is
  // already negative, so only an unsigned value is flipped. Combined captions such as
  // "(Loss) earnings per share" keep the sign of the cell instead.
  const isLossCaption = undefined !== patternMatch?.[0] &&
    /\bloss\b/i.test(patternMatch[0]) &&
    false === /\b(?:income|earnings|profit)\b/i.test(patternMatch[0]);
  // Prose can state the sign beside the value instead, which is the only place it appears when
  // the caption is a combined one: "(GAAP) loss / earnings per share (EPS) assuming dilution
  // was a loss per share of $0.54". Only the wording directly introducing the first value
  // counts, so a later mention of an unrelated loss does not flip the figure.
  const isLossIntroducedValue = /\ba?\s*loss\s+(?:per\s+(?:common\s+)?share\s+)?of\s*$/i
    .test(getValueIntroText(preferredSearchText));
  const signedValue = (value: number): number =>
    (true === isLossCaption || true === isLossIntroducedValue) && value > 0 ? -value : value;

  if ("eps" === valueType) {
    const perShareTableValue = findPerShareTableValue(preferredSearchText, currentPeriodColumnIndex);
    const preferredValue = findEpsValue(preferredSearchText, columnIndex);
    const fallbackValue = true === isMetricValuePrefix(fallbackSearchText)
      ? findEpsValue(fallbackSearchText, columnIndex)
      : null;
    const matchedValue = perShareTableValue ?? preferredValue ?? fallbackValue;
    if (null === matchedValue) {
      return null;
    }

    const value = signedValue(matchedValue);
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
    const minUncuedAbsValue = line.length > collapsedStatementLineLength &&
        /\b(?:USD|CAD|TWD|NTD|EUR|GBP|JPY|CHF)\s+millions\b.*\bNote\b/i.test(line)
      ? 0
      : 10;
    const labelSearchText = getMetricValueSentenceText(preferredSearchText);
    const sentenceSearchText = getBreakdownTotalText(labelSearchText) ?? labelSearchText;
    const currencySearchText = getExplicitReportingCurrencyText(
      sentenceSearchText,
      contextMoney.currencyCode,
    ) ?? sentenceSearchText;
    const hasMetricLabelSuffixTableNote = isMetricLabelSuffixTableNote(currencySearchText);
    const searchValueMatch = true === hasMetricLabelSuffixTableNote ? null : findColumnValueMatch(currencySearchText, {
      minUncuedAbsValue,
      requireMoneyCue: 1 === contextMoney.scale,
      skipTableNoteRefs,
      skipPercentages: true,
    }, columnIndex);
    const hasLeadingMoneyValue = true === isLeadingMoneyValuePrefix(fallbackSearchText);
    const fallbackValueMatch = (true === isMetricValuePrefix(fallbackSearchText) || hasLeadingMoneyValue)
      ? findNumericValueMatch(fallbackSearchText, {
        minUncuedAbsValue,
        requireMoneyCue: 1 === contextMoney.scale,
        skipTableNoteRefs,
        skipPercentages: true,
      })
      : null;
    const useFallbackValue = null !== fallbackValueMatch &&
      (hasLeadingMoneyValue || null === searchValueMatch || true === hasMetricLabelSuffixTableNote);
    const parsedValueMatch = true === useFallbackValue
      ? fallbackValueMatch
      : searchValueMatch ?? fallbackValueMatch;
    if (null === parsedValueMatch) {
      return null;
    }

    const metricText = true === useFallbackValue ? fallbackSearchText : currencySearchText;
    const explicitScale = getExplicitMoneyScale(metricText, parsedValueMatch.endIndex);
    const currencyCode = getCurrencyCodeFromText(metricText, contextMoney.currencyCode) ?? contextMoney.currencyCode;
    const amount = signedValue(parsedValueMatch.value) * (explicitScale ?? contextMoney.scale);
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

// Foreign issuers commonly state a local-currency result followed by its translation in
// the filing's reporting currency ("HK$7,200.2 million (US$918.2 million)"). The generic
// dollar reader otherwise takes the local amount and then labels it USD because the line
// also contains "US$". Start at the explicit reporting-currency marker when one exists.
function getExplicitReportingCurrencyText(
  text: string,
  currencyCode: string | undefined,
): string | null {
  const markerByCurrency = new Map<string, RegExp>([
    ["USD", /\b(?:US\s*\$|USD)\s*/i],
    ["CAD", /(?:^|[^A-Za-z])(?:C\s*\$|CAD)\s*/i],
    ["TWD", /(?:^|[^A-Za-z])(?:NT\s*\$|NTD|TWD)\s*/i],
    ["EUR", /(?:€|\bEUR\b)\s*/i],
    ["GBP", /(?:£|\bGBP\b)\s*/i],
    ["JPY", /(?:¥|\bJPY\b)\s*/i],
    ["CHF", /\bCHF\s*/i],
  ]);
  // An exhibit may not declare one document-wide currency because it presents every
  // result in local currency and USD side by side. An explicit US-dollar translation is
  // still the comparable amount for the US-listed security.
  const resolvedCurrencyCode = currencyCode ?? (/\bUS\s*\$/i.test(text) ? "USD" : undefined);
  const marker = undefined === resolvedCurrencyCode
    ? undefined
    : markerByCurrency.get(resolvedCurrencyCode)?.exec(text);
  return undefined === marker?.index ? null : text.slice(marker.index);
}

// A metric value must be in the same sentence as its label. Otherwise prose such
// as "162% of net earnings. During the quarter, the company paid $429 million in
// dividends" can mislabel the next sentence's first dollar amount as net income.
// Table rows remain intact because their label/value cells are separated by pipes,
// not sentence-ending punctuation followed by a new sentence.
// A group caption whose first value cell belongs to a named sub-row is a breakdown
// ("Revenue | Space $962 ... Connectivity 4,291 ... Total $7,814"). The caption's own
// figure is the Total row; the leading cell is the first segment's.
function getBreakdownTotalText(text: string): string | null {
  const firstValueMatch = /\(?-?(?:[$€£¥]\s*)?\d/.exec(text);
  if (null === firstValueMatch ||
      false === /[A-Za-z]{2,}/.test(text.slice(0, firstValueMatch.index))) {
    return null;
  }

  const totalMatch = /\bTotal\b/.exec(text);
  return null === totalMatch
    ? null
    : text.slice(totalMatch.index + totalMatch[0].length);
}

function getMetricValueSentenceText(text: string): string {
  const boundaryMatch = /[.!?]\s+(?=[A-Z\d$€£¥])/u.exec(text);
  if (undefined === boundaryMatch?.index) {
    return text;
  }

  return text.slice(0, boundaryMatch.index + 1);
}

// The wording that introduces the first value in the text, up to and excluding that value.
function getValueIntroText(text: string): string {
  const valueIndex = text.search(/[$€£¥(]?\s*-?\d/);
  return -1 === valueIndex ? text : text.slice(0, valueIndex);
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
  const currentLine = lines[lineIndex] ?? "";
  if (/\bnet\s+(?:income|earnings)\s*\(\s*[$€£¥]\s*B\s*\)/i.test(currentLine)) {
    return {
      currencyCode: getCurrencyCodeFromText(currentLine, currencyCode) ?? currencyCode,
      scale: 1_000_000_000,
    };
  }

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

function isLeadingMoneyValuePrefix(text: string): boolean {
  return /^\s*[•◦▪–—-]?\s*\(?-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:trillions?|billions?|millions?|thousands?|tn|bn|mm|[tbmk])\)?\s*,?\s*$/i
    .test(text);
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
