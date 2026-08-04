import {isEmbeddedAlphaNumericValue} from "./earnings-results-format-selection.ts";

export type MoneyContext = {
  currencyCode?: string | undefined;
  scale: number;
};

export type NumericValueOptions = {
  maxAbsValue?: number;
  minUncuedAbsValue?: number;
  parseCents?: boolean;
  requireMoneyCue?: boolean;
  skipPercentages?: boolean;
  skipTableNoteRefs?: boolean;
};

export type NumericValueMatch = {
  endIndex: number;
  value: number;
};

export function findNumericValue(
  text: string,
  options: NumericValueOptions = {},
): number | null {
  return findNumericValueMatch(text, options)?.value ?? null;
}

export function findNumericValueMatch(
  text: string,
  options: NumericValueOptions = {},
): NumericValueMatch | null {
  return findNumericValueMatches(text, options)[0] ?? null;
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

    if (value >= 1900 && value <= 2100) {
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

export function findEpsValue(text: string): number | null {
  const options = {
    maxAbsValue: 100,
    parseCents: true,
    skipPercentages: true,
  };
  const currencyValue = findNumericValue(text, {
    ...options,
    requireMoneyCue: true,
  });
  if (null !== currencyValue) {
    return currencyValue;
  }

  return true === isMetricLabelSuffixTableNote(text)
    ? null
    : findNumericValue(text, options);
}

export function findPerShareTableValue(text: string): number | null {
  const hasTableSegments = /\bBasic\b/i.test(text) || 2 <= (text.match(/\|/g)?.length ?? 0);
  if (false === hasTableSegments) {
    return null;
  }

  return getLastPerShareSegmentValue(text, "Diluted") ?? getLastPerShareSegmentValue(text, "Basic");
}

function getLastPerShareSegmentValue(text: string, label: "Basic" | "Diluted"): number | null {
  const segmentMatch = new RegExp(`\\b${label}\\b([\\s\\S]*?)(?:\\b(?:Basic|Diluted|Weighted-average)\\b|$)`, "i")
    .exec(text);
  const segment = segmentMatch?.[1];
  if (undefined === segment) {
    return null;
  }

  const values = findNumericValues(segment, {
    maxAbsValue: 100,
    parseCents: true,
  });
  return values[values.length - 1] ?? null;
}

export function isMetricLabelSuffixTableNote(text: string): boolean {
  return /^\s*\(?\d{1,2}\)?\s*$/.test(text);
}

export function getMoneyScaleFromContextText(text: string): number | null {
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

export function getCurrencyCodeFromText(
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

export function getExplicitMoneyScale(text: string, valueEndIndex: number): number | null {
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

export function getMoneyDisplayPrecision(
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

export function formatPlainNumber(value: number, unit: string | null): string {
  const numberText = Number.isInteger(value)
    ? value.toLocaleString("en-US", {maximumFractionDigits: 0})
    : value.toLocaleString("en-US", {maximumFractionDigits: 2});
  return unit ? `${numberText} ${unit}` : numberText;
}

export function getTrailingUnit(text: string): string | null {
  const unitMatch = text.match(/\b(kbd|koebd|boepd|bpd|mmboe|bcfe|mmcf|mw|gw)\b/i);
  return unitMatch?.[1] ?? null;
}
