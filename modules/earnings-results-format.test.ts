import {
  getEarningsResultMessage,
  getMessageMetrics,
  parseEarningsDocument,
} from "./earnings-results-format.js";
import {type EarningsEvent} from "./earnings.js";

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
    })).toContain("Adj EPS: `$1.16` vs est. `$0.96` - beat");
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
      "Outlook:",
      "Revenue: `$89B to $91B`",
      "EPS: `$1.42 to $1.48`",
      "Gross margin: `46.5% to 47.5%`",
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
});
