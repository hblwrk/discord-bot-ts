import {describe, expect, test} from "vitest";
import {parseEarningsDocument} from "./earnings-results-format.ts";

describe("earnings result metric selection", () => {
  test("ignores empty adjusted-EPS reconciliation rows", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example Reports Fourth Quarter and Fiscal Year 2026 Financial Results</h1>
      <p>Reported (GAAP) | Adjustments | Adjusted (Non-GAAP)</p>
      <p>EPS (diluted) | $ | — | | $ | —</p>
    `);

    expect(parsedDocument.metrics).toEqual([]);
  });

  test("reads adjusted-EPS reconciliation rows without repeated currency symbols", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example Reports Fourth Quarter and Fiscal Year 2026 Financial Results</h1>
      <p>Reported (GAAP) | Adjustments | Adjusted (Non-GAAP)</p>
      <p>EPS (diluted) | (0.16) | | (0.02)</p>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "adjusted_eps", value: "-$0.02"}),
    ]));
  });

  test("keeps GAAP totals across wrapped qualifiers and prior-year-first column headings", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example Announces Second Quarter 2026 Results</h1>
      <p>For the second quarter of 2026, total net revenues were</p>
      <p>US$453.8 million.</p>
      <p>VAS revenues for the second quarter of 2026 were US$72.9 million.</p>
      <p>Net income was US$67.4 million. Non-GAAP</p>
      <p>net income for the second quarter of 2026 was US$102.7 million.</p>
      <p>UNAUDITED CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS</p>
      <p>(In thousands of U.S. dollars, except per share data)</p>
      <p>Three months ended | Six months ended</p>
      <p>2025</p><p>2026</p><p>2025</p><p>2026</p>
      <p>Net revenues | 444,798 | 453,826 | 841,653 | 875,151</p>
      <p>Net income | 125,685 | 67,377 | 232,649 | 102,092</p>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "revenue", numericValue: 453_826_000, value: "$453.83M"}),
      expect.objectContaining({key: "net_income", numericValue: 67_400_000, value: "$67.4M"}),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toEqual(expect.arrayContaining([
      "$72.9M",
      "$102.7M",
      "$444.8M",
      "$125.69M",
    ]));
  });

  test("omits ordinary-share EPS when the watched US security is an ADS", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example Announces Second Quarter 2026 Results</h1>
      <p>Basic and diluted net loss per share was RMB0.02 (US$0.00).</p>
      <p>Outstanding ordinary shares were 4,501,784,337, equivalent to about 300,118,956 ADSs.</p>
      <p>Net loss was RMB93.0 million (US$13.7 million).</p>
    `);

    expect(parsedDocument.metrics.map(metric => metric.key)).not.toContain("gaap_eps");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "net_income", numericValue: -13_700_000, value: "-$13.7M"}),
    ]));
  });

  test("uses a reported diluted loss rather than a forecasted EPS table", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example Announces Second Quarter 2026 Results</h1>
      <h2>Second Quarter 2026 Financial Highlights</h2>
      <p>Diluted loss per share was $(2.02) on a GAAP basis and diluted earnings per share was $0.86 on a non-GAAP basis.</p>
      <h2>Forward-Looking Guidance</h2>
      <table>
        <tr><td>Forecasted GAAP diluted net income (loss) per share:</td><td>$0.39</td><td>$0.44</td></tr>
      </table>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "gaap_eps",
        numericValue: -2.02,
        value: "-$2.02",
      }),
    ]));
  });

  test("does not publish a forecasted per-share value as a reported result", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example Announces Second Quarter 2026 Results</h1>
      <table>
        <tr><td>Forecasted GAAP diluted net income per share:</td><td>$0.39</td><td>$0.44</td></tr>
      </table>
    `);

    expect(parsedDocument.metrics.map(metric => metric.key)).not.toContain("gaap_eps");
  });

  test("keeps fiscal-quarter highlights separate from full-year highlights", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example Reports Strong Fourth Quarter and Full-Year Results</h1>
      <h2>Highlights - Three Months Ended June 30, 2026</h2>
      <p>Net sales $6.4 billion.</p>
      <p>Net income $389 million.</p>
      <p>Diluted EPS of $0.83.</p>
      <p>Adjusted Diluted EPS of $1.23.</p>
      <h2>Highlights - Fiscal Year Ended June 30, 2026</h2>
      <p>Net sales $23.5 billion.</p>
      <p>Net income $1.1 billion.</p>
      <p>Diluted EPS of $2.38.</p>
      <p>Adjusted Diluted EPS of $4.02.</p>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q4 2026");
    expect(parsedDocument.metrics.map(metric => [metric.key, metric.value])).toEqual([
      ["adjusted_eps", "$1.23"],
      ["gaap_eps", "$0.83"],
      ["revenue", "$6.4B"],
      ["net_income", "$389M"],
    ]);
  });

  test("prefers total revenue over product and service components", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example reports second quarter 2026 results</h1>
      <p>Net product sales were $170.4 million.</p>
      <table>
        <tr><td>Net product sales</td><td>$170.382 million</td></tr>
        <tr><td>Service revenue</td><td>$1.297 million</td></tr>
        <tr><td>Total revenue</td><td>$171.679 million</td></tr>
      </table>
    `);

    expect(parsedDocument.metrics).toEqual([
      expect.objectContaining({
        key: "revenue",
        numericValue: 171_679_000,
        value: "$171.679M",
      }),
    ]);
  });

  test("parses mixed GAAP and footnoted adjusted EPS from an IBKR-style headline", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Interactive Brokers Group announces 2Q2026 results</h1>
          <p>GAAP DILUTED EPS OF $0.69, ADJUSTED<sup>1</sup> EPS OF $0.69</p>
          <p>Results for the quarter ended June 30, 2026.</p>
          <p>Reported and adjusted diluted earnings per share were both $0.69 for the current quarter. For the year-ago quarter, reported and adjusted diluted earnings per share were both $0.51.</p>
          <p>Earnings per share:</p>
          <p>Basic</p>
          <p>0.70</p>
          <p>0.51</p>
          <p>1.30</p>
          <p>1.00</p>
          <p>Diluted</p>
          <p>0.69</p>
          <p>0.51</p>
          <p>1.29</p>
          <p>0.99</p>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q2 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "adjusted_eps",
        numericValue: 0.69,
        value: "$0.69",
      }),
      expect.objectContaining({
        key: "gaap_eps",
        numericValue: 0.69,
        value: "$0.69",
      }),
    ]));
  });

  test("prefers ARM-style Q4 FYE section metrics over full-year figures", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <p>Arm delivered record-breaking results this quarter and in fiscal 2026.</p>
          <p>For the full year, revenue reached a record $4.92 billion. Non-GAAP EPS was also a record at $1.77.</p>
          <h2>Q4 FYE26 Financial Overview</h2>
          <p>Total revenue increased 20% year-over-year to $1,490 million.</p>
          <p>GAAP net income was $313 million.</p>
          <p>Non-GAAP fully diluted EPS was $0.60 compared with $0.55 in the same period a year ago.</p>
          <h2>Fiscal year 2026 financial overview</h2>
          <p>Total revenue increased 23% year-over-year to a record $4,920 million.</p>
          <p>Non-GAAP fully diluted EPS was $1.77 compared with $1.63 in the same period a year ago.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q4 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "adjusted_eps",
        value: "$0.60",
      }),
      expect.objectContaining({
        key: "revenue",
        value: "$1.49B",
      }),
      expect.objectContaining({
        key: "net_income",
        value: "$313M",
      }),
    ]));
    expect(parsedDocument.metrics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "revenue",
        value: "$4.92B",
      }),
    ]));
  });

  test("uses the quarter column and bare parenthetical scale in month-and-quarter releases", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Progressive reports June results</h1>
          <p>The company reported the following results for the month and quarter ended June 30, 2026:</p>
          <table>
            <tr><th></th><th>June</th><th>Quarter</th></tr>
            <tr><td>(millions, except per share amounts and ratios; unaudited)</td><td>2026</td><td>2025</td><td>Change</td><td>2026</td><td>2025</td><td>Change</td></tr>
            <tr><td>Net premiums earned</td><td>$</td><td>7,100</td><td>$</td><td>6,954</td><td>2</td><td>%</td><td>$</td><td>21,573</td><td>$</td><td>20,310</td><td>6</td><td>%</td></tr>
            <tr><td>Net income</td><td>$</td><td>779</td><td>$</td><td>1,124</td><td>(31)</td><td>%</td><td>$</td><td>3,311</td><td>$</td><td>3,175</td><td>4</td><td>%</td></tr>
          </table>
          <h2>Comprehensive income statement</h2>
          <p>For the month ended June 30, 2026</p>
          <p>(millions)</p>
          <table>
            <tr><td>Fees and other revenues</td><td>104</td></tr>
            <tr><td>Total revenues</td><td>7,568</td></tr>
            <tr><td>Net income</td><td>779</td></tr>
          </table>
          <h2>Comprehensive income statements</h2>
          <p>For the year-to-date periods ended June 30, 2026</p>
          <p>(millions)</p>
          <table>
            <tr><td>Total revenues</td><td>45,797</td></tr>
            <tr><td>Net income</td><td>6,129</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q2 2026");
    expect(parsedDocument.metrics).toEqual([
      expect.objectContaining({
        key: "net_income",
        numericValue: 3_311_000_000,
        value: "$3.31B",
      }),
    ]);
  });

  test("parses Shell-style revenue rows without treating sales volumes as revenue", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>1 st QUARTER 2026 UNAUDITED RESULTS</h1>
          <p>$ million</p>
          <p>527 | | (98) | | (247) | | Income/(loss) for the period | | | |</p>
          <p>72 | 72 | 76 | External power sales (terawatt hours)</p>
          <p>197 | 160 | 184 | Sales of pipeline gas to end-use customers (terawatt hours)</p>
          <p>69,691 | | 64,093 | | 69,234 | | Revenue 1</p>
          <p>1.01 | 0.72 | 0.79 | Basic earnings per share ($)</p>
          <p>1.22 | 0.57 | 0.92 | Adjusted Earnings per share ($)</p>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q1 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "revenue",
        value: "$69.69B",
      }),
      expect.objectContaining({
        key: "adjusted_eps",
        value: "$1.22",
      }),
      expect.objectContaining({
        key: "gaap_eps",
        value: "$1.01",
      }),
    ]));
    expect(parsedDocument.metrics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "revenue",
        value: "$527M",
      }),
    ]));
  });

  test("prefers quarter metrics when a Q4 release lists full-year results first", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Logitech Announces Q4 and Full Fiscal Year 2026 Results</h1>
          <p>For Fiscal Year 2026:</p>
          <p>Sales were $4.84 billion, up 6 percent compared to the prior year.</p>
          <p>GAAP earnings per share was $4.80. Non-GAAP EPS was $5.78.</p>
          <p>For Q4 Fiscal Year 2026:</p>
          <p>Sales were $1.09 billion, up 7 percent compared to Q4 of the prior year.</p>
          <p>GAAP EPS was $0.98. Non-GAAP EPS was $1.13.</p>
          <table>
            <tr><td>(In thousands, except per share amounts) - unaudited</td></tr>
            <tr><td>Three Months Ended</td></tr>
            <tr><td>March 31,</td></tr>
            <tr><td>Fiscal Years Ended</td></tr>
            <tr><td>March 31,</td></tr>
            <tr><td>GAAP CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS</td><td>2026</td><td>2025</td><td>2026</td><td>2025</td></tr>
            <tr><td>Net income</td><td>$</td><td>143,463</td><td>$</td><td>144,066</td><td>$</td><td>711,187</td><td>$</td><td>631,529</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q4 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "adjusted_eps",
        numericValue: 1.13,
        value: "$1.13",
      }),
      expect.objectContaining({
        key: "revenue",
        numericValue: 1_090_000_000,
        value: "$1.09B",
      }),
      expect.objectContaining({
        key: "net_income",
        numericValue: 143_463_000,
        value: "$143.46M",
      }),
    ]));
    expect(parsedDocument.metrics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "adjusted_eps",
        value: "$5.78",
      }),
      expect.objectContaining({
        key: "revenue",
        value: "$4.84B",
      }),
    ]));
  });

  test("skips generic production mentions without operational units", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Example reports Q1 2026 results</h1>
          <p>Company took delivery of a new venue featuring its latest in-house production on March 31, 2026.</p>
          <p>Production was 1,234 boepd.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "production",
        value: "1,234 boepd",
      }),
    ]));
    expect(parsedDocument.metrics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "production",
        value: "31",
      }),
    ]));
  });

  test("does not use per-share headline values as net income", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Example reports first quarter 2026 results</h1>
          <p>NET INCOME OF $0.78 PER SHARE AND CORE INCOME OF $0.83 PER SHARE</p>
          <p>Net income of $211 million versus $274 million in the prior year quarter.</p>
          <table>
            <tr><td>($ millions, except per share data)</td></tr>
            <tr><td>Non-insurance warranty revenue (expense)</td><td>18</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual([
      expect.objectContaining({
        key: "net_income",
        numericValue: 211_000_000,
        value: "$211M",
      }),
    ]);
  });

  test("does not let unrelated revenue scale turn per-share net income into an aggregate", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example reports fourth quarter 2026 results</h1>
      <p>In Q4 2026, revenue was $2.05 billion and GAAP net income was $1.19 per diluted share.</p>
      <p>CONDENSED CONSOLIDATED STATEMENTS OF EARNINGS</p>
      <p>(in millions, except per-share data)</p>
      <table><tr><td>Net earnings attributable to Example</td><td>$</td><td>240.5</td></tr></table>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "net_income", value: "$240.5M"}),
    ]));
    expect(parsedDocument.metrics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({key: "net_income", value: "$1.19"}),
    ]));
  });

  test("prefers GAAP total revenue over a quarter-specific core measure", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example reports second quarter 2026 results</h1>
      <p>In Q2 2026, Core revenue more than doubled to $210 million.</p>
      <p>CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS</p>
      <p>(in thousands)</p>
      <table><tr><td>GAAP Total revenue</td><td>$</td><td>180,100</td></tr></table>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "revenue", value: "$180.1M"}),
    ]));
  });

  test("reads per-share value introduced by non-GAAP net income", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example reports fourth quarter 2026 results</h1>
      <p>For the fourth quarter, non-GAAP net income was $4.9 billion, or $1.22 per diluted share.</p>
      <h2>Guidance</h2>
      <p>Non-GAAP EPS is expected to be $1.32 to $1.34.</p>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "adjusted_eps", value: "$1.22"}),
    ]));
  });

  test("uses Amazon quarterly EPS and consolidated sales instead of YTD and run-rate values", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>AMAZON.COM ANNOUNCES SECOND QUARTER RESULTS</h1>
          <h2>Second Quarter 2026</h2>
          <p>AWS net sales increased 37% year-over-year to a $169 billion annualized revenue run rate.</p>
          <p>Net sales increased 20% to $200.6 billion in the second quarter, compared with $167.7 billion in second quarter 2025.</p>
          <p>Net income increased to $62.6 billion in the second quarter, or $5.75 per diluted share, compared with $18.2 billion, or $1.68 per diluted share, in second quarter 2025.</p>
          <h2>Financial Guidance</h2>
          <p>Net sales are expected to be between $197.0 billion and $202.0 billion.</p>
          <p>Operating income is expected to be between $22.5 billion and $26.5 billion.</p>
          <h2>Consolidated Statements of Operations</h2>
          <p>(in millions, except per-share data; unaudited)</p>
          <table>
            <tr><th></th><th>Three Months Ended June 30,</th><th></th><th>Six Months Ended June 30,</th></tr>
            <tr><th></th><th>2025</th><th>2026</th><th>2025</th><th>2026</th></tr>
            <tr><td>Total net sales</td><td>167,702</td><td>200,606</td><td>323,369</td><td>382,125</td></tr>
            <tr><td>Net income</td><td>$18,164</td><td>$62,647</td><td>$35,291</td><td>$92,902</td></tr>
            <tr><td>Net income per share:</td></tr>
            <tr><td>Basic</td><td>$1.71</td><td>$5.82</td><td>$3.32</td><td>$8.64</td></tr>
            <tr><td>Diluted</td><td>$1.68</td><td>$5.75</td><td>$3.27</td><td>$8.53</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q2 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "gaap_eps",
        numericValue: 5.75,
        value: "$5.75",
      }),
      // Taken from the consolidated statement rather than the rounded narrative, so the
      // quarter column of a prior-year-first table ("2025 | 2026") must be selected.
      expect.objectContaining({
        key: "revenue",
        numericValue: 200_606_000_000,
        value: "$200.61B",
      }),
      expect.objectContaining({
        key: "net_income",
        numericValue: 62_647_000_000,
        value: "$62.65B",
      }),
    ]));
    expect(parsedDocument.metrics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", value: "$8.53"}),
      expect.objectContaining({key: "revenue", value: "$169B"}),
    ]));
    expect(parsedDocument.outlook).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        value: "$197B to $202B",
      },
      {
        key: "operating_income",
        label: "Operating income",
        value: "$22.5B to $26.5B",
      },
    ]);
  });

  test("uses translated ADS and currency columns from a foreign issuer statement", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example announces second quarter 2026 results</h1>
      <p>Amounts are translated into U.S. dollars.</p>
      <p>Non-GAAP diluted net income per ADS was RMB6.29 (US$0.93) for the second quarter of 2026.</p>
      <p>Unaudited statements of operations</p>
      <p>(In millions, except per share data)</p>
      <p>For the three months ended | For the six months ended |</p>
      <p>June 30,</p><p>2025</p><p>June 30,</p><p>2026</p><p>June 30,</p><p>2026</p>
      <p>June 30,</p><p>2025</p><p>June 30,</p><p>2026</p><p>June 30,</p><p>2026</p>
      <p>RMB</p><p>RMB</p><p>US$</p><p>RMB</p><p>RMB</p><p>US$</p>
      <table>
        <tr><td>Total net revenues</td><td>356,660</td><td>346,401</td><td>51,053</td><td>657,742</td><td>662,095</td><td>97,581</td></tr>
        <tr><td>Net income attributable to Example</td><td>6,178</td><td>7,129</td><td>1,051</td><td>17,068</td><td>12,231</td><td>1,803</td></tr>
      </table>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "adjusted_eps", value: "$0.93"}),
      expect.objectContaining({key: "revenue", value: "$51.05B"}),
      expect.objectContaining({key: "net_income", value: "$1.05B"}),
    ]));
  });

  test("keeps a translated revenue scale wrapped onto the next source line", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example announces second quarter 2026 results</h1>
      <p>Amounts are translated into U.S. dollars.</p>
      <p>Net revenues were RMB346.4 billion (US$<sup>1</sup>51.1
      billion) for the second quarter of 2026.</p>
    `);

    expect(parsedDocument.metrics).toEqual([
      expect.objectContaining({key: "revenue", value: "$51.1B"}),
    ]);
  });

  test("uses explicit US-dollar translations after Hong Kong dollar results", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example announces second quarter 2026 results</h1>
      <p>Total revenues increased to HK$7,200.2 million (US$918.2 million).</p>
      <p>Net income increased to HK$3,641.9 million (US$464.4 million).</p>
    `);

    expect(parsedDocument.metrics).toEqual([
      expect.objectContaining({key: "revenue", value: "$918.2M"}),
      expect.objectContaining({key: "net_income", value: "$464.4M"}),
    ]);
  });

  test("prefers quarterly net income over a four-quarter leverage reconciliation", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example reports second quarter 2026 results</h1>
      <p>Condensed consolidated statements of operations</p>
      <p>(in millions)</p>
      <p>Twelve Weeks Ended</p>
      <table><tr><td>Net income</td><td>55</td><td>15</td></tr></table>
      <p>Reconciliation of Adjusted Net Debt to Adjusted EBITDAR</p>
      <p>Four Quarters Ended</p>
      <table><tr><td>Net income (GAAP)</td><td>109</td></tr></table>
    `);

    expect(parsedDocument.metrics).toEqual([
      expect.objectContaining({key: "net_income", value: "$55M"}),
    ]);
  });

  test("prefers total revenue over product, service, and grant components", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example reports second quarter 2026 results</h1>
      <p>Condensed consolidated statements of operations</p>
      <p>(in thousands)</p>
      <table>
        <tr><td>Product revenue</td><td>$166,735</td></tr>
        <tr><td>Service revenue</td><td>$36,677</td></tr>
        <tr><td>Grant revenue</td><td>$2,756</td></tr>
        <tr><td>Total revenues</td><td>$206,168</td></tr>
      </table>
    `);

    expect(parsedDocument.metrics).toEqual([
      expect.objectContaining({key: "revenue", value: "$206.17M"}),
    ]);
  });

  test("prefers consolidated net sales over a rounded brand-results value", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example reports second quarter fiscal 2026 results</h1>
      <h2>Second Quarter Fiscal 2026 - Financial Results</h2>
      <p>Net sales of $3.7 billion were down 2% compared to last year.</p>
      <h2>Second Quarter Fiscal 2026 - Global Brand Results</h2>
      <p>Old Navy:</p>
      <p>Second quarter net sales of $2.1 billion were down 4% compared to last year.</p>
      <h2>CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS</h2>
      <p>($ and shares in millions except per share amounts)</p>
      <p>| 13 Weeks Ended | 26 Weeks Ended |</p>
      <p>| August 1, 2026 | August 2, 2025 | August 1, 2026 | August 2, 2025 |</p>
      <p>Net sales | $ | 3,651 | $ | 3,725 | $ | 7,148 | $ | 7,188 |</p>
    `);

    expect(parsedDocument.metrics).toEqual([
      expect.objectContaining({
        key: "revenue",
        numericValue: 3_651_000_000,
        value: "$3.65B",
      }),
    ]);
  });

  test("reads an aggregate net loss placed before its caption", () => {
    const parsedDocument = parseEarningsDocument(`
      <h1>Example reports second quarter 2026 results</h1>
      <h2>Second Quarter 2026 Financial Highlights</h2>
      <p>$25.8 million net loss, or $0.04 per basic and diluted share.</p>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "net_income", value: "-$25.8M"}),
    ]));
  });
});
