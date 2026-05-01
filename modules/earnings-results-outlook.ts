
export type EarningsOutlookMetric = {
  key: string;
  label: string;
  value: string;
};

type OutlookValueType = "eps" | "money" | "percent" | "text";

type OutlookMetricDefinition = {
  key: string;
  label: string;
  patterns: RegExp[];
  valueType: OutlookValueType;
};

const outlookMetricDefinitions: OutlookMetricDefinition[] = [
  {
    key: "revenue",
    label: "Revenue",
    patterns: [/\brevenues?\b/i, /\bnet\s+sales\b/i],
    valueType: "text",
  },
  {
    key: "eps",
    label: "EPS",
    patterns: [/\b(?:diluted\s+)?eps\b/i, /\bearnings\s+per\s+(?:common\s+)?share\b/i],
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
  const sectionLines = getOutlookSectionLines(lines);
  if (0 === sectionLines.length) {
    return [];
  }

  const metrics: EarningsOutlookMetric[] = [];
  const seenKeys = new Set<string>();
  for (const definition of outlookMetricDefinitions) {
    const metric = extractOutlookMetric(sectionLines, definition);
    if (null === metric || true === seenKeys.has(metric.key)) {
      continue;
    }

    metrics.push(metric);
    seenKeys.add(metric.key);
  }

  return metrics.slice(0, 6);
}

function getOutlookSectionLines(lines: string[]): string[] {
  const sectionLines: string[] = [];
  let collecting = false;

  for (const line of lines) {
    if (true === isOutlookHeading(line)) {
      collecting = true;
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

  return sectionLines;
}

function isOutlookHeading(line: string): boolean {
  return line.length <= 140 &&
    /\b(?:outlook|guidance|business\s+outlook|financial\s+outlook|fiscal\s+\d{4}\s+outlook|quarter\s+outlook)\b/i.test(line) &&
    false === /\bforward-looking\s+statements?\b/i.test(line);
}

function isOutlookSectionEnd(line: string): boolean {
  if (/\b(?:forward-looking\s+statements?|safe\s+harbor|conference\s+call|about\s+|press\s+contact|investor\s+relations|condensed\s+consolidated|financial\s+statements?|non-gaap|reconciliation)\b/i.test(line)) {
    return true;
  }

  return line.length <= 90 &&
    /^(?:results|balance\s+sheets?|cash\s+flows?|appendix|contacts?|media|webcast)$/i.test(line);
}

function extractOutlookMetric(
  lines: string[],
  definition: OutlookMetricDefinition,
): EarningsOutlookMetric | null {
  for (const line of lines) {
    const pattern = definition.patterns.find(candidatePattern => candidatePattern.test(line));
    if (!pattern) {
      continue;
    }

    const value = extractOutlookValue(line, pattern, definition.valueType);
    if (null === value) {
      continue;
    }

    return {
      key: definition.key,
      label: definition.label,
      value,
    };
  }

  return null;
}

function extractOutlookValue(
  line: string,
  pattern: RegExp,
  valueType: OutlookValueType,
): string | null {
  pattern.lastIndex = 0;
  const patternMatch = pattern.exec(line);
  const rawValueText = patternMatch ? line.slice(patternMatch.index + patternMatch[0].length) : line;
  const valueText = normalizeOutlookValueText(rawValueText);
  if ("" === valueText) {
    return null;
  }

  return getGrowthOutlookValue(valueText) ??
    getOutlookRangeValue(valueText, valueType) ??
    getSingleOutlookValue(valueText, valueType) ??
    getFallbackOutlookValue(valueText);
}

function normalizeOutlookValueText(value: string): string {
  return value
    .replace(/^[\s:|,-]+/, "")
    .replace(/\b(?:is|are|was|were|to\s+be|of|at|approximately|about|around|roughly|expected|expects|expect|guidance|outlook|projected|forecast|in\s+the\s+range\s+of|between)\b/gi, " ")
    .replace(/\bto\s+(?:grow|increase|decline|decrease|range)\b/gi, " ")
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

function getOutlookRangeValue(value: string, valueType: OutlookValueType): string | null {
  if ("percent" === valueType) {
    const percentRangeMatch = value.match(/(-?\d+(?:\.\d+)?)\s*%\s*(?:to|through|-|–|and)\s*(-?\d+(?:\.\d+)?)\s*%/i);
    return undefined !== percentRangeMatch?.[1] && undefined !== percentRangeMatch[2]
      ? `${formatPercent(Number.parseFloat(percentRangeMatch[1]))} to ${formatPercent(Number.parseFloat(percentRangeMatch[2]))}`
      : null;
  }

  const moneyRangeMatch = value.match(/(\$?\s*-?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:trillion|billion|million|t|b|m)?)(?:\s*(?:to|through|-|–|and)\s*)(\$?\s*-?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:trillion|billion|million|t|b|m)?)/i);
  if (!moneyRangeMatch) {
    return null;
  }

  const firstRangeValue = moneyRangeMatch[1];
  const secondRangeValue = moneyRangeMatch[2];
  if (undefined === firstRangeValue || undefined === secondRangeValue) {
    return null;
  }

  if ("eps" === valueType) {
    const firstValue = parseNumber(firstRangeValue);
    const secondValue = parseNumber(secondRangeValue);
    return null === firstValue || null === secondValue
      ? null
      : `${formatEps(firstValue)} to ${formatEps(secondValue)}`;
  }

  const inferredUnit = getMoneyUnit(secondRangeValue) ?? getMoneyUnit(firstRangeValue);
  const firstMoneyValue = parseMoneyWithOptionalUnit(firstRangeValue, inferredUnit);
  const secondMoneyValue = parseMoneyWithOptionalUnit(secondRangeValue, inferredUnit);
  return null === firstMoneyValue || null === secondMoneyValue
    ? null
    : `${formatUsdCompact(firstMoneyValue)} to ${formatUsdCompact(secondMoneyValue)}`;
}

function getSingleOutlookValue(value: string, valueType: OutlookValueType): string | null {
  if ("percent" === valueType) {
    const percentMatch = value.match(/-?\d+(?:\.\d+)?\s*%/);
    return percentMatch ? percentMatch[0].replace(/\s+/g, "") : null;
  }

  if ("eps" === valueType) {
    const epsValue = findNumericValue(value, {maxAbsValue: 100});
    return null === epsValue ? null : formatEps(epsValue);
  }

  if ("money" === valueType) {
    const moneyMatch = value.match(/\$?\s*-?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:trillion|billion|million|t|b|m)/i);
    const moneyValue = moneyMatch ? parseMoneyWithOptionalUnit(moneyMatch[0]) : null;
    return null === moneyValue ? null : formatUsdCompact(moneyValue);
  }

  return null;
}

function getFallbackOutlookValue(value: string): string | null {
  const fallbackValue = value.split(/[.;]/)[0]?.trim() ?? "";
  if (fallbackValue.length < 2 || fallbackValue.length > 80) {
    return null;
  }

  return fallbackValue;
}

function findNumericValue(
  text: string,
  options: {maxAbsValue?: number; skipPercentages?: boolean;} = {},
): number | null {
  const numberMatches = text.matchAll(/\(?-?\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?|\(?-?\$?\d+(?:\.\d+)?\)?/g);
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
    .replaceAll("$", "")
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

function parseMoneyWithOptionalUnit(value: string, inferredUnit?: string): number | null {
  const parsedValue = parseNumber(value);
  if (null === parsedValue) {
    return null;
  }

  const unit = getMoneyUnit(value) ?? inferredUnit;
  if (!unit) {
    return parsedValue;
  }

  if ("trillion" === unit || "t" === unit) {
    return parsedValue * 1_000_000_000_000;
  }

  if ("billion" === unit || "b" === unit) {
    return parsedValue * 1_000_000_000;
  }

  return parsedValue * 1_000_000;
}

function getMoneyUnit(value: string): string | undefined {
  return value.match(/(trillion|billion|million|[tbm])\b/i)?.[1]?.toLowerCase();
}

function formatEps(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2).replace(/\.?0+$/, "")}`;
}

function formatUsdCompact(value: number): string {
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

  return `${sign}$${formatDecimal(absoluteValue)}`;
}

function formatDecimal(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatPercent(value: number): string {
  return `${formatDecimal(value)}%`;
}
