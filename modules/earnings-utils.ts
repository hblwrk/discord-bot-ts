import {unknownValueLabel} from "./earnings-types.ts";

const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function getNormalizedString(value: unknown): string | null {
  if ("string" !== typeof value) {
    return null;
  }

  const normalizedValue = value.trim();
  if (0 === normalizedValue.length) {
    return null;
  }

  return normalizedValue;
}

export function getNumericValueFromNasdaqCapString(value: string): number | null {
  const normalizedValue = value
    .replaceAll(",", "")
    .replaceAll("$", "")
    .trim()
    .toUpperCase();

  const unitMatch = normalizedValue.match(/^([0-9]*\.?[0-9]+)\s*([TMBK])$/);
  if (null !== unitMatch) {
    const numericToken = unitMatch[1];
    const unitToken = unitMatch[2];
    if (undefined === numericToken || undefined === unitToken) {
      return null;
    }

    const parsedValue = Number.parseFloat(numericToken);
    if (false === Number.isFinite(parsedValue)) {
      return null;
    }

    if ("T" === unitToken) {
      return parsedValue * 1_000_000_000_000;
    }

    if ("B" === unitToken) {
      return parsedValue * 1_000_000_000;
    }

    if ("M" === unitToken) {
      return parsedValue * 1_000_000;
    }

    return parsedValue * 1_000;
  }

  const directNumber = Number.parseFloat(normalizedValue);
  if (false === Number.isFinite(directNumber)) {
    return null;
  }

  return directNumber;
}

export function formatMarketCapUsdShort(value: number): string {
  return "$" + compactUsdFormatter.format(value);
}

export function getKnownValueOrFallback(value: unknown): string {
  return getNormalizedString(value) ?? unknownValueLabel;
}
