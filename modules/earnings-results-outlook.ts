
export type EarningsOutlookMetric = {
  key: string;
  label: string;
  periodLabel?: string | undefined;
  value: string;
};

type OutlookValueType = "eps" | "money" | "percent" | "text";

type OutlookMetricDefinition = {
  key: string;
  label: string;
  patterns: RegExp[];
  valueType: OutlookValueType;
};

type OutlookMetricCandidate = {
  metric: EarningsOutlookMetric;
  score: number;
};

type ParsedMoneyValue = {
  currencyCode: string;
  value: number;
};

type OutlookSection = {
  lines: string[];
  mixedPeriods: boolean;
};

const moneyTokenPatternSource = String.raw`(?<![\d.])\(?\s*(?:(?:[$€£¥]\s*)|(?:(?:USD|EUR|GBP|JPY)\s+))?-?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:(?:trillions?|billions?|millions?|thousands?|tn|bn|mm|[tbmk])\b)?\)?`;
const moneyRangePattern = new RegExp(`(${moneyTokenPatternSource})\\s*(?:to|through|-|–|and)\\s*(${moneyTokenPatternSource})`, "gi");
const singleMoneyPattern = new RegExp(moneyTokenPatternSource, "gi");

const outlookMetricDefinitions: OutlookMetricDefinition[] = [
  {
    key: "revenue",
    label: "Revenue",
    patterns: [/\brevenues?\b/i, /\bnet\s+sales\b/i],
    valueType: "text",
  },
  {
    key: "adjusted_eps",
    label: "Adj EPS",
    patterns: [
      /\badjusted\s+continuing(?:\s+operations?)?\s+(?:diluted\s+)?eps\b/i,
      /\badjusted\s+continuing(?:\s+operations?)?\s+earnings\s+per\s+(?:common\s+)?share\b/i,
    ],
    valueType: "eps",
  },
  {
    key: "eps",
    label: "EPS",
    patterns: [
      /\bgaap\s+(?:continuing(?:\s+operations?)?\s+)?(?:diluted\s+)?eps\b/i,
      /\b(?:continuing(?:\s+operations?)?\s+)?(?:diluted\s+)?eps\b/i,
      /\bearnings\s+per\s+(?:common\s+)?share\b/i,
    ],
    valueType: "eps",
  },
  {
    key: "adjusted_ebitda",
    label: "Adj EBITDA",
    patterns: [/\badjusted\s+ebitda\b/i],
    valueType: "money",
  },
  {
    key: "dcf_per_share",
    label: "DCF/share",
    patterns: [/\bdcf\s+per\s+share\b/i, /\bdistributable\s+cash\s+flow\s+per\s+share\b/i],
    valueType: "eps",
  },
  {
    key: "gross_margin",
    label: "Gross margin",
    patterns: [/\bgross\s+margin\b/i],
    valueType: "percent",
  },
  {
    key: "operating_margin",
    label: "Operating margin",
    patterns: [/\boperating\s+margin\b/i],
    valueType: "percent",
  },
  {
    key: "operating_income",
    label: "Operating income",
    patterns: [/\boperating\s+income\b/i],
    valueType: "money",
  },
  {
    key: "operating_expenses",
    label: "Operating expenses",
    patterns: [/\boperating\s+expenses?\b/i, /\bopex\b/i],
    valueType: "money",
  },
  {
    key: "tax_rate",
    label: "Tax rate",
    patterns: [/\btax\s+rate\b/i],
    valueType: "percent",
  },
  {
    key: "capex",
    label: "Capex",
    patterns: [/\bcapex\b/i, /\bcapital\s+expenditures?\b/i],
    valueType: "money",
  },
  {
    key: "free_cash_flow",
    label: "Free cash flow",
    patterns: [/\bfree\s+cash\s+flow\b/i],
    valueType: "money",
  },
];

export function extractOutlookMetrics(lines: string[]): EarningsOutlookMetric[] {
  const section = getOutlookSection(lines);
  if (0 === section.lines.length) {
    return [];
  }

  const metrics: EarningsOutlookMetric[] = [];
  const seenKeys = new Set<string>();
  for (const definition of outlookMetricDefinitions) {
    const metric = extractOutlookMetric(section.lines, definition, section.mixedPeriods);
    if (null === metric || true === seenKeys.has(metric.key)) {
      continue;
    }

    metrics.push(metric);
    seenKeys.add(metric.key);
  }

  return metrics.slice(0, 6);
}

function getOutlookSection(lines: string[]): OutlookSection {
  const sectionLines: string[] = [];
  let collecting = false;
  let mixedPeriods = false;

  for (const line of lines) {
    if (true === isOutlookHeading(line)) {
      collecting = true;
      mixedPeriods = isMixedPeriodOutlookHeading(line);
      continue;
    }

    if (false === collecting) {
      continue;
    }

    if (true === isOutlookSectionEnd(line)) {
      break;
    }

    sectionLines.push(line);
    if (sectionLines.length >= 30) {
      break;
    }
  }

  return {
    lines: sectionLines,
    mixedPeriods: mixedPeriods || hasMixedOutlookPeriods(sectionLines),
  };
}

function hasMixedOutlookPeriods(lines: string[]): boolean {
  const sectionText = lines.join(" ");
  const hasQuarter = /\b(?:q[1-4]|first|second|third|fourth)[\s–—-]+quarter\b/i.test(sectionText) ||
    /\bq[1-4]\b/i.test(sectionText);
  const hasFullYear = /\b(?:full[\s–—-]+year|fiscal\s+year|fy)\b/i.test(sectionText);
  return hasQuarter && hasFullYear;
}

function isOutlookHeading(line: string): boolean {
  if (line.length > 140 ||
      /\b(?:announces?|reports?|reported|results?)\b/i.test(line) ||
      /\bforward-looking\s+statements?\b/i.test(line)) {
    return false;
  }

  const normalizedLine = line
    .replace(/^[\s•–—-]+/, "")
    .replace(/[\s|–—-]+$/, "")
    .trim();

  return /^(?:business\s+|financial\s+)?(?:outlook|guidance)\b/i.test(normalizedLine) ||
    /^(?:the\s+)?company\s+(?:raises?|updates?|reaffirms?|provides?|issues?)\b.*\b(?:outlook|guidance)\b/i.test(normalizedLine) ||
    /^(?:(?:fiscal\s+)?(?:20\d{2}|fy\s?\d{2}|q[1-4]\s+20\d{2}|quarter)|(?:first|second|third|fourth)[\s–—-]+quarter)\b.*\b(?:outlook|guidance)\b/i.test(normalizedLine);
}

function isMixedPeriodOutlookHeading(line: string): boolean {
  return (/\bq[1-4]\b/i.test(line) ||
    /\b(?:first|second|third|fourth)[\s–—-]+quarter\b/i.test(line)) &&
    /\bfull[\s–—-]+year\b/i.test(line);
}

function isOutlookSectionEnd(line: string): boolean {
  if (true === isNextSectionHeading(line)) {
    return true;
  }

  if (line.length <= 140 &&
      /\b(?:forward-looking\s+statements?|safe\s+harbor|legal\s+notice\s+regarding\s+forward-looking)\b/i.test(line)) {
    return true;
  }

  if (/\b(?:conference\s+call|about\s+|press\s+contact|investor\s+relations|condensed\s+consolidated|financial\s+statements?)\b/i.test(line)) {
    return true;
  }

  if (line.length <= 140 &&
      /^\s*(?:use\s+of\s+)?(?:non-gaap|reconciliation)\b/i.test(line)) {
    return true;
  }

  return line.length <= 90 &&
    /^(?:results|balance\s+sheets?|cash\s+flows?|appendix|contacts?|media|webcast)$/i.test(line);
}

function isNextSectionHeading(line: string): boolean {
  const normalizedLine = line
    .replace(/^[\s•–—-]+/, "")
    .replace(/[\s|–—-]+$/, "")
    .trim();
  if (normalizedLine.length > 90 || /\b(?:outlook|guidance)\b/i.test(normalizedLine)) {
    return false;
  }

  return /^[A-Z][A-Z0-9&/().,:' -]+$/.test(normalizedLine) &&
    /[A-Z]{3,}/.test(normalizedLine);
}

function extractOutlookMetric(
  lines: string[],
  definition: OutlookMetricDefinition,
  includePeriodLabel: boolean,
): EarningsOutlookMetric | null {
  let bestCandidate: OutlookMetricCandidate | null = null;
  for (const line of lines) {
    if (true === isNoisyOutlookLine(line)) {
      continue;
    }

    for (const pattern of definition.patterns) {
      if (false === pattern.test(line)) {
        continue;
      }

      const value = extractOutlookValue(line, pattern, definition.valueType);
      if (null === value) {
        continue;
      }

      const periodLabel = true === includePeriodLabel
        ? getOutlookPeriodLabel(line)
        : undefined;
      const metric: EarningsOutlookMetric = {
        key: definition.key,
        label: definition.label,
        value,
      };
      if (undefined !== periodLabel) {
        metric.periodLabel = periodLabel;
      }
      const candidate = {
        score: getOutlookMetricCandidateScore(line),
        metric,
      };
      if (null === bestCandidate || candidate.score > bestCandidate.score) {
        bestCandidate = candidate;
      }
    }
  }

  return bestCandidate?.metric ?? null;
}

function getOutlookPeriodLabel(line: string): string | undefined {
  const directQuarterMatch = /\bq([1-4])(?:\s+20\d{2})?\b/i.exec(line);
  if (undefined !== directQuarterMatch?.[1]) {
    return `Q${directQuarterMatch[1]}`;
  }

  const writtenQuarterMatch = /\b(first|second|third|fourth)[\s–—-]+quarter\b/i.exec(line);
  if (undefined !== writtenQuarterMatch?.[1]) {
    const quarterByName = new Map([
      ["first", "Q1"],
      ["second", "Q2"],
      ["third", "Q3"],
      ["fourth", "Q4"],
    ]);
    return quarterByName.get(writtenQuarterMatch[1].toLowerCase());
  }

  const fullYearMatch = /\b(?:full[\s–—-]+year|fiscal\s+year|fy)\s*(?:of\s+)?(20\d{2}|\d{2})\b/i.exec(line);
  if (undefined !== fullYearMatch?.[1]) {
    return `FY${2 === fullYearMatch[1].length ? `20${fullYearMatch[1]}` : fullYearMatch[1]}`;
  }

  return undefined;
}

function getOutlookMetricCandidateScore(line: string): number {
  let score = 0;

  if (/\b(?:expects?|expected|guidance|outlook|forecast|projected|targets?|targeting|anticipates?|anticipated|reaffirms?|reiterates?|maintains?|raises?|raised)\b/i.test(line)) {
    score += 20;
  }

  if (/\b(?:full[-\s]+year|fiscal|fy\s?\d{2}|20\d{2}|next\s+quarter|second\s+quarter|third\s+quarter|fourth\s+quarter|q[1-4])\b/i.test(line)) {
    score += 5;
  }

  if (/\b(?:reported|generated|was|were|amounted|totaled|for\s+the\s+(?:first|second|third|fourth)\s+quarter|for\s+q[1-4])\b/i.test(line)) {
    score -= 10;
  }

  return score;
}

function isNoisyOutlookLine(line: string): boolean {
  const pipeCount = line.match(/\|/g)?.length ?? 0;
  return pipeCount >= 4 ||
    /\bpost[-\s]?20\d{2}\b.*\bcompound\s+annual\s+growth\s+rate\b/i.test(line);
}

function extractOutlookValue(
  line: string,
  pattern: RegExp,
  valueType: OutlookValueType,
): string | null {
  pattern.lastIndex = 0;
  const patternMatch = pattern.exec(line);
  for (const rawValueText of getOutlookValueSegments(line, patternMatch)) {
    const valueText = normalizeOutlookValueText(rawValueText);
    if ("" === valueText) {
      continue;
    }

    const value = getGrowthOutlookValue(valueText) ??
      getOutlookRangeValue(valueText, valueType) ??
      ("eps" === valueType ? getEpsPercentOutlookValue(valueText) : null) ??
      ("text" === valueType ? getSingleOutlookValue(valueText, "money") : null) ??
      ("text" === valueType ? getNumericGrowthOutlookValue(valueText) : null) ??
      getSingleOutlookValue(valueText, valueType);
    if (null !== value) {
      return value;
    }
  }

  return null;
}

function getOutlookValueSegments(line: string, patternMatch: RegExpExecArray | null): string[] {
  if (null === patternMatch) {
    return [line];
  }

  const rawValueText = line.slice(patternMatch.index + patternMatch[0].length);
  const nextMetricMatch = /\b(?:adjusted\s+(?:continuing\s+)?eps|gaap\s+(?:continuing\s+)?eps|diluted\s+eps|eps|earnings\s+per\s+(?:common\s+)?share|revenues?|net\s+sales|sales|gross\s+margin|operating\s+margin|operating\s+income|operating\s+expenses?|opex|tax\s+rate|capex|capital\s+expenditures?|free\s+cash\s+flow|dcf\s+per\s+share|distributable\s+cash\s+flow\s+per\s+share|adjusted\s+ebitda|ebitda)\b/i.exec(rawValueText);
  const endIndex = nextMetricMatch?.index ?? rawValueText.length;
  const previousValueText = getPreviousOutlookValueSegment(line, patternMatch.index);
  return [
    rawValueText.slice(0, endIndex),
    previousValueText,
  ];
}

function getPreviousOutlookValueSegment(line: string, metricStartIndex: number): string {
  const previousText = line.slice(0, metricStartIndex);
  const separatorIndex = Math.max(
    previousText.lastIndexOf(";"),
    previousText.lastIndexOf("|"),
  );
  return previousText.slice(Math.max(separatorIndex + 1, previousText.length - 180));
}

function normalizeOutlookValueText(value: string): string {
  return value
    .replace(/^[\s:|,-]+/, "")
    .replace(/\b(?:is|are|was|were|to\s+be|of|at|approximately|about|around|roughly|expected|expects|expect|guidance|outlook|projected|forecast|in\s+the\s+range\s+of|between)\b/gi, " ")
    .replace(/\bto\s+(?:grow|increase|range)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getGrowthOutlookValue(value: string): string | null {
  const growthMatch = value.match(/\b(low|mid|high)\s+(single|double)[-\s]+digit(?:s)?(?:\s+(?:growth|increase|decline|decrease))?\b/i);
  if (undefined !== growthMatch?.[1] && undefined !== growthMatch[2]) {
    return `${growthMatch[1].toLowerCase()} ${growthMatch[2].toLowerCase()}-digit ${getGrowthDirection(value)}`;
  }

  const doubleDigitMatch = value.match(/\bdouble[-\s]+digit(?:s)?(?:\s+(?:growth|increase|decline|decrease))?\b/i);
  if (doubleDigitMatch) {
    return `double-digit ${getGrowthDirection(value)}`;
  }

  return null;
}

function getGrowthDirection(value: string): "growth" | "decline" {
  return /\bdecline|decrease|down\b/i.test(value) ? "decline" : "growth";
}

function getNumericGrowthOutlookValue(value: string): string | null {
  const percentMatch = /(-?\d+(?:\.\d+)?)\s*(?:%|percent)\b/i.exec(value);
  if (undefined === percentMatch?.[1]) {
    return null;
  }

  return `${formatPercent(Number.parseFloat(percentMatch[1]))} ${getGrowthDirection(value)}`;
}

function getOutlookRangeValue(value: string, valueType: OutlookValueType): string | null {
  if ("eps" === valueType) {
    const percentRangeValue = getPercentRangeOutlookValue(value);
    if (null !== percentRangeValue) {
      return withPercentGrowthDirection(percentRangeValue, value);
    }
  }

  if ("percent" === valueType) {
    const percentRangeMatch = value.match(/(-?\d+(?:\.\d+)?)\s*%\s*(?:to|through|-|–|and)\s*(-?\d+(?:\.\d+)?)\s*%/i);
    return undefined !== percentRangeMatch?.[1] && undefined !== percentRangeMatch[2]
      ? `${formatPercent(Number.parseFloat(percentRangeMatch[1]))} to ${formatPercent(Number.parseFloat(percentRangeMatch[2]))}`
      : null;
  }

  for (const moneyRangeMatch of value.matchAll(moneyRangePattern)) {
    const firstRangeValue = moneyRangeMatch[1];
    const secondRangeValue = moneyRangeMatch[2];
    if (undefined === firstRangeValue || undefined === secondRangeValue) {
      continue;
    }

    if ("eps" === valueType) {
      const firstValue = parseNumber(firstRangeValue);
      const secondValue = parseNumber(secondRangeValue);
      if (null !== firstValue && null !== secondValue) {
        return `${formatEps(firstValue)} to ${formatEps(secondValue)}`;
      }
      continue;
    }

    if (false === hasMoneyValueCue(firstRangeValue) && false === hasMoneyValueCue(secondRangeValue)) {
      continue;
    }

    const inferredUnit = getMoneyUnit(secondRangeValue) ?? getMoneyUnit(firstRangeValue);
    const inferredCurrencyCode = getCurrencyCodeFromText(secondRangeValue) ??
      getCurrencyCodeFromText(firstRangeValue) ??
      getCurrencyCodeFromText(value);
    const firstMoneyValue = parseMoneyWithOptionalUnit(firstRangeValue, inferredUnit, inferredCurrencyCode);
    const secondMoneyValue = parseMoneyWithOptionalUnit(secondRangeValue, inferredUnit, inferredCurrencyCode);
    if (null !== firstMoneyValue && null !== secondMoneyValue) {
      return `${formatMoneyCompact(firstMoneyValue.value, firstMoneyValue.currencyCode)} to ${formatMoneyCompact(secondMoneyValue.value, secondMoneyValue.currencyCode)}`;
    }
  }

  return null;
}

function getSingleOutlookValue(value: string, valueType: OutlookValueType): string | null {
  if ("percent" === valueType) {
    const percentMatch = value.match(/-?\d+(?:\.\d+)?\s*%/);
    return percentMatch ? percentMatch[0].replace(/\s+/g, "") : null;
  }

  if ("eps" === valueType) {
    const epsValue = findNumericValue(value, {maxAbsValue: 100, skipPercentages: true});
    return null === epsValue ? null : formatEps(epsValue);
  }

  if ("money" === valueType) {
    const inferredCurrencyCode = getCurrencyCodeFromText(value);
    for (const moneyMatch of value.matchAll(singleMoneyPattern)) {
      const token = moneyMatch[0];
      if (false === hasMoneyValueCue(token)) {
        continue;
      }

      const moneyValue = parseMoneyWithOptionalUnit(token, undefined, inferredCurrencyCode);
      if (null !== moneyValue) {
        return formatMoneyCompact(moneyValue.value, moneyValue.currencyCode);
      }
    }
  }

  return null;
}

function getEpsPercentOutlookValue(value: string): string | null {
  const percentMatch = value.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (undefined === percentMatch?.[1]) {
    return null;
  }

  return withPercentGrowthDirection(formatPercent(Number.parseFloat(percentMatch[1])), value);
}

function getPercentRangeOutlookValue(value: string): string | null {
  const percentRangeMatch = value.match(/(-?\d+(?:\.\d+)?)\s*%\s*(?:to|through|-|–|and)\s*(-?\d+(?:\.\d+)?)\s*%/i);
  return undefined !== percentRangeMatch?.[1] && undefined !== percentRangeMatch[2]
    ? `${formatPercent(Number.parseFloat(percentRangeMatch[1]))} to ${formatPercent(Number.parseFloat(percentRangeMatch[2]))}`
    : null;
}

function withPercentGrowthDirection(value: string, source: string): string {
  if (/\b(?:decline|decrease|down|lower)\b/i.test(source)) {
    return `${value} decline`;
  }

  if (/\b(?:growth|grow|increase|up|higher)\b/i.test(source)) {
    return `${value} growth`;
  }

  return value;
}

function findNumericValue(
  text: string,
  options: {maxAbsValue?: number; skipPercentages?: boolean;} = {},
): number | null {
  const numberMatches = text.matchAll(/\(?-?(?:[$€£¥]\s*|\b(?:USD|EUR|GBP|JPY)\s+)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?/gi);
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

    if ("number" === typeof options.maxAbsValue && Math.abs(value) > options.maxAbsValue) {
      continue;
    }

    return value;
  }

  return null;
}

function parseNumber(value: unknown): number | null {
  if ("number" === typeof value) {
    return Number.isFinite(value) ? value : null;
  }

  if ("string" !== typeof value) {
    return null;
  }

  const normalizedValue = value
    .replace(/^\((.*)\)$/, "-$1")
    .replace(/[€£¥$]/g, "")
    .replace(/\b(?:usd|eur|gbp|jpy)\b/gi, "")
    .replaceAll(",", "")
    .replaceAll("%", "")
    .trim()
    .toLowerCase();

  if ("" === normalizedValue || "--" === normalizedValue || "n/a" === normalizedValue) {
    return null;
  }

  const parsedValue = Number.parseFloat(normalizedValue);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function parseMoneyWithOptionalUnit(
  value: string,
  inferredUnit?: string,
  inferredCurrencyCode = "USD",
): ParsedMoneyValue | null {
  const parsedValue = parseNumber(value);
  if (null === parsedValue) {
    return null;
  }

  const unit = getMoneyUnit(value) ?? inferredUnit;
  const currencyCode = getCurrencyCodeFromText(value) ?? inferredCurrencyCode;
  let moneyValue = parsedValue;
  if (!unit) {
    return {
      currencyCode,
      value: moneyValue,
    };
  }

  if ("trillion" === unit || "trillions" === unit || "tn" === unit || "t" === unit) {
    moneyValue = parsedValue * 1_000_000_000_000;
  } else if ("billion" === unit || "billions" === unit || "bn" === unit || "b" === unit) {
    moneyValue = parsedValue * 1_000_000_000;
  } else if ("thousand" === unit || "thousands" === unit || "k" === unit) {
    moneyValue = parsedValue * 1_000;
  } else {
    moneyValue = parsedValue * 1_000_000;
  }

  return {
    currencyCode,
    value: moneyValue,
  };
}

function hasMoneyValueCue(value: string): boolean {
  return /[$€£¥]|\b(?:USD|EUR|GBP|JPY)\b/i.test(value) || undefined !== getMoneyUnit(value);
}

function getMoneyUnit(value: string): string | undefined {
  return value.match(/(trillions?|billions?|millions?|thousands?|tn|bn|mm|[tbmk])\b/i)?.[1]?.toLowerCase();
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

  if (text.includes("$") || /\bUSD\b/i.test(text)) {
    return "USD";
  }

  return undefined;
}

function formatEps(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2).replace(/\.?0+$/, "")}`;
}

function formatMoneyCompact(value: number, currencyCode: string): string {
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
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function formatPercent(value: number): string {
  return `${formatDecimal(value)}%`;
}
