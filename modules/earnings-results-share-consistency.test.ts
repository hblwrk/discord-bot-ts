import {readFileSync, readdirSync} from "node:fs";
import {describe, expect, test} from "vitest";
import {getInconsistentPerShareReasons} from "./earnings-results-ai.ts";
import {parseEarningsDocument} from "./earnings-results-format.ts";
import {type EarningsResultMetric} from "./earnings-results-metrics.ts";

const fixtureDirectory = "modules/test-fixtures/earnings-filings";

const asMetrics = (netIncome: number, eps: number): EarningsResultMetric[] => [
  {key: "net_income", label: "Net income", numericValue: netIncome, value: "x"},
  {key: "gaap_eps", label: "EPS", numericValue: eps, value: `$${eps.toFixed(2)}`},
];

describe("per-share consistency gate", () => {
  // A false positive suppresses a correct announcement, so silence on audited filings is the
  // property that matters most.
  test("stays silent on every audited filing", () => {
    const flagged: string[] = [];
    for (const fixture of readdirSync(fixtureDirectory).filter(name => name.endsWith(".txt"))) {
      const document = parseEarningsDocument(readFileSync(`${fixtureDirectory}/${fixture}`, "utf8"));
      const reasons = getInconsistentPerShareReasons(document.metrics, document.dilutedShareMantissa);
      if (0 < reasons.length) {
        flagged.push(fixture.replace(".txt", ""));
      }
    }

    expect(flagged).toEqual([]);
  });

  test("flags a per-share figure taken from the prior-year column", () => {
    // Uber reported $0.63 against $1.17; the count is printed in thousands.
    expect(getInconsistentPerShareReasons(asMetrics(2_394_000_000, 0.63), 2_125_628))
      .toEqual([expect.objectContaining({metricKey: "gaap_eps", severity: "high"})]);
    expect(getInconsistentPerShareReasons(asMetrics(2_394_000_000, 1.17), 2_125_628)).toEqual([]);
  });

  test("flags a per-share figure off by a factor of a hundred", () => {
    // Pfizer reported -$4.00 against -$0.04; the count is printed in millions.
    expect(getInconsistentPerShareReasons(asMetrics(-248_000_000, -4), 5_734))
      .toEqual([expect.objectContaining({metricKey: "gaap_eps", severity: "high"})]);
    expect(getInconsistentPerShareReasons(asMetrics(-248_000_000, -0.04), 5_734)).toEqual([]);
  });

  test("reads the count regardless of the scale it is printed in", () => {
    for (const mantissa of [2_046, 2_046_000, 2_046_000_000]) {
      expect(getInconsistentPerShareReasons(asMetrics(2_394_000_000, 1.17), mantissa)).toEqual([]);
    }
  });

  test("says nothing when a figure is too rounded to reconcile", () => {
    // Wayfair's "-$0.01" on a "$1 million" loss reconciles to anywhere from 67M to 200M shares.
    expect(getInconsistentPerShareReasons(asMetrics(-1_000_000, -0.01), 132)).toEqual([]);
  });

  test("says nothing when the filing states no share count", () => {
    expect(getInconsistentPerShareReasons(asMetrics(2_394_000_000, 0.63), undefined)).toEqual([]);
  });

  // A caption the reader does not recognise leaves the filing with no count, and a filing with
  // no count is exempt from the check rather than failing it — so an unread caption is a hole
  // in the gate, not a visible error. Merck captions the row without the word "weighted".
  test("reads a share count captioned without the word weighted", () => {
    const document = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo Reports Second Quarter 2026 Results</h1>
          <p>($ in millions except per share amounts)</p>
          <p>Three Months Ended June 30,</p>
          <tr><td>Net Income (Loss)</td><td>$</td><td>(1,330)</td></tr>
          <tr><td>Loss per Common Share Assuming Dilution</td><td>$</td><td>(0.54)</td></tr>
          <tr><td>Average Shares Outstanding Assuming Dilution</td><td>2,470</td></tr>
        </body>
      </html>
    `);

    expect(document.dilutedShareMantissa).toBe(2_470);
    expect(getInconsistentPerShareReasons(document.metrics, document.dilutedShareMantissa))
      .toEqual([]);
  });
});
