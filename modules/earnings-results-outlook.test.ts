import {describe, expect, test} from "vitest";
import {extractOutlookMetrics} from "./earnings-results-outlook.ts";

describe("extractOutlookMetrics", () => {
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

  test("handles growth language, negative money ranges, and fallback text", () => {
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
      {
        key: "free_cash_flow",
        label: "Free cash flow",
        value: "remains positive despite investment cycle",
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
        key: "tax_rate",
        label: "Tax rate",
        value: "not available",
      },
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
