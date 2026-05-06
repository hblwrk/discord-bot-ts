import {describe, expect, test} from "vitest";
import {
  decodeHtmlEntities,
  formatEps,
  formatUsdCompact,
  getEarningsResultMessage,
  getMessageMetrics,
  htmlToText,
  normalizeCik,
  normalizeTickerSymbol,
  parseEarningsDocument,
  parseNumber,
} from "./earnings-results-format.ts";
import {type EarningsEvent} from "./earnings.ts";

describe("earnings result formatting", () => {
  test("parses high-confidence metrics and marks beats against analyst estimates", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Exxon Mobil reports first quarter 2026 results</h1>
          <p>Financial data in millions of dollars, except per share amounts.</p>
          <table>
            <tr><td>Adjusted EPS</td><td>$1.16</td></tr>
            <tr><td>Diluted earnings per share</td><td>$1.00</td></tr>
            <tr><td>Total revenues and other income</td><td>85,140</td></tr>
            <tr><td>Refinery throughput</td><td>3,494 kbd</td></tr>
          </table>
        </body>
      </html>
    `);
    const event: EarningsEvent = {
      ticker: "XOM",
      when: "before_open",
      date: "2026-05-01",
      importance: 1,
      epsConsensus: "$0.96",
    };
    const metrics = getMessageMetrics(parsedDocument.metrics, {
      consensusEps: 0.96,
      consensusRevenue: 80_740_000_000,
    }, event);

    expect(parsedDocument.quarterLabel).toBe("Q1 2026");
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "adjusted_eps",
        value: "$1.16",
        estimate: "$0.96",
        outcome: "beat",
      }),
      expect.objectContaining({
        key: "revenue",
        value: "$85.14B",
        estimate: "$80.74B",
        outcome: "beat",
      }),
      expect.objectContaining({
        key: "refinery_throughput",
        value: "3,494 kbd",
      }),
    ]));

    expect(getEarningsResultMessage({
      companyName: "Exxon Mobil",
      filing: {
        form: "8-K",
        items: ["2.02", "9.01"],
      },
      filingUrl: "https://www.sec.gov/Archives/edgar/data/34088/example/ex-991.htm",
      metrics,
      parsedDocument,
      ticker: "XOM",
    })).toContain("- **Adj EPS:** `$1.16` vs est. `$0.96` (🟢 beat)");
    expect(getEarningsResultMessage({
      companyName: "Exxon Mobil",
      filing: {
        form: "8-K",
        items: ["2.02", "9.01"],
      },
      filingUrl: "https://www.sec.gov/Archives/edgar/data/34088/example/ex-991.htm",
      metrics,
      parsedDocument,
      ticker: "XOM",
    })).toContain("**Exxon Mobil (`XOM`)** - Q1 2026 - [8-K](https://www.sec.gov/Archives/edgar/data/34088/example/ex-991.htm)");
  });

  test("renders result and outlook metrics before optional earnings summaries", () => {
    const parsedDocument = {
      metrics: [],
      outlook: [{
        key: "revenue",
        label: "Revenue",
        value: "$89B to $91B",
      }, {
        key: "capex",
        label: "Capex",
        value: "$190M-$210M",
      }],
      quarterLabel: "Q1 2026",
    } satisfies ReturnType<typeof parseEarningsDocument>;
    const metrics = [{
      key: "adjusted_eps",
      label: "Adj EPS",
      numericValue: 1.16,
      value: "$1.16",
    }, {
      key: "revenue",
      label: "Revenue",
      numericValue: 10_500_000_000,
      value: "$10.5B",
    }] satisfies ReturnType<typeof getMessageMetrics>;

    expect(getEarningsResultMessage({
      companyName: "ExampleCo",
      filing: {
        form: "8-K",
        items: ["2.02", "9.01"],
      },
      filingUrl: "https://www.sec.gov/example",
      metrics,
      parsedDocument,
      summary: "ExampleCo beat expectations. Revenue improved. Management raised guidance.",
      ticker: "EXM",
    })).toBe([
      "**ExampleCo (`EXM`)** - Q1 2026 - [8-K](https://www.sec.gov/example)",
      "📊 **Results**",
      "- **Adj EPS:** `$1.16`",
      "- **Revenue:** `$10.5B`",
      "",
      "🔮 **Outlook**",
      "- **Revenue:** `$89B` to `$91B`",
      "- **Capex:** `$190M-$210M`",
      "",
      "📝 ExampleCo beat expectations. Revenue improved. Management raised guidance.",
      "",
      "\u200B",
    ].join("\n"));
  });

  test("parses and renders table-based outlook metrics", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo reports second quarter 2026 results</h1>
          <h2>Business Outlook</h2>
          <table>
            <tr><td>Revenue</td><td>$89 billion to $91 billion</td></tr>
            <tr><td>EPS</td><td>$1.42 to $1.48</td></tr>
            <tr><td>Gross margin</td><td>46.5% to 47.5%</td></tr>
            <tr><td>Operating expenses</td><td>$18.5 billion to $18.7 billion</td></tr>
            <tr><td>Tax rate</td><td>16%</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(parsedDocument.outlook).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        value: "$89B to $91B",
      },
      {
        key: "eps",
        label: "EPS",
        value: "$1.42 to $1.48",
      },
      {
        key: "gross_margin",
        label: "Gross margin",
        value: "46.5% to 47.5%",
      },
      {
        key: "operating_expenses",
        label: "Operating expenses",
        value: "$18.5B to $18.7B",
      },
      {
        key: "tax_rate",
        label: "Tax rate",
        value: "16%",
      },
    ]);

    expect(getEarningsResultMessage({
      companyName: "ExampleCo",
      filing: {
        form: "8-K",
        items: ["2.02", "9.01"],
      },
      filingUrl: "https://www.sec.gov/example",
      metrics: [],
      parsedDocument,
      ticker: "EXCO",
    })).toContain([
      "🔮 **Outlook**",
      "- **Revenue:** `$89B` to `$91B`",
      "- **EPS:** `$1.42` to `$1.48`",
      "- **Gross margin:** `46.5%` to `47.5%`",
    ].join("\n"));
  });

  test("parses paragraph-based outlook and ignores non-outlook boilerplate", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h2>Financial Outlook</h2>
          <p>For the next quarter, we expect revenue to grow low double digits year over year. We expect gross margin to be between 46.5% and 47.5%. Operating expenses are expected to be approximately $18.5 billion to $18.7 billion. The tax rate is expected to be around 16%.</p>
          <h2>Forward-Looking Statements</h2>
          <p>This press release contains forward-looking statements about future business plans.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.outlook).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        value: "low double-digit growth",
      },
      {
        key: "gross_margin",
        label: "Gross margin",
        value: "46.5% to 47.5%",
      },
      {
        key: "operating_expenses",
        label: "Operating expenses",
        value: "$18.5B to $18.7B",
      },
      {
        key: "tax_rate",
        label: "Tax rate",
        value: "16%",
      },
    ]);
  });

  test("drops noisy non-text outlook values", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h2>Financial Outlook</h2>
          <p>Operating income and net income in each quarter this year are expected to improve.</p>
          <p>Tax rate (% Pre-Tax Income Attributable to the Company) (1)</p>
          <p>Free cash flow is expected to be between $4.2 billion and $4.4 billion.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.outlook).toEqual([
      {
        key: "free_cash_flow",
        label: "Free cash flow",
        value: "$4.2B to $4.4B",
      },
    ]);
  });

  test("does not emit outlook metrics without an outlook section", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo reports results</h1>
          <p>Revenue increased 10% year over year.</p>
          <p>This press release contains forward-looking statements.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.outlook).toEqual([]);
  });

  test("ignores release-title guidance and raw comparison rows in outlook output", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>L.B. Foster Company Announces Strong Sales Growth and Profitability Expansion in 2026 First Quarter; Reaffirms Full Year 2026 Financial Guidance</h1>
          <p>First quarter net sales totaled $121.1 million, up 23.9% over last year.</p>
          <p>First quarter net income of $1.5 million was up $3.6 million over last year.</p>
          <table>
            <tr><td>$ in thousands, unless otherwise noted:</td></tr>
            <tr><td>Net sales</td><td>$</td><td>121,144</td><td>$</td><td>97,792</td><td>23.9%</td></tr>
            <tr><td>Operating income (loss)</td><td>2,045</td><td>(1,923)</td><td>206.3%</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "revenue",
        numericValue: 121_100_000,
        value: "$121.1M",
      }),
      expect.objectContaining({
        key: "net_income",
        numericValue: 1_500_000,
        value: "$1.5M",
      }),
    ]));
    expect(parsedDocument.outlook).toEqual([]);
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
        estimate: "$0.85",
        numericValue: 0.77,
        outcome: "miss",
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

  test("removes script/style blocks with spaced closing tags", () => {
    const text = htmlToText(`
      <p>Revenue $10 billion</p>
      <script>malicious()</script
        data-ignored>
      <style>body { color: red; }</style
        data-ignored>
      <p>EPS $1.00</p>
    `);

    expect(text).toContain("Revenue $10 billion");
    expect(text).toContain("EPS $1.00");
    expect(text).not.toContain("malicious");
    expect(text).not.toContain("color: red");
  });

  test("decodes html entities without double-unescaping ampersands", () => {
    expect(decodeHtmlEntities("A&amp;B &lt;tag&gt; &amp;lt;safe&amp;gt; &#36;1")).toBe(
      "A&B <tag> &lt;safe&gt; $1",
    );
  });

  test("uses Nasdaq actual EPS when SEC metrics do not contain EPS", () => {
    const event: EarningsEvent = {
      ticker: "ABC",
      when: "after_close",
      date: "2026-05-01",
      importance: 1,
      epsConsensus: "$1.00",
    };

    const metrics = getMessageMetrics([
      {
        key: "revenue",
        label: "Revenue",
        numericValue: 99_500_000_000,
        value: "$99.5B",
      },
    ], {
      actualEps: 1,
      consensusEps: 1,
      consensusRevenue: 100_000_000_000,
    }, event);

    expect(metrics[0]).toMatchObject({
      key: "nasdaq_eps",
      estimate: "$1.00",
      outcome: "inline",
      value: "$1.00",
    });
    expect(metrics.find(metric => "revenue" === metric.key)).toMatchObject({
      estimate: "$100B",
      outcome: "miss",
    });
  });

  test("uses Nasdaq EPS when parsed SEC EPS is implausible and drops bogus secondary GAAP EPS", () => {
    const event: EarningsEvent = {
      ticker: "RBA",
      when: "after_close",
      date: "2026-05-04",
      importance: 1,
      epsConsensus: "$0.89",
    };

    const metrics = getMessageMetrics([
      {
        key: "adjusted_eps",
        label: "Adj EPS",
        numericValue: 13,
        value: "$13",
      },
      {
        key: "gaap_eps",
        label: "EPS",
        numericValue: 20,
        value: "$20",
      },
      {
        key: "revenue",
        label: "Revenue",
        numericValue: 1_200_000_000,
        value: "$1.2B",
      },
    ], {
      actualEps: 1.13,
      consensusEps: 0.89,
    }, event);

    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "adjusted_eps",
        estimate: "$0.89",
        outcome: "beat",
        value: "$1.13",
      }),
      expect.objectContaining({
        key: "revenue",
        value: "$1.2B",
      }),
    ]));
    expect(metrics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "gaap_eps",
      }),
    ]));
  });

  test("formats message without quarter, filing items, estimate or outlook", () => {
    const message = getEarningsResultMessage({
      companyName: "Example",
      filing: {
        form: "10-Q",
        items: [],
      },
      filingUrl: "https://www.sec.gov/example",
      metrics: [{
        key: "production",
        label: "Production",
        value: "1,200 boepd",
      }],
      parsedDocument: {
        metrics: [],
        outlook: [],
      },
      ticker: " ex ",
    });

    expect(message).toBe([
      "**Example (`EX`)** - [10-Q](https://www.sec.gov/example)",
      "📊 **Results**",
      "- **Production:** `1,200 boepd`",
      "",
      "\u200B",
    ].join("\n"));
  });

  test("parses alternate metric shapes and numeric edge cases", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Example reports Q3 2026 results</h1>
          <p>$ in billions</p>
          <p>Guidance EPS $9.99</p>
          <p>GAAP diluted EPS $0.24</p>
          <p>Net sales were $2.5 billion, up from 2025.</p>
          <p>Net income was $300 million.</p>
          <p>Production was 1,234 boepd.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q3 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "gaap_eps",
        value: "$0.24",
      }),
      expect.objectContaining({
        key: "revenue",
        numericValue: 2_500_000_000,
        value: "$2.5B",
      }),
      expect.objectContaining({
        key: "net_income",
        numericValue: 300_000_000,
        value: "$300M",
      }),
      expect.objectContaining({
        key: "production",
        value: "1,234 boepd",
      }),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$9.99");
  });

  test("formats and normalizes exported result helpers", () => {
    expect(parseNumber(1.5)).toBe(1.5);
    expect(parseNumber(Number.NaN)).toBeNull();
    expect(parseNumber("(1,234.5)")).toBe(-1234.5);
    expect(parseNumber("24c")).toBe(0.24);
    expect(parseNumber("--")).toBeNull();
    expect(parseNumber({})).toBeNull();

    expect(formatEps(5.6)).toBe("$5.60");
    expect(formatEps(-1.2)).toBe("-$1.20");
    expect(formatUsdCompact(-1_250_000_000_000)).toBe("-$1.25T");
    expect(formatUsdCompact(12_300_000)).toBe("$12.3M");
    expect(formatUsdCompact(750_000)).toBe("$750K");
    expect(formatUsdCompact(123)).toBe("$123");

    expect(normalizeTickerSymbol(" brk-b ")).toBe("BRK.B");
    expect(normalizeCik(123.9)).toBe("0000000123");
    expect(normalizeCik("0000012345")).toBe("0000012345");
    expect(normalizeCik("abc")).toBeNull();
    expect(normalizeCik(null)).toBeNull();
  });
});
