import {describe, expect, test} from "vitest";
import {parseEarningsDocument} from "./earnings-results-format.ts";

describe("earnings result metric selection", () => {
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
});
