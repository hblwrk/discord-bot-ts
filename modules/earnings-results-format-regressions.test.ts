import {describe, expect, test} from "vitest";
import {parseEarningsDocument} from "./earnings-results-format.ts";

describe("earnings result filing regressions", () => {
  test("uses Chevron current-quarter narrative values instead of footnotes and YTD table columns", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Chevron Reports Second Quarter 2026 Results</h1>
          <p>Chevron Corporation reported earnings of $12.1 billion ($6.11 per share - diluted) for second quarter 2026. Adjusted earnings were $12.0 billion ($6.06 per share - diluted) for second quarter 2026.</p>
          <p>Financial information is presented in millions of dollars, except per-share amounts.</p>
          <p>2Q 2026 | 1Q 2026 | 2Q 2025 | YTD 2026 | YTD 2025</p>
          <p>Adjusted Earnings Per Share - Diluted (1)</p>
          <p>6.06 | 1.41 | 1.77 | 7.46 | 3.95</p>
          <p>Earnings Per Common Share | Basic | 6.18 | 1.14 | 1.48 | 7.29 | 3.50 | Diluted | 6.11 | 1.11 | 1.45 | 7.21 | 3.45</p>
          <p>Sales and Other Operating Revenues | 67,199 | 44,375 | 47,728 | 114,755 | 90,476</p>
          <p>Net Income | 12,214 | 2,515 | 2,498 | 14,507 | 6,027</p>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q2 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "adjusted_eps", numericValue: 6.06, value: "$6.06"}),
      expect.objectContaining({key: "gaap_eps", numericValue: 6.11, value: "$6.11"}),
      expect.objectContaining({key: "revenue", numericValue: 67_199_000_000, value: "$67.2B"}),
      expect.objectContaining({key: "net_income", numericValue: 12_214_000_000, value: "$12.21B"}),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("-$1.00");
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$3.45");
  });

  test("keeps Exxon operating volumes out of revenue and binds production to its table row", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExxonMobil Announces Second-Quarter 2026 Results</h1>
          <p>Financial information is presented in millions of dollars, except per-share amounts.</p>
          <p>2Q26</p><p>1Q26</p><p>Change vs 1Q26</p><p>YTD 2026</p><p>YTD 2025</p>
          <p>3.48</p><p>| 1.00</p><p>| +2.48</p>
          <p>| Earnings Per Common Share (U.S. GAAP)</p>
          <p>| 4.47</p><p>| 3.40</p><p>| +1.07</p>
          <p>5,698</p><p>| 5,630</p>
          <p>| Energy Products Sales (kbd)</p>
          <p>| 5,664</p><p>| 5,436</p>
          <p>Production highlights included a fifth Guyana FPSO startup on plan for 4Q26, increasing capacity by 250 Kbd.</p>
          <p>4,514</p><p>| 4,594</p>
          <p>| Production (koebd)</p>
          <p>| 4,554</p><p>| 4,591</p>
          <p>Proceeds from asset sales and returns of investments | 734 | 339 | 430 | 219</p>
          <p>Second-quarter earnings were $14.5 billion, or $3.48 per share. Adjusted earnings were $14.7 billion, or $3.52 per share.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q2 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "adjusted_eps", numericValue: 3.52, value: "$3.52"}),
      expect.objectContaining({key: "gaap_eps", numericValue: 3.48, value: "$3.48"}),
      expect.objectContaining({key: "production", numericValue: 4514, value: "4,514 koebd"}),
    ]));
    expect(parsedDocument.metrics.find(metric => "revenue" === metric.key)).toBeUndefined();
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$4.47");
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("4 Kbd");
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("250 Kbd");
  });
});
