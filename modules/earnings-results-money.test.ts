import {describe, expect, test} from "vitest";
import {getMessageMetrics, parseEarningsDocument} from "./earnings-results-format.ts";
import {
  findEpsValue,
  findNumericValue,
  findPerShareTableValue,
  formatEps,
  formatUsdCompact,
  getExplicitMoneyScale,
  getMoneyScaleFromContextText,
  parseNumber,
} from "./earnings-results-money.ts";
import {type EarningsEvent} from "./earnings.ts";

describe("earnings result money parsing", () => {
  test("skips a collapsed per-share note column and recognizes ISO-code table units", () => {
    const perShareRows =
      "Basic | 17 $ 0.01 $ (0.14) $ 0.00 $ (0.42) " +
      "Diluted | 17 $ 0.01 $ (0.14) $ 0.00 $ (0.42)";

    expect(findPerShareTableValue(perShareRows, 0)).toBe(0.01);
    expect(getMoneyScaleFromContextText("USD millions, except per share amounts"))
      .toBe(1_000_000);
  });

  test("ignores an EPS footnote marker and prefers the reported currency value", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Goldman Sachs Reports Second Quarter 2026 Earnings Results</h1>
          <p>EPS 1</p>
          <p>2Q26</p>
          <p>$20.98</p>
          <p>Diluted earnings per common share (EPS) 1 was $20.98 for the second quarter of 2026.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "gaap_eps",
        numericValue: 20.98,
        value: "$20.98",
      }),
    ]));
  });

  test("uses table scale instead of an unrelated later unit on a flattened filing page", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <p>
            Bank of America Financial Highlights ($ in billions, except per share data)
            2Q26 1Q26 2Q25
            Total revenue, net of interest expense $31.6 $30.3 $27.4
            Net income 9.1 8.6 7.2
            Our $3.5 trillion balance sheet remained a source of strength.
          </p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "revenue",
        numericValue: 31_600_000_000,
        value: "$31.6B",
      }),
    ]));
  });

  test("skips EPS percentages and period-ending dates in GE-style result tables", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>GE Aerospace announces second quarter 2026 results</h1>
          <p>Total revenue (GAAP) of $13.3B, +21%; adjusted revenue of $12.6B, +24%.</p>
          <p>Continuing EPS (GAAP) of $2.30, +23%; adjusted EPS of $2.02, +22%.</p>
          <p>Revenue and EPS were both up more than 20% with engine deliveries up 31%.</p>
          <table>
            <tr><th>Three months ended June 30</th><th>2026</th><th>2025</th></tr>
            <tr><td>Continuing EPS</td><td>2.30</td><td>1.87</td></tr>
            <tr><td>Adjusted EPS</td><td>2.02</td><td>1.66</td></tr>
          </table>
          <table>
            <tr><td>(In millions)</td></tr>
            <tr><th>ADJUSTED NET INCOME (LOSS) (NON-GAAP)</th><th>Three months ended June 30</th><th>Six months ended June 30</th></tr>
            <tr><td>(In millions, diluted, per-share amounts in dollars)</td><td>2026</td><td>2025</td><td>2026</td><td>2025</td></tr>
            <tr><td>Income</td><td>EPS</td><td>Income</td><td>EPS</td><td>Income</td><td>EPS</td><td>Income</td><td>EPS</td></tr>
            <tr><td>Net income (loss) from continuing operations (GAAP)</td><td>$</td><td>2,405</td><td>$</td><td>2.30</td><td>$</td><td>2,007</td><td>$</td><td>1.87</td><td>$</td><td>4,335</td><td>$</td><td>4.13</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q2 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "adjusted_eps",
        numericValue: 2.02,
        value: "$2.02",
      }),
      expect.objectContaining({
        key: "gaap_eps",
        numericValue: 2.3,
        value: "$2.30",
      }),
      expect.objectContaining({
        key: "net_income",
        numericValue: 2_405_000_000,
        value: "$2.4B",
      }),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$20.00");
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$30M");
  });

  test("does not treat Enbridge table-note markers as revenue", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Enbridge Reports Strong First Quarter Results, Reaffirms 2026 Financial Guidance, and Grows Secured Backlog to $40 Billion</h1>
          <p>(All financial figures are unaudited and in Canadian dollars unless otherwise noted.)</p>
          <p>First quarter 2026 GAAP earnings attributable to common shareholders of $1.7 billion or $0.77 per common share.</p>
          <p>Adjusted earnings* of $2.1 billion or $0.98 per common share*.</p>
          <p>Basic earnings per share ($)</p>
          <p>0.77</p>
          <p>FINANCIAL OUTLOOK</p>
          <p>The Company reaffirms its 2026 financial guidance for adjusted EBITDA between $20.2 billion and $20.8 billion and DCF per share between $5.70 and $6.10.</p>
          <p>FINANCING UPDATE</p>
          <p>Proceeds from these offerings were used to pay down existing indebtedness, finance capital expenditures, and for general corporate purposes.</p>
          <p>($ millions, except per share amounts)</p>
          <p>Other receipts of cash not recognized in revenue 2</p>
          <p>2 Consists of cash received, net of revenue recognized, for contracts under make-up rights and similar deferred revenue arrangements.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q1 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        currencyCode: "CAD",
        key: "gaap_eps",
        value: "C$0.77",
      }),
    ]));
    expect(parsedDocument.metrics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "revenue",
      }),
    ]));
    expect(parsedDocument.outlook).toEqual([
      {
        key: "adjusted_ebitda",
        label: "Adj EBITDA",
        value: "C$20.2B to C$20.8B",
      },
      {
        key: "dcf_per_share",
        label: "DCF/share",
        value: "C$5.7 to C$6.1",
      },
    ]);
  });

  test("parses compact Airbnb money suffixes and diluted EPS table rows", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Q1 2026 Shareholder Letter</h1>
          <p>Q1 2026 Key Financial Measures Revenue $2.7B 18% Y/Y Net Income $160M 6% Net income margin</p>
          <p>Condensed Consolidated Statements of Operations Unaudited (in millions, except per share amounts) Three Months Ended March 31 2025 2026</p>
          <p>from operations 38 86 Interest income 173 155 Other income (expense), net (38) 40 Income before income taxes 173 281 Provision for income taxes 19 121 Net income $154 $160 Net income per share attributable to Class A and Class B common stockholders:</p>
          <p>Basic $0.25 $0.27 Diluted $0.24 $0.26 Weighted-average shares used in computing net income per share attributable to Class A and Class B common stockholders: Basic 621 598 Diluted 632 608</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "revenue",
        value: "$2.7B",
      }),
      expect.objectContaining({
        key: "net_income",
        value: "$160M",
      }),
      expect.objectContaining({
        key: "gaap_eps",
        value: "$0.26",
      }),
    ]));
    expect(parsedDocument.metrics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "gaap_eps",
        value: "$38.00",
      }),
      expect.objectContaining({
        key: "net_income",
        value: "$160",
      }),
    ]));
  });

  test("applies local table money units for main metrics", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Example reports Q1 2026 results</h1>
          <table>
            <tr><td>$ in thousands, except per share amounts</td></tr>
            <tr><td>Product revenue, net</td></tr>
            <tr><td>$</td><td>116,357</td><td>$</td><td>88,158</td></tr>
            <tr><td>Net income</td><td>$</td><td>55,932</td><td>$</td><td>35,733</td></tr>
          </table>
          <table>
            <tr><td>(in millions, except per share data)</td></tr>
            <tr><td>Sales</td><td>$</td><td>13,653</td><td>$</td><td>13,074</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "revenue",
        numericValue: 116_357_000,
        value: "$116.36M",
      }),
      expect.objectContaining({
        key: "net_income",
        numericValue: 55_932_000,
        value: "$55.93M",
      }),
    ]));

    const salesOnlyDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>SalesCo reports Q2 2026 results</h1>
          <table>
            <tr><td>(in millions, except per share data)</td></tr>
            <tr><td>Sales</td><td>$</td><td>13,653</td><td>$</td><td>13,074</td></tr>
            <tr><td>Net Income Per Share</td><td>$</td><td>0.73</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(salesOnlyDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "revenue",
        numericValue: 13_653_000_000,
        value: "$13.65B",
      }),
    ]));

    const perShareDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>IncomeCo reports Q1 2026 results</h1>
          <p>Net income for the three months ended March 31, 2026 was $55.9 million, or $1.91 per common share.</p>
        </body>
      </html>
    `);

    expect(perShareDocument.metrics).toEqual([
      expect.objectContaining({
        key: "net_income",
        numericValue: 55_900_000,
        value: "$55.9M",
      }),
    ]);
  });

  test("uses split table values instead of date headers or note columns", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>GlobalFoundries reports first quarter 2026 results</h1>
          <p>(Unaudited, in millions, except per share amounts)</p>
          <p>Three Months Ended March 31</p>
          <p>| 2026</p>
          <p>| 2025</p>
          <p>Net revenue</p>
          <p>| $</p>
          <p>| 1,634</p>
          <p>| $</p>
          <p>| 1,585</p>
          <p>Cost of revenue</p>
          <p>| 1,183</p>
          <p>| 1,230</p>
          <p>Net income</p>
          <p>| $</p>
          <p>| 104</p>
          <p>| $</p>
          <p>| 211</p>
          <h2>Note 3. Net Revenue</h2>
          <p>The following table presents the Company's revenue for the three month periods ended March 31, 2026 and 2025.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "revenue",
        numericValue: 1_634_000_000,
        value: "$1.63B",
      }),
      expect.objectContaining({
        key: "net_income",
        numericValue: 104_000_000,
        value: "$104M",
      }),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$31M");
  });

  test("skips table note references and prefers the period-ended quarter", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <p>BioNTech | Quarterly Report for the three months ended March 31, 2026</p>
          <p>Q1 2027 program timing remains subject to risks.</p>
          <table>
            <tr><td>(in millions €, except per share data)</td><td>Note</td><td>2026</td><td>2025</td></tr>
            <tr><td>Revenues</td><td>3</td></tr>
            <tr><td>118.1</td><td>182.8</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q1 2026");
    expect(parsedDocument.metrics).toEqual([
      expect.objectContaining({
        currencyCode: "EUR",
        key: "revenue",
        numericValue: 118_100_000,
        value: "€118.1M",
      }),
    ]);
  });

  test("preserves Taiwan dollars and the named current quarter", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>TSMC Reports Second Quarter EPS of NT$27.25</h1>
          <p>TSMC announced consolidated revenue of NT$1,270.38 billion, net income of NT$706.56 billion, and diluted earnings per share of NT$27.25 (US$4.31 per ADR unit) for the second quarter ended June 30, 2026.</p>
          <p>Compared to first quarter 2026, second quarter results represented an increase in revenue and net income.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q2 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        currencyCode: "TWD",
        key: "gaap_eps",
        numericValue: 27.25,
        value: "NT$27.25",
      }),
      expect.objectContaining({
        currencyCode: "TWD",
        key: "revenue",
        numericValue: 1_270_380_000_000,
        value: "NT$1.27T",
      }),
      expect.objectContaining({
        currencyCode: "TWD",
        key: "net_income",
        numericValue: 706_560_000_000,
        value: "NT$706.56B",
      }),
    ]));

    const messageMetrics = getMessageMetrics(parsedDocument.metrics, {
      actualEps: 4.31,
      consensusEps: 4.10,
      consensusRevenue: 40_000_000_000,
    }, {
      ticker: "TSM",
      when: "before_open",
      date: "2026-07-16",
      importance: 1,
      epsConsensus: "$4.10",
    });
    expect(messageMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        currencyCode: "TWD",
        key: "gaap_eps",
        numericValue: 27.25,
        value: "NT$27.25",
      }),
      expect.objectContaining({
        currencyCode: "TWD",
        key: "revenue",
        value: "NT$1.27T",
      }),
    ]));
    expect(messageMetrics.find(metric => "gaap_eps" === metric.key)?.estimate).toBeUndefined();
    expect(messageMetrics.find(metric => "revenue" === metric.key)?.estimate).toBeUndefined();
  });

  test("parses cents-denominated EPS as dollars per share", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Ball Reports Strong First Quarter 2026 Results</h1>
          <p>First quarter U.S. GAAP total diluted earnings per share of 77 cents vs. 63 cents in 2025.</p>
          <p>On a U.S. GAAP basis, net earnings were $205 million or total diluted earnings per share of 77 cents, on sales of $3.60 billion.</p>
        </body>
      </html>
    `);
    const event: EarningsEvent = {
      ticker: "BALL",
      when: "before_open",
      date: "2026-05-05",
      importance: 1,
      epsConsensus: "$0.85",
    };
    const metrics = getMessageMetrics(parsedDocument.metrics, null, event);

    expect(parsedDocument.quarterLabel).toBe("Q1 2026");
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "gaap_eps",
        numericValue: 0.77,
        value: "$0.77",
      }),
      expect.objectContaining({
        key: "revenue",
        numericValue: 3_600_000_000,
        value: "$3.6B",
      }),
      expect.objectContaining({
        key: "net_income",
        numericValue: 205_000_000,
        value: "$205M",
      }),
    ]));
  });

  test("formats exported money helpers", () => {
    expect(parseNumber(1.5)).toBe(1.5);
    expect(parseNumber(Number.NaN)).toBeNull();
    expect(parseNumber("(1,234.5)")).toBe(-1234.5);
    expect(parseNumber("24c")).toBe(0.24);
    expect(parseNumber("NT$27.25")).toBe(27.25);
    expect(parseNumber("--")).toBeNull();
    expect(parseNumber({})).toBeNull();

    expect(formatEps(5.6)).toBe("$5.60");
    expect(formatEps(-1.2)).toBe("-$1.20");
    expect(formatEps(27.25, "TWD")).toBe("NT$27.25");
    expect(formatUsdCompact(-1_250_000_000_000)).toBe("-$1.25T");
    expect(formatUsdCompact(12_300_000)).toBe("$12.3M");
    expect(formatUsdCompact(750_000)).toBe("$750K");
    expect(formatUsdCompact(123)).toBe("$123");
  });

  test("parses Kroger-style highlight bullets and a distant income-statement scale header", () => {
    // Reproduces a real Kroger 8-K mis-parse: the revenue extractor latched onto a
    // marketing bullet ("eCommerce sales grew +19% 2", footnote "2" x a stray scale)
    // rendering "$2M", and net income kept the figure but lost its "(in millions)"
    // scale (130 separator rows below the header) rendering "$903" instead of "$903M".
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>The Kroger Co. Reports First Quarter 2026 Results</h1>
          <p>First Quarter</p>
          <p>Highlights</p>
          <p>Identical Sales without fuel increased 1.0% 1</p>
          <p>Operating Profit of $1,407 million; EPS of $1.46</p>
          <p>Adjusted FIFO Operating Profit of $1,544 million and Adjusted EPS of $1.58</p>
          <p>Adjusted eCommerce sales grew +19% 2 ; Kroger Precision Marketing profit grew over 20%</p>
          <p>ID Sales (1) (Table 4) | 1.0% | 3.2%</p>
          <p>THE KROGER CO.</p>
          <p>CONSOLIDATED STATEMENTS OF OPERATIONS</p>
          <p>(in millions, except per share amounts)</p>
          <table>
            <tr><td>SALES</td><td>$</td><td>46,121</td><td>$</td><td>45,118</td></tr>
            <tr><td>MERCHANDISE COSTS</td><td>36,058</td><td>35,200</td></tr>
            <tr><td>OPERATING PROFIT</td><td>1,407</td><td>1,322</td></tr>
            <tr><td>NET EARNINGS BEFORE INCOME TAX EXPENSE</td><td>1,177</td><td>1,090</td></tr>
            ${"<tr><td></td><td></td></tr>".repeat(90)}
            <tr><td>NET EARNINGS INCLUDING NONCONTROLLING INTERESTS</td><td>904</td><td>868</td></tr>
            <tr><td>NET INCOME ATTRIBUTABLE TO NONCONTROLLING INTERESTS</td><td>1</td><td>2</td></tr>
            <tr><td>NET EARNINGS ATTRIBUTABLE TO THE KROGER CO.</td><td>$</td><td>903</td><td>$</td><td>866</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q1 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "adjusted_eps", value: "$1.58"}),
      expect.objectContaining({key: "gaap_eps", value: "$1.46"}),
      expect.objectContaining({key: "revenue", numericValue: 46_121_000_000, value: "$46.12B"}),
      expect.objectContaining({key: "net_income", numericValue: 903_000_000, value: "$903M"}),
    ]));
    // None of the mis-parses: marketing-bullet revenue, pre-tax/NCI net income, or
    // the unscaled bare-dollar net income.
    const valuesByKey = new Map(parsedDocument.metrics.map(metric => [metric.key, metric.value]));
    expect(valuesByKey.get("revenue")).not.toBe("$2M");
    expect(valuesByKey.get("revenue")).not.toBe("-$1M");
    expect(valuesByKey.get("net_income")).not.toBe("$903");
    expect(valuesByKey.get("net_income")).not.toBe("$1.18B");
  });

  // These guards are load-bearing but easy to lose, because a realistic filing usually
  // offers a second candidate that happens to be right. Pinned directly so a regression
  // fails here rather than surfacing as a wrong posted figure.
  describe("per-share value plausibility", () => {

    test("rejects a value denominated in a money scale", () => {
      // A revenue milestone sharing a line with a non-GAAP EPS label is not $3.00 of EPS.
      expect(findEpsValue(" as the company achieved its first $3+ billion revenue quarter.", 0))
        .toBeNull();
      expect(findEpsValue(" of $1.6 billion", 0)).toBeNull();
    });

    test("rejects a large whole number in a per-share position", () => {
      // Without this an aggregate on the line is published as EPS: AMD reported -$30.00.
      expect(findEpsValue(" of 30 and 2,760", 0)).toBeNull();
      expect(findEpsValue(" | Net income | 545 | 721 | (86)", 0)).toBeNull();
    });

    test("keeps a fractional or small per-share value", () => {
      expect(findEpsValue(" was $1.66.", 0)).toBe(1.66);
      expect(findEpsValue(" $ | (0.04) | 0.51", 0)).toBe(-0.04);
      expect(findEpsValue(" of 5", 0)).toBe(5);
    });
  });

  describe("calendar-year exclusion", () => {
    const scanOptions = {minUncuedAbsValue: 10, skipPercentages: true};

    test("keeps a figure that merely falls in the calendar-year range", () => {
      // "$ | 1,948" is a $1.95B quarter. Discarding it as a year shifts the row to a
      // later column and reports the full year instead.
      expect(findNumericValue(" | $ | 1,948 | $ | 1,988", scanOptions)).toBe(1948);
      expect(findNumericValue(" | $ | 2,026", scanOptions)).toBe(2026);
      expect(findNumericValue(" | 1,950.5", scanOptions)).toBe(1950.5);
    });

    test("still skips a bare year in a column header", () => {
      expect(findNumericValue(" 2026 | 2025", scanOptions)).toBeNull();
    });
  });

  test("keeps an explicit money scale across SEC table separators", () => {
    const row = "Revenue | | $ | 17.3 | billion |";
    const valueEndIndex = row.indexOf("17.3") + "17.3".length;

    expect(getExplicitMoneyScale(row, valueEndIndex)).toBe(1_000_000_000);
  });
});
