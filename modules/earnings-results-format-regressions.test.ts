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

  test("uses Enbridge reported Canadian-dollar EPS levels instead of prior-year values or changes", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Enbridge Reports Strong Second Quarter Results and Reaffirms 2026 Guidance</h1>
          <p>All financial figures are unaudited and in Canadian dollars unless otherwise noted.</p>
          <p>Second quarter GAAP earnings attributable to common shareholders of $1.4 billion or $0.64 per common share, compared with GAAP earnings attributable to common shareholders of $2.2 billion or $1.00 per common share in 2025.</p>
          <p>Adjusted earnings of $1.4 billion or $0.63 per common share, compared with $1.4 billion or $0.65 per common share in 2025.</p>
          <p>GAAP earnings attributable to common shareholders for the second quarter of 2026 decreased by $0.8 billion, or $0.36 per share, compared with the same period in 2025.</p>
          <p>Adjusted earnings in the second quarter of 2026 decreased by $36 million, or $0.02 per share, compared with the same period in 2025.</p>
          <h2>Financial Outlook</h2>
          <p>The Company reaffirms its 2026 financial guidance for adjusted EBITDA between $20.2 billion and $20.8 billion and DCF per share between $5.70 and $6.10.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q2 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        currencyCode: "CAD",
        key: "adjusted_eps",
        numericValue: 0.63,
        value: "C$0.63",
      }),
      expect.objectContaining({
        currencyCode: "CAD",
        key: "gaap_eps",
        numericValue: 0.64,
        value: "C$0.64",
      }),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toEqual(expect.arrayContaining([
      "C$0.02",
      "C$0.36",
      "C$1.00",
    ]));
    expect(parsedDocument.outlook).toEqual([
      {key: "adjusted_ebitda", label: "Adj EBITDA", value: "C$20.2B to C$20.8B"},
      {key: "dcf_per_share", label: "DCF/share", value: "C$5.7 to C$6.1"},
    ]);
  });

  test("reads Vertex-style per-share rows from the quarter column, not the trailing prior-year YTD one", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Vertex Reports Second Quarter 2026 Financial Results</h1>
          <p>Consolidated Statements of Income</p>
          <p>(unaudited, in millions, except per share amounts)</p>
          <p>Three Months Ended June 30, | Six Months Ended June 30,</p>
          <p>2026 | 2025 | 2026 | 2025</p>
          <p>Total revenues | 3,333.9 | 2,964.7 | 6,320.8 | 5,734.9</p>
          <p>Net income | $ | 1,099.8 | $ | 1,032.9 | $ | 2,131.2 | $ | 1,679.2</p>
          <p>Net income per common share:</p>
          <p>Basic | $ | 4.34 | $ | 4.02 | $ | 8.39 | $ | 6.54</p>
          <p>Diluted | $ | 4.31 | $ | 3.99 | $ | 8.33 | $ | 6.48</p>
        </body>
      </html>
    `);

    expect(parsedDocument.quarterLabel).toBe("Q2 2026");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", numericValue: 4.31, value: "$4.31"}),
      expect.objectContaining({key: "revenue", numericValue: 3_333_900_000}),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$6.48");
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$4.34");
  });

  test("keeps Clorox fourth-quarter figures separate from the full-year summary", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Clorox Reports Q4 and Fiscal Year 2026 Results</h1>
          <h2>Fourth-Quarter Fiscal Year 2026 Summary</h2>
          <p>Net sales decreased 2% to $1.95 billion. The GOJO acquisition added about 10 points.</p>
          <p>Diluted net earnings per share (diluted EPS) decreased 50% to $1.34 from $2.68 in the year-ago quarter.</p>
          <h2>Fiscal Year 2026 Summary</h2>
          <p>Net sales decreased 5% to $6.72 billion, reflecting lapping of shipments in the fourth quarter.</p>
          <p>Diluted EPS decreased 26% to $4.81 from $6.52 in the year-ago period.</p>
          <p>Condensed Consolidated Statements of Earnings</p>
          <p>(in millions, except per share amounts)</p>
          <p>Three months ended | Twelve months ended</p>
          <p>6/30/2026 | 6/30/2025 | 6/30/2026 | 6/30/2025</p>
          <p>Net sales | $ | 1,948 | $ | 1,988 | $ | 6,720 | $ | 7,104</p>
          <p>Net earnings attributable to Clorox | $ | 163 | $ | 332 | $ | 587 | $ | 810</p>
          <p>Diluted net earnings per share | $ | 1.34 | $ | 2.68 | $ | 4.81 | $ | 6.52</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", numericValue: 1.34, value: "$1.34"}),
      expect.objectContaining({key: "revenue", numericValue: 1_950_000_000, value: "$1.95B"}),
      expect.objectContaining({key: "net_income", numericValue: 163_000_000}),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$4.81");
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$6.72B");
  });

  test("keeps Merck guidance, prior-year comparatives and per-share charges out of reported metrics", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Merck Announces Second-Quarter 2026 Financial Results</h1>
          <p>- | Total Worldwide Sales Were $16.6 Billion (5% Growth; 4% Growth ex-FX)</p>
          <p>- | Now Expects Non-GAAP EPS To Be Between $2.66 and $2.76</p>
          <p>$ in millions, except per share amounts</p>
          <p>Second Quarter</p>
          <p>2026 | 2025 | Change</p>
          <p>Sales</p>
          <p>$ | 16,607</p>
          <p>$ | 15,806</p>
          <p>GAAP net (loss) income</p>
          <p>(1,335 | )</p>
          <p>4,427</p>
          <p>GAAP EPS</p>
          <p>(0.54 | )</p>
          <p>1.76</p>
          <p>GAAP loss per share was $0.54 in the second quarter of 2026 compared with earnings per share of $1.76 for the second quarter of 2025.</p>
          <p>Both the GAAP and non-GAAP loss per share were due to a charge for the acquisition of Terns of $2.31 per share.</p>
          <p>Increase to net loss / decrease to net income | | $ | 1,005 | | | $ | 939</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", numericValue: -0.54, value: "-$0.54"}),
      expect.objectContaining({key: "revenue", numericValue: 16_607_000_000}),
      expect.objectContaining({key: "net_income", numericValue: -1_335_000_000}),
    ]));
    const values = parsedDocument.metrics.map(metric => metric.value);
    expect(values).not.toContain("$1.76");
    expect(values).not.toContain("$2.66");
    expect(values).not.toContain("$2.31B");
    expect(values).not.toContain("$1B");
  });

  test("keeps McDonald's Systemwide sales out of revenue and reads the diluted EPS column", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>McDonald's Corporation Reports Second Quarter 2026 Results</h1>
          <p>Global Systemwide sales increased 5% (4% in constant currencies) to $37 billion for the quarter</p>
          <p>Dollars in millions, except per share data</p>
          <p>Quarters Ended June 30,</p>
          <p>2026 | 2025 | Inc/ (Dec)</p>
          <p>Revenues | $ | 7,099 | | $ | 6,843 | | 4 | | % | | 2 | | %</p>
          <p>Net income | 2,362 | | 2,253 | | 5 | | 4</p>
          <p>Earnings per share-diluted | $ | 3.32 | | $ | 3.14 | | 6 | | % | | 5 | | %</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", numericValue: 3.32, value: "$3.32"}),
      expect.objectContaining({key: "revenue", numericValue: 7_099_000_000}),
      expect.objectContaining({key: "net_income", numericValue: 2_362_000_000}),
    ]));
    const values = parsedDocument.metrics.map(metric => metric.value);
    expect(values).not.toContain("$37B");
    expect(values).not.toContain("$3.00");
  });

  test("reads Pfizer summary-table EPS rows instead of non-GAAP definition footnotes", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Pfizer Reports Second-Quarter 2026 Results</h1>
          <p>($ in millions, except per share amounts)</p>
          <p>Second-Quarter | Six Months</p>
          <p>2026 | 2025 | % Change | 2026 | 2025 | % Change</p>
          <p>Revenues | $ 15,034 | $ 14,653 | 3% | $ 29,484 | $ 28,367 | 4%</p>
          <p>Reported<sup>(4)</sup> Diluted EPS/(LPS)</p>
          <p>(0.04) | 0.51 | * | 0.43 | 1.03 | (59%)</p>
          <p>Adjusted<sup>(3)</sup> Diluted EPS</p>
          <p>0.77 | 0.78 | -% | 1.52 | 1.69 | (10%)</p>
          <p>(3) Adjusted income and Adjusted diluted earnings per share (EPS) are defined as U.S. GAAP net income/(loss) attributable to Pfizer Inc. common shareholders and U.S. GAAP diluted EPS/(LPS) attributable to Pfizer Inc. common shareholders before the impact of amortization of intangible assets and certain significant items and should not be viewed as substitutes for diluted EPS/(LPS)(4).</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", numericValue: -0.04, value: "-$0.04"}),
      expect.objectContaining({key: "adjusted_eps", numericValue: 0.77, value: "$0.77"}),
    ]));
    const values = parsedDocument.metrics.map(metric => metric.value);
    expect(values).not.toContain("-$4.00");
    expect(values).not.toContain("-$3.00");
  });

  test("reports BP group revenue in its dollar reporting currency and EPS per ADS", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <p>bp-20260630 2026 Q2 BP PLC iso4217:USD iso4217:USD xbrli:shares iso4217:EUR iso4217:USD utr:bbl iso4217:USD</p>
          <h1>Group results second quarter and first half 2026</h1>
          <p>Second | Second | First | First</p>
          <p>quarter | quarter | half | half</p>
          <p>$ million | 2026 | 2025 | 2026 | 2025</p>
          <p>Sales and other operating revenues | 69,105 | 46,627 | 121,360 | 93,532</p>
          <p>Profit (loss) per ordinary share (cents) | 24.77 | 10.41 | 49.60 | 14.73</p>
          <p>Profit (loss) per ADS (dollars) | 1.49 | 0.62 | 2.98 | 0.88</p>
          <p>Earnings per share (Note 7)</p>
          <p>In the second quarter 2026, BP Capital Markets p.l.c. exercised its option to redeem &#8364;2.5 billion of hybrid bonds.</p>
          <p>Customers &amp; products</p>
          <p>Sales and other operating revenues for the second quarter and half year were $57.2 billion and $100.1 billion respectively.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        currencyCode: "USD",
        key: "revenue",
        numericValue: 69_105_000_000,
      }),
      expect.objectContaining({currencyCode: "USD", key: "gaap_eps", value: "$1.49"}),
    ]));
    const values = parsedDocument.metrics.map(metric => metric.value);
    expect(values).not.toContain("€69.11B");
    expect(values).not.toContain("$57.2B");
    expect(values).not.toContain("$7.00");
    expect(values).not.toContain("$24.77");
  });

  test("keeps Palantir US-segment revenue and Spotify operating income out of total revenue", () => {
    const palantirDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Palantir Reports Q2 2026 Results</h1>
          <p>U.S. revenue grew 115% year-over-year and 23% quarter-over-quarter to $1.573 billion</p>
          <p>U.S. commercial revenue grew 149% year-over-year to $764 million</p>
          <p>Revenue grew 93% year-over-year and 19% quarter-over-quarter to $1.935 billion</p>
        </body>
      </html>
    `);

    expect(palantirDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "revenue", numericValue: 1_935_000_000}),
    ]));
    expect(palantirDocument.metrics.map(metric => metric.value)).not.toContain("$1.573B");

    const spotifyDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Spotify Technology S.A. Announces Financial Results for Second Quarter 2026</h1>
          <p>(&#8364;M) Total Revenue 4,193 4,533 4,777 Gross Profit 1,320 1,495 1,596</p>
          <p>than offset music costs and Other Costs of Revenue Operating Income was &#8364;655 million in Q2 and reflected the above</p>
          <p>Revenue of &#8364;4,777 million grew 14% Y/Y in Q2</p>
        </body>
      </html>
    `);

    expect(spotifyDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({currencyCode: "EUR", key: "revenue", numericValue: 4_777_000_000}),
    ]));
    expect(spotifyDocument.metrics.map(metric => metric.value)).not.toContain("€655M");
  });

  test("reads a SpaceX-style segment breakdown from its total row and signs the loss captions", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>SpaceX Reports Second Quarter 2026 Results</h1>
          <p>Second Quarter Financial Highlights $, in millions Three Months Ended Six Months Ended June 30, 2026 March 31, 2026 June 30, 2025 June 30, 2026 June 30, 2025 Revenue Space $962 $619 $746 $1,581 $1,611 Connectivity 4,291 3,257 2,588 7,548 5,062 AI 2,561 818 737 3,379 1,465 Total $7,814 $4,694 $4,071 $12,508 $8,138</p>
          <!-- One unbroken statement line with dotted leaders, as this filer renders it. -->
          <p>Consolidated Financial Statements Space Exploration Technologies Corp. Consolidated Statements of Operations (in millions, except per share data) (unaudited) Three Months Ended June 30, Six Months Ended June 30, 2026 2025 2026 2025 Revenue ............ $ 7,814 $ 4,071 $ 12,508 $ 8,138 Costs and expenses Cost of revenue ............ 3,495 2,282 5,883 4,244 Research and development ............ 3,548 1,958 7,062 3,515 Selling, general, and administrative ............ 912 606 1,658 1,099 Total costs and expenses ............ 7,957 5,041 14,594 9,081 Loss from operations ............ (143) (970) (2,086) (943) Interest expense ............ (629) (411) (1,293) (858) Interest income ............ 340 98 553 215 Loss before income taxes ............ (518) (870) (4,788) (1,384) Provision for income taxes ............ 23 138 29 152 Net loss ............ $ (541) $ (1,008) $ (4,817) $ (1,536) Net loss per share of common stock attributable to common shareholders Basic and Diluted ............ $ (0.09) $ (0.34) $ (1.12) $ (0.53) Weighted average shares used in computing net loss per share Basic and Diluted ............ 5,864 2,929 4,879 2,902</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "revenue", numericValue: 7_814_000_000}),
      expect.objectContaining({key: "net_income", numericValue: -541_000_000}),
      expect.objectContaining({key: "gaap_eps", numericValue: -0.09, value: "-$0.09"}),
    ]));
    const values = parsedDocument.metrics.map(metric => metric.value);
    expect(values).not.toContain("$962M");
    expect(values).not.toContain("$541M");
  });

  test("keeps Zeta full-year EPS guidance and a trailing-quarters column out of reported metrics", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Zeta Global Reports Second Quarter 2026 Results</h1>
          <p>Achieved positive GAAP net income of $8 million, and GAAP earnings per share of $0.03. Generated $92 million of adjusted EBITDA and expanded adjusted EBITDA margin by 170 bps Y/Y to 20.7%.</p>
          <p>Increasing full year 2026 GAAP EPS guidance to a range of $0.09 to $0.11, up $0.07 from prior guidance of $0.02 to $0.04.</p>
          <p>(in thousands)</p>
          <p>Three months ended June 30,</p>
          <p>Six months ended June 30,</p>
          <p>2026</p><p>2025</p><p>2026</p><p>2025</p>
          <p>Revenues</p>
          <p>$ 442,766</p><p>$ 308,442</p><p>$ 839,070</p><p>$ 572,861</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", numericValue: 0.03, value: "$0.03"}),
      expect.objectContaining({key: "revenue", numericValue: 442_766_000}),
    ]));
    const values = parsedDocument.metrics.map(metric => metric.value);
    expect(values).not.toContain("$0.09");
    expect(values).not.toContain("$337M");
  });

  test("reads Arista and Gilead non-GAAP per-share labels without taking a revenue milestone", () => {
    const aristaDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Arista Networks, Inc. Reports Second Quarter 2026 Financial Results</h1>
          <p>Delivered 40% growth in non-GAAP EPS year-over-year as the company achieved its first $3+ billion revenue quarter.</p>
          <p>(In millions, except per share amounts)</p>
          <p>Three Months Ended June 30, | Six Months Ended June 30,</p>
          <p>2026 | 2025 | 2026 | 2025</p>
          <p>GAAP diluted net income per share | $ | 0.95 | $ | 0.70 | $ | 1.75 | $ | 1.34</p>
          <p>Non-GAAP diluted net income per share(1)</p>
          <p>$ | 1.02 | $ | 0.73 | $ | 1.89 | $ | 1.40</p>
        </body>
      </html>
    `);

    expect(aristaDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "adjusted_eps", numericValue: 1.02, value: "$1.02"}),
      expect.objectContaining({key: "gaap_eps", numericValue: 0.95, value: "$0.95"}),
    ]));
    expect(aristaDocument.metrics.map(metric => metric.value)).not.toContain("$3.00");

    // A loss caption states its magnitude, so the sign comes from the caption rather than
    // the cell — but a bracketed cell must not be negated twice.
    const gileadDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Gilead Sciences Announces Second Quarter 2026 Financial Results</h1>
          <p>Diluted Loss Per Share was $(8.45) and Non-GAAP Diluted Loss Per Share was $(6.75)</p>
          <p>Merck-style magnitude wording: Non-GAAP Loss per Share Was $0.13</p>
        </body>
      </html>
    `);

    expect(gileadDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "adjusted_eps", numericValue: -6.75, value: "-$6.75"}),
    ]));
    expect(gileadDocument.metrics.map(metric => metric.value)).not.toContain("$6.75");
    expect(gileadDocument.metrics.map(metric => metric.value)).not.toContain("$0.13");
  });

  test("keeps a dollar amount preceded by a word ending in 'nt' out of New Taiwan dollars", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>Opendoor Technologies Inc Reports Second Quarter 2026 Results</h1>
          <p>Since 2022, we spent $400 million building our resale platform.</p>
          <p>(in millions, except per share amounts)</p>
          <p>Three Months Ended June 30,</p>
          <p>2026 | 2025</p>
          <p>Revenue | $ | 883 | $ | 1,567</p>
          <p>Net loss | $ | (162) | $ | (29)</p>
          <p>Net loss per share attributable to common shareholders:</p>
          <p>Basic | $ | (0.17) | $ | (0.04)</p>
          <p>Diluted | $ | (0.17) | $ | (0.04)</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({currencyCode: "USD", key: "revenue", value: "$883M"}),
      expect.objectContaining({key: "net_income", numericValue: -162_000_000}),
      expect.objectContaining({key: "gaap_eps", numericValue: -0.17, value: "-$0.17"}),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("NT$883M");
  });

  test("prefers the diluted per-share row over the basic row printed above it", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo Reports Second Quarter 2026 Results</h1>
          <p>(in millions, except per share amounts)</p>
          <p>Three Months Ended June 30,</p>
          <!-- Captions that do not start with basic/diluted stay separate candidates, so
               the choice between them rests on scoring rather than row continuation. -->
          <p>Earnings per share attributable to common stockholders, basic | $ | 0.44</p>
          <p>Earnings per share attributable to common stockholders, diluted | $ | 0.41</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", numericValue: 0.41, value: "$0.41"}),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$0.44");
  });

  test("prefers a per-share row over an EPS reconciliation that restates the numerator", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo Announces Financial Results for Second Quarter 2026</h1>
          <p>(in € millions, except share and per share data)</p>
          <p>Three months ended June 30, 2026</p>
          <p>Diluted earnings per share Net income attributable to owners of the parent 545 721 (86) Shares used in computation 208,858,469</p>
          <p>Earnings per share attributable to owners of the parent Basic 2.65 3.50 (0.42) Diluted 2.61 3.45 (0.42)</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({currencyCode: "EUR", key: "gaap_eps", numericValue: 2.61}),
    ]));
    const values = parsedDocument.metrics.map(metric => metric.value);
    expect(values).not.toContain("-€86.00");
    expect(values).not.toContain("€2.65");
  });

  // The half-year wording ("six-month 2026 earnings ... or $5.00 per share") and the comparison
  // clause left on its own line by a paragraph break are pinned by the ConocoPhillips and
  // Innodata corpus entries. Reduced to a synthetic document neither reproduces the tie they
  // lost — the surrounding filing is what makes the wrong line competitive — so a synthetic
  // here would pass with or without the guard and imply coverage that is not there.

  test("reads a non-GAAP measure captioned with diluted after per", () => {
    // Without this spelling the measure's only source was the guidance range below it, whose
    // low end was posted as the quarter's result.
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo Announces Second Quarter 2026 Financial Results</h1>
          <p>Three Months Ended June 30, 2026</p>
          <p>GAAP net income per diluted share was $0.12; non-GAAP net income per diluted share was $0.65.</p>
          <p>Third Quarter 2026 Outlook:</p>
          <p>Non-GAAP net income per share between $0.63 and $0.65, assuming approximately 378 million weighted average diluted shares outstanding.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "adjusted_eps", numericValue: 0.65}),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$0.63");
  });

  test("keeps the reported figure from a clause that goes on to give the non-GAAP one", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo Announces Second Quarter 2026 Results</h1>
          <p>Three Months Ended June 30, 2026</p>
          <p>For the three months ended June 30, 2026: GAAP diluted net loss per share $0.16; non-GAAP diluted net loss per share $0.05</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", numericValue: -0.16}),
      expect.objectContaining({key: "adjusted_eps", numericValue: -0.05}),
    ]));
  });

  test("signs a loss stated beside the value under a combined caption", () => {
    // "loss / earnings per share" carries no sign of its own, so the words introducing the
    // value are the only place the sign appears.
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo Announces Second Quarter 2026 Results</h1>
          <p>Three Months Ended June 30, 2026</p>
          <p>Generally Accepted Accounting Principles (GAAP) loss / earnings per share (EPS) assuming dilution was a loss per share of $0.54 and non-GAAP loss per share was $0.13.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", numericValue: -0.54}),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$0.54");
  });

  test("reads diluted EPS when attributable stockholders appear inside the caption", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo Announces Second Quarter 2026 Results</h1>
          <p>Three Months Ended June 30, 2026</p>
          <p>Net income attributable to common stockholders per share—basic | $ | 0.54 | $ | 0.15</p>
          <p>Net income attributable to common stockholders per share—diluted | $ | 0.51 | $ | 0.14</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", numericValue: 0.51, value: "$0.51"}),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$0.54");
  });

  test("prefers reported adjusted EPS over a further-normalized excluding variant", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo Reports Q4 Fiscal Year 2026 Results</h1>
          <p>Excluding a one-time positive impact of $0.31, fourth quarter non-GAAP diluted EPS increased 25% to $2.60.</p>
          <p>Fourth quarter non-GAAP diluted EPS increased 40% to $2.91.</p>
          <p>Q4 FY26 | Q4 FY25 | Y/Y</p>
          <p>Non-GAAP diluted EPS | $2.91 | $2.08 | 40%</p>
          <p>Non-GAAP diluted EPS, excluding the one-time item | $2.60 | $2.08 | 25%</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "adjusted_eps", numericValue: 2.91, value: "$2.91"}),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$2.60");
  });

  test("keeps reported EPS stated before a separate per-share impact", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo Announces Second Quarter 2026 Results</h1>
          <p>Three Months Ended June 30, 2026</p>
          <p>GAAP diluted EPS was $1.20, including an unfavorable impact of $0.20 per diluted share.</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "gaap_eps", numericValue: 1.2, value: "$1.20"}),
    ]));
    expect(parsedDocument.metrics.map(metric => metric.value)).not.toContain("$0.20");
  });

});
