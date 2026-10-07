import {readFileSync} from "node:fs";
import {describe, expect, test} from "vitest";
import {hasExactFilingSnippet, isMetricSupportedByFilingSnippet} from "./earnings-results-evidence.ts";
import type {EarningsResultMetric} from "./earnings-results-format.ts";

const metric = (key: string, numericValue: number, currencyCode = "USD"): EarningsResultMetric => ({key, label: key, value: String(numericValue), numericValue, currencyCode});

describe("AI filing-value evidence", () => {
  test("normalizes doubled whitespace escapes only when the resulting quotation exists", () => {
    expect(hasExactFilingSnippet("Revenue\nwas $40 million.", "Revenue\\nwas $40 million.")).toBe(true);
    expect(hasExactFilingSnippet("Revenue was $40 million.", "Revenue\\nwas $42 million.")).toBe(false);
    expect(hasExactFilingSnippet("Revenue was $40 million.", "Revenue ... $40 million.")).toBe(false);
    expect(hasExactFilingSnippet("Revenue was $40 million.", "Revenue")).toBe(false);
  });

  test.each([
    ["GAAP diluted earnings per share were $0.09.", 0.09, true],
    ["GAAP diluted earnings per share were $0.09.", -0.09, false],
    ["GAAP net loss per diluted share was $0.13.", -0.13, true],
    ["GAAP net loss per diluted share was $0.13.", 0.13, false],
    ["GAAP diluted EPS | $ | (0.54) | $ | 1.76 |", -0.54, true],
    ["GAAP diluted EPS | $ | (0.54) | $ | 1.76 |", 0.54, false],
    ["Non-GAAP diluted EPS was $0.13.", 0.13, false],
    ["Net loss was $22.8 million, or $0.28 per basic share, compared with a loss of $9.1 million a year earlier.", -0.28, true],
    ["Net loss was $22.8 million, or $0.28 per basic share, compared with a loss of $9.1 million a year earlier.", 0.28, false],
    ["GAAP diluted EPS was $0.001.", -0.001, false],
  ])("checks signed GAAP EPS in %s", (snippet, value, supported) => {
    expect(isMetricSupportedByFilingSnippet(metric("gaap_eps", value), snippet, snippet)).toBe(supported);
  });

  test("uses the current loss rather than a prior-quarter figure in the focused real-filing quotation", () => {
    const source = readFileSync(new URL("./test-fixtures/earnings-regressions/ai-quoted-loss-vs-prior-quarter.txt", import.meta.url), "utf8");
    const snippet = source.split("\n")[1] ?? "";
    expect(isMetricSupportedByFilingSnippet(metric("gaap_eps", -0.28), snippet, source)).toBe(true);
    expect(isMetricSupportedByFilingSnippet(metric("gaap_eps", 0.28), snippet, source)).toBe(false);
    expect(isMetricSupportedByFilingSnippet(metric("gaap_eps", -0.16), snippet, source)).toBe(false);
  });

  test("rejects a quoted heading without a metric value", () => {
    const snippet = "2026 Second Quarter Financial Results";
    expect(isMetricSupportedByFilingSnippet(metric("revenue", 40_000_000), snippet, snippet)).toBe(false);
  });

  test("uses the nearest real table-scale declaration and rejects a thousand-fold error", () => {
    const snippet = "Revenue | $ | 40,000 | $ | 38,000 |";
    const source = `Earlier table (in millions)\nOther revenue | $ | 1 |\nCurrent quarter (in thousands)\n${snippet}`;
    expect(isMetricSupportedByFilingSnippet(metric("revenue", 40_000_000), snippet, source)).toBe(true);
    expect(isMetricSupportedByFilingSnippet(metric("revenue", 40_000_000_000), snippet, source)).toBe(false);
  });

  test("does not invent a table scale when the declaration is absent", () => {
    const snippet = "Revenue | $ | 40,000 | $ | 38,000 |";
    expect(isMetricSupportedByFilingSnippet(metric("revenue", 40_000_000), snippet, snippet)).toBe(false);
  });

  test("keeps inline money units and currency separate from table units", () => {
    const snippet = "Revenue reached C$40 million in the quarter.";
    const source = `Amounts in thousands\n${snippet}`;
    expect(isMetricSupportedByFilingSnippet(metric("revenue", 40_000_000, "CAD"), snippet, source)).toBe(true);
    expect(isMetricSupportedByFilingSnippet(metric("revenue", 40_000_000, "USD"), snippet, source)).toBe(false);
  });

  test("accepts ordinary rounding without accepting a reversed sign", () => {
    const snippet = "Net income was $153.1 million in the reported quarter.";
    expect(isMetricSupportedByFilingSnippet(metric("net_income", 153_090_000), snippet, snippet)).toBe(true);
    expect(isMetricSupportedByFilingSnippet(metric("net_income", -153_090_000), snippet, snippet)).toBe(false);
  });

  test("rejects missing and non-finite numeric values and fabricated quotations", () => {
    const snippet = "Revenue reached $40 million in the quarter.";
    expect(isMetricSupportedByFilingSnippet(metric("revenue", Number.NaN), snippet, snippet)).toBe(false);
    expect(isMetricSupportedByFilingSnippet({key: "revenue", label: "Revenue", value: "$40M"}, snippet, snippet)).toBe(false);
    expect(isMetricSupportedByFilingSnippet(metric("revenue", 40_000_000), snippet, "Revenue reached $42 million.")).toBe(false);
  });
});
