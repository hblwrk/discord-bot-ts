import {describe, expect, test} from "vitest";
import type {getMessageMetrics, parseEarningsDocument} from "./earnings-results-format.ts";
import {getEarningsResultMessage} from "./earnings-results-message.ts";

describe("earnings result message rendering", () => {
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
      "\u200B",
    ].join("\n"));
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
      "\u200B",
    ].join("\n"));
  });
});
