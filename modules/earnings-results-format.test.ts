import {describe, expect, test} from "vitest";
import {
  getMessageMetrics,
  normalizeCik,
  normalizeTickerSymbol,
  parseEarningsDocument,
} from "./earnings-results-format.ts";
import {getEarningsResultMessage} from "./earnings-results-message.ts";
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
      actualEps: 1.16,
      actualRevenue: 85_140_000_000,
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

  test("renders non-USD outlook guidance instead of current-period cash flow values", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h2>Outlook</h2>
          <p>Free cash flow was EUR 28 million in Q1 2026.</p>
          <p>Management reiterated full-year 2026 guidance for 3%-4.5% comparable sales growth, a 12.5%-13.0% adjusted EBITA margin, and €1.3B-€1.5B in free cash flow.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.outlook).toEqual([
      {
        key: "free_cash_flow",
        label: "Free cash flow",
        periodLabel: "FY2026",
        value: "€1.3B to €1.5B",
      },
    ]);
    expect(getEarningsResultMessage({
      companyName: "Koninklijke Philips N.V.",
      filing: {
        form: "6-K",
        items: [],
      },
      filingUrl: "https://www.sec.gov/example",
      metrics: [],
      parsedDocument,
      ticker: "PHG",
    })).toContain("- **FY2026 Free cash flow:** `€1.3B` to `€1.5B`");
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

  test("does not scan into a later sentence for a net earnings value", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>General Dynamics Reports Second-Quarter 2026 Financial Results</h1>
          <p>Revenue $14.1 billion, up 8.1% versus prior year</p>
          <p>Diluted EPS $4.24, up 13.4% versus prior year</p>
          <p>Net cash provided by operating activities in the quarter totaled $1.9 billion, or 162% of net earnings. During the quarter, the company paid $429 million in dividends, invested $234 million in capital expenditures, and reduced total debt by $498 million.</p>
          <div>CONSOLIDATED STATEMENT OF EARNINGS - (UNAUDITED)</div>
          <div>DOLLARS IN MILLIONS, EXCEPT PER SHARE AMOUNTS</div>
          <table>
            <tr><td>Three Months Ended</td></tr>
            <tr><td>Revenue</td><td>$</td><td>14,094</td><td>$</td><td>13,037</td></tr>
            <tr><td>Net earnings</td><td>$</td><td>1,160</td><td>$</td><td>1,014</td></tr>
            <tr><td>Earnings per share—diluted</td><td>$</td><td>4.24</td><td>$</td><td>3.74</td></tr>
          </table>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "gaap_eps",
        numericValue: 4.24,
        value: "$4.24",
      }),
      expect.objectContaining({
        key: "revenue",
        numericValue: 14_100_000_000,
        value: "$14.1B",
      }),
      expect.objectContaining({
        key: "net_income",
        numericValue: 1_160_000_000,
        value: "$1.16B",
      }),
    ]));
  });

  test("keeps Equinix second-quarter results separate from mixed-period guidance", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Equinix Reports Second-Quarter Results, Raises 2026 Guidance and Long-Term Outlook</h1>
          <h2>Second-Quarter 2026 Results Summary</h2>
          <p>• Revenues</p>
          <p>◦ $2.625 billion, a 4% increase over the previous quarter</p>
          <p>• Operating Income</p>
          <p>◦ $665 million, a 16% increase over the previous quarter</p>
          <p>• Net Income Attributable to Common Stockholders and Net Income per Share Attributable to Common Stockholders</p>
          <p>◦ $479 million, a 156% increase over the previous quarter</p>
          <p>◦ $4.83 per share, a 154% increase over the previous quarter</p>
          <p>• Adjusted EBITDA</p>
          <p>◦ $1.396 billion, a 4% increase over the previous quarter</p>
          <p>• AFFO and AFFO per Share</p>
          <p>◦ $1.168 billion, a 7% increase over the previous quarter</p>
          <p>◦ $11.78 per share, a 7% increase over the previous quarter</p>
          <h2>2026 Guidance Summary</h2>
          <p>For the third quarter of 2026, revenues are expected to range between $2.525 and $2.575 billion.</p>
          <p>For the third quarter of 2026, adjusted EBITDA is expected to range between $1.275 and $1.315 billion.</p>
          <p>For the full year of 2026, total capital expenditures are expected to range between $5.000 and $6.000 billion.</p>
        </body>
      </html>
    `);
    const event: EarningsEvent = {
      ticker: "EQIX",
      when: "after_close",
      date: "2026-07-29",
      importance: 1,
      epsConsensus: "$10.14",
    };
    const metrics = getMessageMetrics(parsedDocument.metrics, {
      actualEps: 11.78,
      actualRevenue: 2_625_000_000,
      consensusEps: 10.14,
      consensusRevenue: 2_580_000_000,
    }, event);

    expect(parsedDocument.quarterLabel).toBe("Q2 2026");
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "affo_per_share",
        estimate: "$10.14",
        numericValue: 11.78,
        outcome: "beat",
        value: "$11.78",
      }),
      expect.objectContaining({
        key: "gaap_eps",
        numericValue: 4.83,
        value: "$4.83",
      }),
      expect.objectContaining({
        key: "revenue",
        estimate: "$2.58B",
        numericValue: 2_625_000_000,
        outcome: "beat",
        value: "$2.625B",
      }),
      expect.objectContaining({
        key: "net_income",
        numericValue: 479_000_000,
        value: "$479M",
      }),
    ]));
    expect(metrics.find(metric => "gaap_eps" === metric.key)).not.toHaveProperty("estimate");
    expect(metrics.find(metric => "gaap_eps" === metric.key)).not.toHaveProperty("outcome");
    expect(parsedDocument.outlook).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        periodLabel: "Q3",
        value: "$2.525B to $2.575B",
      },
      {
        key: "adjusted_ebitda",
        label: "Adj EBITDA",
        periodLabel: "Q3",
        value: "$1.275B to $1.315B",
      },
      {
        key: "capex",
        label: "Capex",
        periodLabel: "FY2026",
        value: "$5B to $6B",
      },
    ]);

    expect(getEarningsResultMessage({
      companyName: "Equinix, Inc.",
      filing: {
        form: "8-K",
        items: ["2.02", "9.01"],
      },
      filingUrl: "https://www.sec.gov/Archives/edgar/data/1101239/000110123926000145/a991eqix-q226xpr.htm",
      metrics,
      parsedDocument,
      ticker: "EQIX",
    })).toContain([
      "**Equinix, Inc. (`EQIX`)** - Q2 2026 - [8-K](https://www.sec.gov/Archives/edgar/data/1101239/000110123926000145/a991eqix-q226xpr.htm)",
      "📊 **Results**",
      "- **AFFO/share:** `$11.78` vs est. `$10.14` (🟢 beat)",
      "- **EPS:** `$4.83`",
      "- **Revenue:** `$2.625B` vs est. `$2.58B` (🟢 beat)",
      "- **Net income:** `$479M`",
      "",
      "🔮 **Outlook**",
      "- **Q3 Revenue:** `$2.525B` to `$2.575B`",
      "- **Q3 Adj EBITDA:** `$1.275B` to `$1.315B`",
      "- **FY2026 Capex:** `$5B` to `$6B`",
    ].join("\n"));
  });

  test("parses Trane continuing EPS and comma-separated table scale without reading Q2 as EPS", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Trane Technologies Reports Strong Second Quarter Results; Raises Full-Year Revenue and EPS Guidance</h1>
          <h2>Second-Quarter 2026 Results</h2>
          <p>Financial Comparisons - Second-Quarter Continuing Operations</p>
          <table>
            <tr><td>$, millions except EPS</td><td>Q2 2026</td><td>Q2 2025</td><td>Y-O-Y Change</td><td>Organic Y-O-Y Change</td></tr>
            <tr><td>Bookings</td><td>$7,818</td><td>$5,626</td><td>39%</td><td>37%</td></tr>
            <tr><td>Net Revenues</td><td>$6,354</td><td>$5,746</td><td>11%</td><td>9%</td></tr>
            <tr><td>GAAP Operating Income</td><td>$1,224</td><td>$1,164</td><td>5%</td></tr>
            <tr><td>Adjusted Operating Income</td><td>$1,253</td><td>$1,166</td><td>7%</td></tr>
            <tr><td>GAAP Continuing EPS</td><td>$4.20</td><td>$3.87</td><td>9%</td></tr>
            <tr><td>Adjusted Continuing EPS</td><td>$4.31</td><td>$3.88</td><td>11%</td></tr>
          </table>
          <h2>Company Raises Full-Year 2026 Guidance</h2>
          <p>The Company expects full-year 2026 reported revenue growth of approximately 11.5 percent and organic revenue growth of approximately 9 percent versus full-year 2025.</p>
          <p>The Company expects GAAP continuing EPS for full-year 2026 of approximately $15.00 to $15.10, including $0.20 for non-GAAP adjustments. The Company expects adjusted continuing EPS for full-year 2026 of $15.20 to $15.30.</p>
          <p>($ in millions)</p>
          <table>
            <tr><td>Net earnings</td><td>935.3</td><td>878.9</td></tr>
          </table>
        </body>
      </html>
    `);
    const event: EarningsEvent = {
      ticker: "TT",
      when: "before_open",
      date: "2026-07-30",
      importance: 1,
      epsConsensus: "$4.27",
    };
    const metrics = getMessageMetrics(parsedDocument.metrics, {
      actualEps: 4.31,
      consensusEps: 4.27,
    }, event);

    expect(parsedDocument.quarterLabel).toBe("Q2 2026");
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "adjusted_eps",
        estimate: "$4.27",
        numericValue: 4.31,
        outcome: "beat",
        value: "$4.31",
      }),
      expect.objectContaining({
        key: "gaap_eps",
        numericValue: 4.2,
        value: "$4.20",
      }),
      expect.objectContaining({
        key: "revenue",
        numericValue: 6_354_000_000,
        value: "$6.35B",
      }),
      expect.objectContaining({
        key: "net_income",
        numericValue: 935_300_000,
        value: "$935.3M",
      }),
    ]));
    expect(metrics.find(metric => "gaap_eps" === metric.key)).not.toHaveProperty("estimate");
    expect(parsedDocument.outlook).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        value: "11.5% growth",
      },
      {
        key: "adjusted_eps",
        label: "Adj EPS",
        value: "$15.2 to $15.3",
      },
      {
        key: "eps",
        label: "EPS",
        value: "$15 to $15.1",
      },
    ]);
  });

  test("does not publish provider-only actuals or unmatched consensus comparisons", () => {
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
      actualRevenue: 100_500_000_000,
      consensusRevenue: 100_000_000_000,
    }, event);

    expect(metrics.some(metric => "nasdaq_eps" === metric.key)).toBe(false);
    expect(metrics.find(metric => "revenue" === metric.key)).not.toHaveProperty("estimate");
  });

  test("does not overwrite filing EPS with an unmatched provider actual", () => {
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
        value: "$13",
      }),
      expect.objectContaining({
        key: "gaap_eps",
        value: "$20",
      }),
      expect.objectContaining({
        key: "revenue",
        value: "$1.2B",
      }),
    ]));
    expect(metrics.find(metric => "adjusted_eps" === metric.key)).not.toHaveProperty("estimate");
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

  test("normalizes exported identifier helpers", () => {
    expect(normalizeTickerSymbol(" brk-b ")).toBe("BRK.B");
    expect(normalizeCik(123.9)).toBe("0000000123");
    expect(normalizeCik("0000012345")).toBe("0000012345");
    expect(normalizeCik("abc")).toBeNull();
    expect(normalizeCik(null)).toBeNull();
  });

  test("drops sub-million revenue/net income that lost their scale when a real EPS is present", () => {
    const event: EarningsEvent = {
      ticker: "KR",
      when: "before_open",
      date: "2026-06-18",
      importance: 1,
    };

    const guarded = getMessageMetrics([
      {key: "gaap_eps", label: "EPS", numericValue: 1.46, value: "$1.46"},
      {key: "net_income", label: "Net income", numericValue: 903, value: "$903"},
    ], {actualEps: 1.46}, event);
    expect(guarded.some(metric => "net_income" === metric.key)).toBe(false);
    expect(guarded.some(metric => "gaap_eps" === metric.key)).toBe(true);

    // The guard stays out of the way when there is no EPS signal to anchor scale.
    const unguarded = getMessageMetrics([
      {key: "net_income", label: "Net income", numericValue: 903, value: "$903"},
    ], null, event);
    expect(unguarded.some(metric => "net_income" === metric.key)).toBe(true);
  });
});
