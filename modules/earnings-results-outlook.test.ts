import {describe, expect, test} from "vitest";
import {extractOutlookMetrics} from "./earnings-results-outlook.ts";

describe("extractOutlookMetrics", () => {
  test("extracts mixed-period guidance from a forward-looking heading", () => {
    expect(extractOutlookMetrics([
      "Forward-Looking Guidance",
      "For the full-year 2026, the company expects revenue between $3,900 million and $3,950 million, GAAP loss per share of $0.07 to $0.12, and non-GAAP earnings per share of $3.60 to $3.70.",
      "For the third quarter of 2026, the company expects revenue between $953 million and $978 million, GAAP earnings per share of $0.39 to $0.44, and non-GAAP earnings per share of $0.83 to $0.88.",
    ])).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        periodLabel: "FY2026",
        value: "$3.9B to $3.95B",
      },
      {
        key: "revenue",
        label: "Revenue",
        periodLabel: "Q3",
        value: "$953M to $978M",
      },
      {
        key: "adjusted_eps",
        label: "Adj EPS",
        periodLabel: "FY2026",
        value: "$3.6 to $3.7",
      },
      {
        key: "adjusted_eps",
        label: "Adj EPS",
        periodLabel: "Q3",
        value: "$0.83 to $0.88",
      },
      {
        key: "eps",
        label: "EPS",
        periodLabel: "FY2026",
        value: "-$0.07 to -$0.12",
      },
      {
        key: "eps",
        label: "EPS",
        periodLabel: "Q3",
        value: "$0.39 to $0.44",
      },
    ]);
  });

  test("extracts normalized outlook metrics and stops before boilerplate sections", () => {
    const metrics = extractOutlookMetrics([
      "First quarter results",
      "Business Outlook",
      "Revenue is expected to be between $10.5 billion and $11.5 billion.",
      "Diluted EPS expected in the range of $1.20 to $1.30.",
      "Gross margin expected to be 45% to 47%.",
      "Operating expenses approximately $500 million.",
      "Tax rate around 16%.",
      "Capital expenditures expected to be $300M.",
      "Free cash flow expected to be $1.2B.",
      "Forward-looking statements",
      "Revenue is expected to be $99B.",
    ]);

    expect(metrics).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        value: "$10.5B to $11.5B",
      },
      {
        key: "eps",
        label: "EPS",
        value: "$1.2 to $1.3",
      },
      {
        key: "gross_margin",
        label: "Gross margin",
        value: "45% to 47%",
      },
      {
        key: "operating_expenses",
        label: "Operating expenses",
        value: "$500M",
      },
      {
        key: "tax_rate",
        label: "Tax rate",
        value: "16%",
      },
      {
        key: "capex",
        label: "Capex",
        value: "$300M",
      },
    ]);
  });

  test("handles qualified growth language and negative money ranges", () => {
    const metrics = extractOutlookMetrics([
      "Fiscal 2026 Outlook",
      "Net sales expected to decline low double-digit.",
      "Operating margin should be 21.5%.",
      "Operating income of ($200 million) to ($100 million).",
      "Free cash flow remains positive despite investment cycle.",
      "Conference call",
      "Operating income $5B.",
    ]);

    expect(metrics).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        value: "low double-digit decline",
      },
      {
        key: "operating_margin",
        label: "Operating margin",
        value: "21.5%",
      },
      {
        key: "operating_income",
        label: "Operating income",
        value: "-$200M to -$100M",
      },
    ]);
  });

  test("keeps scale words outside accounting parentheses in negative ranges", () => {
    expect(extractOutlookMetrics([
      "Financial Outlook",
      "Adjusted EBITDA to be in the range of ($400) million to ($445) million.",
    ])).toEqual([
      {
        key: "adjusted_ebitda",
        label: "Adj EBITDA",
        value: "-$400M to -$445M",
      },
    ]);
  });

  test("stops a short outlook section before key financial results", () => {
    expect(extractOutlookMetrics([
      "Outlook - Six Months Ended December 31, 2026",
      "Adjusted EPS is expected to be $1.80 to $1.90.",
      "Key Financials",
      "Net sales | 5,082 | 6,398 | 15,009 | 23,506",
    ])).toEqual([
      {
        key: "adjusted_eps",
        label: "Adj EPS",
        value: "$1.8 to $1.9",
      },
    ]);
  });

  test("applies an explicit loss caption to an unsigned guidance range", () => {
    expect(extractOutlookMetrics([
      "Business Outlook",
      "Adjusted EBITDA loss of $17 million to $23 million.",
    ])).toEqual([
      {
        key: "adjusted_ebitda",
        label: "Adj EBITDA",
        value: "-$17M to -$23M",
      },
    ]);
  });

  test("ignores non-outlook and forward-looking boilerplate headings", () => {
    expect(extractOutlookMetrics([
      "Forward-looking statements",
      "Revenue expected to be $10B.",
    ])).toEqual([]);

    expect(extractOutlookMetrics([
      "Quarter Outlook",
      "Revenue guidance expected to be n/a.",
      "Appendix",
      "EPS $1.20.",
    ])).toEqual([]);

    expect(extractOutlookMetrics([
      "ExampleCo Announces First Quarter Results; Reaffirms Full Year Guidance",
      "Revenue | $ | 121,144 | | | $ | 97,792 | | | | | 23.9",
      "Operating income (loss) | | 2,045 | | | (1,923) | | | | | 206.3",
    ])).toEqual([]);
  });

  test("ignores dense comparison-table rows inside outlook sections", () => {
    expect(extractOutlookMetrics([
      "Business Outlook",
      "Revenue | $ | 121,144 | | | $ | 97,792 | | | | | 23.9",
      "Operating income (loss) | | 2,045 | | | (1,923) | | | | | 206.3",
    ])).toEqual([]);
  });

  test("ignores outlook mentions in summary bullets and extracts later guidance", () => {
    expect(extractOutlookMetrics([
      "Revenue guidance raised to $442-$447M; Reiterating Q4 FY26 Adj EBITDA breakeven",
      "Revenue exceeded guidance, coming in at $110.7 million.",
      "Fiscal 2026 Financial Guidance",
      "The following statements are based on current expectations for fiscal 2026. The following statements are forward-looking, and actual results could differ materially depending on market conditions.",
      "Total revenue in the range of $442 million to $447 million.",
      "Gross margin to be above 52% for fiscal 2026.",
    ])).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        value: "$442M to $447M",
      },
      {
        key: "gross_margin",
        label: "Gross margin",
        value: "52%",
      },
    ]);
  });

  test("does not treat margin percentage ranges as revenue guidance", () => {
    expect(extractOutlookMetrics([
      "Outlook",
      "The Company is updating its estimates for the year ending December 31, 2026, which reflects the addition of PayneCrest. Net income is expected to be between $223.0 million and $234.0 million. Earnings per Share (EPS) is expected to be between $4.05 and $4.25 per fully diluted share. Adjusted EPS is estimated in the range of $4.80 to $5.00, and Adjusted EBITDA for the full year 2026 is expected to range from $480.0 to $500.0 million.",
      "The Company is targeting SG&A expenses as a percentage of revenue in the mid-to-high 5% range for full year 2026. The Company's targeted gross margins by segment are as follows: Utilities in the range of 10 to 12%; Energy in the range of 9 to 11%.",
    ])).toEqual([
      // The sentence guides on both per-share measures, so both are reported under their
      // own labels rather than the adjusted figure appearing as the GAAP one.
      {
        key: "adjusted_eps",
        label: "Adj EPS",
        value: "$4.8 to $5",
      },
      {
        key: "eps",
        label: "EPS",
        value: "$4.05 to $4.25",
      },
      {
        key: "adjusted_ebitda",
        label: "Adj EBITDA",
        value: "$480M to $500M",
      },
    ]);
  });

  test("extracts Enbridge-style guidance without reading into financing updates", () => {
    expect(extractOutlookMetrics([
      "FINANCIAL OUTLOOK",
      "The Company reaffirms its 2026 financial guidance for adjusted EBITDA between $20.2 billion and $20.8 billion and DCF per share between $5.70 and $6.10.",
      "The Company also reaffirms its post-2026 adjusted EBITDA, DCF per share, and EPS near-term average compound annual growth rate of approximately 5%.",
      "FINANCING UPDATE",
      "Proceeds from these offerings were used to pay down existing indebtedness, finance capital expenditures, and for general corporate purposes.",
      "SECURED GROWTH PROJECT EXECUTION UPDATE",
      "Enbridge's share of the capital expenditures is expected to be US$0.1 billion and the project is expected to enter service in late 2028.",
    ])).toEqual([
      {
        key: "adjusted_ebitda",
        label: "Adj EBITDA",
        value: "$20.2B to $20.8B",
      },
      {
        key: "dcf_per_share",
        label: "DCF/share",
        value: "$5.7 to $6.1",
      },
    ]);
  });

  test("extracts single-value outlook metrics across supported value types", () => {
    const metrics = extractOutlookMetrics([
      "Guidance",
      "Revenue should show double-digit growth.",
      "Earnings per share expected to be ($0.25).",
      "Gross margin approximately 44.5%.",
      "Operating income about $1.2 trillion.",
      "Opex of $2.4bn.",
      "Capital expenditures roughly $12m.",
      "Tax rate not available.",
    ]);

    expect(metrics).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        value: "double-digit growth",
      },
      {
        key: "eps",
        label: "EPS",
        value: "-$0.25",
      },
      {
        key: "gross_margin",
        label: "Gross margin",
        value: "44.5%",
      },
      {
        key: "operating_income",
        label: "Operating income",
        value: "$1.2T",
      },
      {
        key: "operating_expenses",
        label: "Operating expenses",
        value: "$2.4B",
      },
      {
        key: "capex",
        label: "Capex",
        value: "$12M",
      },
    ]);
  });

  test("keeps EPS percentage outlook as percentages instead of dollar EPS values", () => {
    expect(extractOutlookMetrics([
      "Guidance and Outlook",
      "Full year adjusted EPS growth of approximately 12%.",
      "Revenue expected to increase high single-digit.",
    ])).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        value: "high single-digit growth",
      },
      {
        key: "adjusted_eps",
        label: "Adj EPS",
        value: "12% growth",
      },
    ]);
  });

  test("keeps same-sentence outlook values scoped to their metric labels", () => {
    expect(extractOutlookMetrics([
      "Fiscal 2026 Outlook",
      "Management expects approximately 14% total revenue growth and guided to net sales of $690-$710M, adjusted EPS of $3.65-$3.85, and adjusted tax rate of 21%-22%.",
    ])).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        value: "$690M to $710M",
      },
      {
        key: "adjusted_eps",
        label: "Adj EPS",
        value: "$3.65 to $3.85",
      },
      {
        key: "tax_rate",
        label: "Tax rate",
        value: "21% to 22%",
      },
    ]);
  });

  test("prefers guidance free cash flow ranges and preserves non-USD currency", () => {
    expect(extractOutlookMetrics([
      "Outlook",
      "Free cash flow was EUR 28 million in Q1 2026.",
      "Management reiterated full-year 2026 guidance for 3%-4.5% comparable sales growth, a 12.5%-13.0% adjusted EBITA margin, and €1.3B-€1.5B in free cash flow.",
    ])).toEqual([
      {
        key: "free_cash_flow",
        label: "Free cash flow",
        periodLabel: "FY2026",
        value: "€1.3B to €1.5B",
      },
    ]);
  });

  test("labels mixed quarter and full-year guidance and preserves three-decimal billions", () => {
    expect(extractOutlookMetrics([
      "2026 Guidance Summary",
      "For the third quarter of 2026, revenues are expected to range between $2.525 and $2.575 billion.",
      "For the third quarter of 2026, adjusted EBITDA is expected to range between $1.275 and $1.315 billion.",
      "For the full year of 2026, total capital expenditures are expected to range between $5.000 and $6.000 billion.",
      "Operating margin is expected to be approximately 35%.",
    ])).toEqual([
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
  });

  test("keeps quarter and full-year values and maps basis-specific tax assumptions", () => {
    expect(extractOutlookMetrics([
      "Business Outlook",
      "The Company expects net sales in the range of $14.5 billion and $15.5 billion for the first quarter of fiscal year 2027, GAAP net income per diluted share of $0.89 to $0.98 and non-GAAP net income per diluted share of $1.01 to $1.10. The Company's projections for GAAP and non-GAAP net income per diluted share assume a tax rate of approximately 20.1% and 20.5%, respectively.",
      "For fiscal year 2027, the Company expects net sales in the range of $65.0 billion to $72.0 billion.",
    ])).toEqual([
      {key: "revenue", label: "Revenue", periodLabel: "Q1", value: "$14.5B to $15.5B"},
      {key: "revenue", label: "Revenue", periodLabel: "FY2027", value: "$65B to $72B"},
      {key: "adjusted_eps", label: "Adj EPS", periodLabel: "Q1", value: "$1.01 to $1.1"},
      {key: "eps", label: "EPS", periodLabel: "Q1", value: "$0.89 to $0.98"},
      {key: "tax_rate", label: "Tax rate", periodLabel: "Q1", value: "20.1%"},
    ]);
  });

  test("treats a quarter of a fiscal year as one outlook period", () => {
    expect(extractOutlookMetrics([
      "Business Outlook",
      "Lumentum expects the following for the first quarter of fiscal year 2027:",
      "Net revenue in the range of $1.225 billion to $1.275 billion",
      "Non-GAAP operating margin of 39.5% to 40.5%",
      "Non-GAAP diluted net income per share of $4.05 to $4.35",
    ])).toEqual([
      {key: "revenue", label: "Revenue", value: "$1.225B to $1.275B"},
      {key: "adjusted_eps", label: "Adj EPS", value: "$4.05 to $4.35"},
      {key: "operating_margin", label: "Operating margin", value: "39.5% to 40.5%"},
    ]);
  });

  test("maps a reversed non-GAAP and GAAP tax-rate pair to GAAP", () => {
    expect(extractOutlookMetrics([
      "Business Outlook",
      "For Q1 2027, projections for non-GAAP and GAAP EPS assume a tax rate of 20.5% and 20.1%, respectively.",
    ])).toEqual([
      {key: "tax_rate", label: "Tax rate", value: "20.1%"},
    ]);
  });

  test("does not turn respectively mapped percentages into a range", () => {
    expect(extractOutlookMetrics([
      "Business Outlook",
      "For Q1 2027, the two earnings bases assume a tax rate of 20.1% and 20.5%, respectively.",
    ])).toEqual([
      {key: "tax_rate", label: "Tax rate", value: "20.1%"},
    ]);
  });

  test("uses the first stated outlook period and ignores calendar ordinals as EPS", () => {
    expect(extractOutlookMetrics([
      "Financial Outlook",
      "We expect double-digit growth in adjusted EPS in fiscal 2027, excluding the impact of the 53rd week. In Q4 fiscal 2027, we will lap the 53rd week in Q4 fiscal 2026.",
      "For Q4 fiscal 2027, operating income is expected to be $4.9 billion.",
    ])).toEqual([
      {key: "adjusted_eps", label: "Adj EPS", periodLabel: "FY2027", value: "double-digit growth"},
      {key: "operating_income", label: "Operating income", periodLabel: "Q4", value: "$4.9B"},
    ]);
  });

  test("extracts Trane-style full-year growth and continuing EPS guidance", () => {
    expect(extractOutlookMetrics([
      "Company Raises Full-Year 2026 Guidance",
      "The Company expects full-year 2026 reported revenue growth of approximately 11.5 percent and organic revenue growth of approximately 9 percent versus full-year 2025.",
      "The Company expects GAAP continuing EPS for full-year 2026 of approximately $15.00 to $15.10, including $0.20 for non-GAAP adjustments. The Company expects adjusted continuing EPS for full-year 2026 of $15.20 to $15.30.",
    ])).toEqual([
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

  // A guidance table states its basis once, in the prose above it, and then captions its rows
  // plainly. Reading the caption alone posts the excluded items away: Lilly's "Earnings per
  // Share | $35.50 to $36.50" is its non-GAAP guidance, not its reported guidance.
  describe("a section that declares a non-GAAP basis", () => {
    test("posts a plainly captioned per-share row as adjusted", () => {
      expect(extractOutlookMetrics([
        "2026 Financial Guidance",
        "In addition to providing guidance for GAAP revenue, Lilly provides guidance for certain non-GAAP measures.",
        "| | | Prior | Updated |",
        "Revenue | | | $82 to $85 billion | $85 to $87 billion |",
        "Earnings per Share",
        "| | | $35.50 to $37.00 | $35.50 to $36.50 |",
      ])).toEqual([
        {key: "revenue", label: "Revenue", value: "$85B to $87B"},
        {key: "adjusted_eps", label: "Adj EPS", value: "$35.5 to $36.5"},
      ]);
    });

    test("leaves a row that names GAAP itself under the reported label", () => {
      expect(extractOutlookMetrics([
        "2026 Financial Guidance",
        "The company is updating its non-GAAP financial guidance for full-year 2026.",
        "The company expects GAAP EPS of $4.10 to $4.30.",
      ])).toEqual([
        {key: "eps", label: "EPS", value: "$4.1 to $4.3"},
      ]);
    });

    test("is not declared by the boilerplate footnote about reconciliations", () => {
      // Filings that guide on a non-GAAP measure carry this sentence whether or not the rows
      // themselves are non-GAAP. It names the words without stating the basis.
      expect(extractOutlookMetrics([
        "2026 Financial Guidance",
        "The company expects earnings per share of $4.10 to $4.30 for full-year 2026.",
        "The company does not provide reconciliations of forward-looking non-GAAP measures to the most directly comparable GAAP measures.",
      ])).toEqual([
        {key: "eps", label: "EPS", value: "$4.1 to $4.3"},
      ]);
    });
  });

  test("prefers a two-column guidance row over the prose around it", () => {
    // One caption cell and one value cell is one pipe. Scored as prose, the row lost to a
    // sentence carrying a different year's "midpoint opportunity" — which the filing's own
    // footnote calls not intended to be guidance.
    expect(extractOutlookMetrics([
      "Guidance 3",
      "($ in millions)",
      "| Reaffirmed 2026",
      "Guidance Ranges",
      "Ongoing Operations Adjusted EBITDA | $6,800 - $7,600",
      "The company's comprehensive hedging program provides support for the reaffirmed 2026 guidance ranges and the previously announced Ongoing Operations Adjusted EBITDA midpoint opportunity 2 range of $7.4 billion to $7.8 billion for 2027.",
    ])).toEqual([
      {key: "adjusted_ebitda", label: "Adj EBITDA", value: "$6.8B to $7.6B"},
    ]);
  });

  test("reads absolute CHF guidance after a repeated net-sales caption", () => {
    expect(extractOutlookMetrics([
      "Outlook",
      "Net Sales: Expected to grow in the low-20% range. At current spot rates, this implies absolute net sales of CHF 3.47 billion to CHF 3.56 billion.",
      "Gross profit margin: Expected to be at least 65.0%.",
    ], "CHF")).toEqual([
      {key: "revenue", label: "Revenue", value: "CHF 3.47B to CHF 3.56B"},
      {key: "gross_margin", label: "Gross margin", value: "65.0%"},
    ]);
  });

  test("keeps a non-GAAP EPS row inside a fiscal-year outlook section", () => {
    expect(extractOutlookMetrics([
      "Fiscal year 2027 outlook 2",
      "Non-GAAP earnings per share | $12.40 to $12.60 |",
    ])).toEqual([
      {key: "adjusted_eps", label: "Adj EPS", value: "$12.4 to $12.6"},
    ]);
  });

  test("reads sparse guidance rows under a fiscal full-year outlook caption", () => {
    expect(extractOutlookMetrics([
      "Fiscal Full-Year 2026 Outlook:",
      "CAVA Group reaffirmed fiscal full-year 2026 guidance, as follows:",
      "Adjusted EBITDA | | $181.0 to $191.0 million | |",
    ])).toEqual([
      {key: "adjusted_ebitda", label: "Adj EBITDA", value: "$181M to $191M"},
    ]);
  });

  test("keeps core guidance separated across quarter and full-year sections", () => {
    expect(extractOutlookMetrics([
      "Third Quarter 2026 Financial Outlook",
      "Core Non-GAAP Financial Outlook:",
      "Core revenue of approximately $214 to $216 million",
      "Core gross margin in the range of 38% - 40%",
      "Core operating margins in the range of (25%) to (23%)",
      "Full Year 2026 Financial Outlook",
      "Core Non-GAAP Financial Outlook has been raised for all metrics:",
      "Core revenue of $880 to $890 million",
      "Core gross margin in the range of 41% - 43%",
      "Core operating margins in the range of (19%) to (17%)",
    ])).toEqual([
      {key: "core_revenue", label: "Core revenue", periodLabel: "Q3", value: "$214M to $216M"},
      {key: "core_revenue", label: "Core revenue", periodLabel: "FY2026", value: "$880M to $890M"},
      {key: "core_gross_margin", label: "Core gross margin", periodLabel: "Q3", value: "38% to 40%"},
      {key: "core_gross_margin", label: "Core gross margin", periodLabel: "FY2026", value: "41% to 43%"},
      {key: "core_operating_margin", label: "Core operating margin", periodLabel: "Q3", value: "-25% to -23%"},
      {key: "core_operating_margin", label: "Core operating margin", periodLabel: "FY2026", value: "-19% to -17%"},
    ]);
  });

  test("reads only the guidance column of a results comparison table", () => {
    expect(extractOutlookMetrics([
      "Financial Outlook",
      "(unaudited, in millions, except per share data)",
      "| | Q3 2026 Guidance (1)",
      "| | Q3 2025 Results | | Q2 2026 Results |",
      "Revenue | | $9.0 - 10.0 | | $8.0 | | $9.0 |",
      "Non-GAAP loss from operations",
      "| | ($29.0 - 32.0) | | ($29.8) | | ($28.8) |",
      "Non-GAAP net loss per share",
      "| | ($0.13 - 0.17) | | ($0.14) | | ($0.13) |",
      "Capital expenditures",
      "| | $8.0 - 12.0 | | $3.0 | | $9.6 |",
    ])).toEqual([
      {key: "revenue", label: "Revenue", value: "$9M to $10M"},
      {key: "adjusted_eps", label: "Adj EPS", value: "-$0.13 to -$0.17"},
      {key: "adjusted_operating_income", label: "Adj operating income", value: "-$29M to -$32M"},
      {key: "capex", label: "Capex", value: "$8M to $12M"},
    ]);
  });

  test("extracts quantified guidance embedded in prose without a section heading", () => {
    expect(extractOutlookMetrics([
      "Based on its cash position, the company projects its runway into 2029. Guidance for operating expense in 2026 is expected to be approximately $165 million. GAAP operating expenses are expected to be approximately $225 million.",
      "Conference Call",
    ])).toEqual([
      {key: "gaap_operating_expenses", label: "GAAP operating expenses", value: "$225M"},
      {key: "operating_expenses", label: "Operating expenses", value: "$165M"},
    ]);
  });

  test("keeps the metric on an inline annual outlook heading", () => {
    expect(extractOutlookMetrics([
      "2026 Outlook: Raised full-year revenue outlook to approximately $43 million and reiterated the target of 30 logical qubits in 2026",
      "Second Quarter and Recent Business Highlights",
    ])).toEqual([
      {key: "revenue", label: "Revenue", value: "$43M"},
    ]);
  });

  test("joins a wrapped range and preserves a postfix non-GAAP EPS basis", () => {
    expect(extractOutlookMetrics([
      "Business Outlook",
      "Revenue between $2.2 billion and $2.4 billion.",
      "EPS between $1.85 and $2.05 on a non-GAAP basis.",
      "Total operating expenses are expected to be between $400 million and",
      "$420 million on a non-GAAP basis.",
    ])).toEqual([
      {key: "revenue", label: "Revenue", value: "$2.2B to $2.4B"},
      {key: "adjusted_eps", label: "Adj EPS", value: "$1.85 to $2.05"},
      {key: "operating_expenses", label: "Operating expenses", value: "$400M to $420M"},
    ]);
  });

  test("inherits mixed periods from standalone SEC table captions", () => {
    expect(extractOutlookMetrics([
      "Guidance",
      "Q1 FY 2027 | | |",
      "Revenue | | $18.0 billion - $18.2 billion |",
      "Non-GAAP EPS | | $1.32 - $1.34 |",
      "FY 2027 | | |",
      "Revenue | | $72.2 billion - $73.4 billion |",
      "Non-GAAP EPS | | $5.05 - $5.11 |",
    ])).toEqual([
      {key: "revenue", label: "Revenue", periodLabel: "Q1", value: "$18B to $18.2B"},
      {key: "revenue", label: "Revenue", periodLabel: "FY2027", value: "$72.2B to $73.4B"},
      {key: "adjusted_eps", label: "Adj EPS", periodLabel: "Q1", value: "$1.32 to $1.34"},
      {key: "adjusted_eps", label: "Adj EPS", periodLabel: "FY2027", value: "$5.05 to $5.11"},
    ]);
  });

  test("limits outlook scanning and ignores unusable fallback values", () => {
    const lines = [
      "Business Outlook",
      "Revenue:",
      `Free cash flow ${"x".repeat(90)}.`,
    ];
    for (let index = 0; index < 35; index++) {
      lines.push(`Filler ${index}`);
    }
    lines.push("Revenue $99B");

    expect(extractOutlookMetrics(lines)).toEqual([]);
  });
});
