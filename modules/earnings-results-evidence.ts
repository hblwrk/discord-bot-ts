import {parseEarningsDocument, type EarningsResultMetric} from "./earnings-results-format.ts";
import {getDocumentCurrencyCode, getMeaningfulLines} from "./earnings-results-document.ts";
import {findEpsValue, getMoneyScaleFromContextText} from "./earnings-results-money.ts";

/** Decode doubled whitespace escapes without removing words, numbers or table cells. */
export function normalizeFilingEvidence(value: string): string {
  return value.replace(/\\[nrt]/g, " ").replace(/\s*\|\s*/g, " | ").replace(/\s+/g, " ").trim();
}

export function hasExactFilingSnippet(sourceText: string, snippet: string): boolean {
  const normalized = normalizeFilingEvidence(snippet);
  return normalized.length >= 12 && normalizeFilingEvidence(sourceText).toLowerCase().includes(normalized.toLowerCase());
}

/** A quoted passage must independently support the selected metric's signed value. */
export function isMetricSupportedByFilingSnippet(
  metric: EarningsResultMetric,
  snippet: string,
  sourceText: string,
): boolean {
  if ("number" !== typeof metric.numericValue || false === Number.isFinite(metric.numericValue)) {
    return false;
  }
  const normalizedSnippet = normalizeFilingEvidence(snippet);
  const normalizedSource = normalizeFilingEvidence(sourceText);
  const index = normalizedSource.toLowerCase().indexOf(normalizedSnippet.toLowerCase());
  if (normalizedSnippet.length < 12 || index < 0) {
    return false;
  }

  // A table row can omit the unit declaration. Use the nearest preceding
  // declaration from its actual filing context, never an assumed scale.
  const context = normalizedSource.slice(Math.max(0, index - 2_500), index);
  const declarations = [...context.matchAll(/(?:\bin\s+|[$€£¥]\s*,?\s*|\b(?:USD|CAD|TWD|NTD|EUR|GBP|JPY|CHF)\s*,?\s*)(?:thousand|million|billion)s?\b|\b(?:thousand|million|billion)s?\s+of\s+dollars\b|\(\s*[$€£¥]?\s*0{3}s?\b/gi)];
  const declaration = declarations.at(-1)?.[0];
  const scale = undefined === declaration ? null : getMoneyScaleFromContextText(declaration);
  const unit = 1_000 === scale ? "thousands" : 1_000_000 === scale ? "millions" : 1_000_000_000 === scale ? "billions" : null;
  const currency = getDocumentCurrencyCode(getMeaningfulLines(sourceText));
  const evidence = parseEarningsDocument([
    currency ?? "",
    null === unit ? "" : `Amounts in ${unit}`,
    normalizedSnippet,
  ].join("\n")).metrics.find(candidate => candidate.key === metric.key) ?? getExplicitPerShareEvidence(metric.key, normalizedSnippet, currency);
  if (undefined === evidence || "number" !== typeof evidence.numericValue ||
      Math.sign(evidence.numericValue) !== Math.sign(metric.numericValue) ||
      (undefined !== metric.currencyCode && undefined !== evidence.currencyCode && metric.currencyCode !== evidence.currencyCode)) {
    return false;
  }

  const perShare = ["gaap_eps", "adjusted_eps", "affo_per_share", "nasdaq_eps"].includes(metric.key);
  const tolerance = perShare ? 0.005 : Math.max(1, Math.abs(metric.numericValue) * 0.005);
  return Math.abs(evidence.numericValue - metric.numericValue) <= tolerance;
}

function getExplicitPerShareEvidence(key: string, snippet: string, currencyCode: string | undefined): EarningsResultMetric | undefined {
  if ("gaap_eps" !== key && "adjusted_eps" !== key) {
    return undefined;
  }
  const captionMatch = /\b(?:(non-gaap|adjusted|gaap)\s+)?(?:net\s+)?(loss)\s+per\s+(?:common\s+)?(?:diluted\s+)?share\s+(?:was\s+|of\s+|is\s+)?(\(?-?(?:[$€£¥]\s*)?\(?\d+(?:\.\d+)?\)?)/i.exec(snippet);
  const narrativeMatch = /\b(?:(non-gaap|adjusted|gaap)\s+)?net\s+(income|loss)\b(?:(?![.!?]\s)[^!?\n]){0,180}?\bor\s+(\(?-?(?:[$€£¥]\s*)?\(?\d+(?:\.\d+)?\)?)\s+per\s+(?:common\s+)?(?:basic\s+|diluted\s+)?share\b/i.exec(snippet);
  const match = captionMatch ?? narrativeMatch;
  if (null === match || ("adjusted_eps" === key) !== /^(?:non-gaap|adjusted)$/i.test(match[1] ?? "")) {
    return undefined;
  }
  const value = findEpsValue(match[3] ?? "", 0);
  if (null === value) {
    return undefined;
  }
  const numericValue = "loss" === match[2]?.toLowerCase() ? -Math.abs(value) : value;
  return {key, label: key, value: String(numericValue), numericValue, currencyCode};
}
