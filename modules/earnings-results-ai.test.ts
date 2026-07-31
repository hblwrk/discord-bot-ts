import {beforeEach, describe, expect, test, vi} from "vitest";
import {
  checkEarningsQualityWithAi,
  clearEarningsAiState,
  getSuspiciousEarningsReasons,
  hasHighSeveritySuspicion,
} from "./earnings-results-ai.ts";

describe("AI earnings quality helpers", () => {
  const logger = {
    log: vi.fn(),
  };
  const readSecretFn = vi.fn((secretName: string) => {
    if ("gemini_api_key" === secretName) {
      return "gemini-key";
    }

    throw new Error(`missing ${secretName}`);
  });
  const html = `
    <html>
      <body>
        <h1>Example Corp reports first quarter 2026 results</h1>
        <p>Amounts in millions of dollars, except per share amounts.</p>
        <table>
          <tr><td>Adjusted EPS</td><td>$1.25</td></tr>
          <tr><td>Revenue</td><td>42.0</td></tr>
        </table>
      </body>
    </html>
  `;

  beforeEach(() => {
    vi.clearAllMocks();
    clearEarningsAiState();
  });

  test("allows quality checks without calling the provider when there are no suspicious reasons", async () => {
    const postWithRetryFn = vi.fn();

    const result = await checkEarningsQualityWithAi({
      companyName: "Example Corp",
      event: getEvent(),
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html,
      message: "message",
      metrics: [],
      reasons: [],
      surprise: null,
      ticker: "EXM",
    }, {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toEqual({
      confidence: 1,
      decision: "allow",
      issues: [],
      reason: "No suspicious earnings metrics detected.",
    });
    expect(postWithRetryFn).not.toHaveBeenCalled();
  });

  test("parses quality gate suppression with validated source snippets", async () => {
    const result = await checkEarningsQualityWithAi({
      companyName: "Example Corp",
      event: getEvent(),
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html,
      message: "message",
      metrics: [{
        key: "gaap_eps",
        label: "EPS",
        numericValue: 20.8,
        value: "$20.80",
      }],
      reasons: [{
        message: "EPS is suspicious.",
        metricKey: "gaap_eps",
        severity: "high",
      }],
      surprise: {
        consensusEps: 0.9,
      },
      ticker: "EXM",
    }, {
      logger,
      postWithRetryFn: vi.fn().mockResolvedValue({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  decision: "suppress",
                  confidence: 0.8,
                  reason: "The filing supports a parsing issue.",
                  issues: [{
                    severity: "high",
                    metricKey: null,
                    message: "EPS came from a bad table row.",
                    sourceSnippet: "Adjusted EPS | $1.25",
                  }],
                }),
              }],
            },
          }],
        },
      }),
      readSecretFn,
    });

    expect(result).toEqual({
      confidence: 0.8,
      decision: "suppress",
      issues: [{
        message: "EPS came from a bad table row.",
        severity: "high",
        sourceSnippet: "Adjusted EPS | $1.25",
      }],
      reason: "The filing supports a parsing issue.",
    });
  });

  test("rejects quality gate suppression without validated issues", async () => {
    const result = await checkEarningsQualityWithAi({
      companyName: "Example Corp",
      event: getEvent(),
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html,
      message: "message",
      metrics: [],
      reasons: [{
        message: "Revenue is suspicious.",
        metricKey: "revenue",
        severity: "high",
      }],
      surprise: null,
      ticker: "EXM",
    }, {
      logger,
      postWithRetryFn: vi.fn().mockResolvedValue({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  decision: "suppress",
                  confidence: 0.9,
                  reason: "No evidence.",
                  issues: [],
                }),
              }],
            },
          }],
        },
      }),
      readSecretFn,
    });

    expect(result).toBeNull();
  });

  test("identifies suspicious EPS, revenue, and net income values", () => {
    const event = getEvent({
      epsConsensus: "$0.90",
      marketCap: 10_000_000_000,
    });
    const reasons = getSuspiciousEarningsReasons([{
      key: "gaap_eps",
      label: "EPS",
      numericValue: 20.8,
      value: "$20.80",
    }, {
      key: "revenue",
      label: "Revenue",
      numericValue: 400_000,
      value: "$400K",
    }, {
      key: "net_income",
      label: "Net income",
      numericValue: 25_000_000_000,
      value: "$25B",
    }], {
      consensusEps: 0.9,
      consensusRevenue: 14_000_000_000,
    }, event);

    expect(reasons.map(reason => reason.metricKey)).toEqual([
      "gaap_eps",
      "revenue",
      "revenue",
      "revenue",
      "net_income",
    ]);
    expect(hasHighSeveritySuspicion(reasons)).toBe(true);
  });

  test("identifies revenue that is implausibly lower than net income", () => {
    const reasons = getSuspiciousEarningsReasons([{
      key: "revenue",
      label: "Revenue",
      numericValue: 2_000_000,
      value: "$2M",
    }, {
      key: "net_income",
      label: "Net income",
      numericValue: 274_100_000,
      value: "$274.1M",
    }], null, getEvent({
      marketCap: 9_000_000_000,
    }));

    expect(reasons).toEqual([{
      message: "Revenue $2M is lower than net income $274.1M.",
      metricKey: "revenue",
      severity: "medium",
    }]);
    expect(hasHighSeveritySuspicion(reasons)).toBe(false);
  });

  test("identifies negative revenue when net income is positive", () => {
    const reasons = getSuspiciousEarningsReasons([{
      key: "revenue",
      label: "Revenue",
      numericValue: -3_000_000,
      value: "-$3M",
    }, {
      key: "net_income",
      label: "Net income",
      numericValue: 13_000_000,
      value: "$13M",
    }], null, getEvent({
      marketCap: 9_000_000_000,
    }));

    expect(reasons).toEqual([{
      message: "Revenue -$3M is not positive while net income $13M is positive.",
      metricKey: "revenue",
      severity: "high",
    }]);
    expect(hasHighSeveritySuspicion(reasons)).toBe(true);
  });

  test("identifies zero revenue when net income is positive", () => {
    const reasons = getSuspiciousEarningsReasons([{
      key: "revenue",
      label: "Revenue",
      numericValue: 0,
      value: "$0",
    }, {
      key: "net_income",
      label: "Net income",
      numericValue: 193_480_000,
      value: "$193.48M",
    }], null, getEvent({
      marketCap: 9_000_000_000,
    }));

    expect(reasons).toEqual([{
      message: "Revenue $0 is not positive while net income $193.48M is positive.",
      metricKey: "revenue",
      severity: "high",
    }]);
    expect(hasHighSeveritySuspicion(reasons)).toBe(true);
  });

  test("identifies medium EPS and revenue suspicion without high severity", () => {
    const reasons = getSuspiciousEarningsReasons([{
      key: "gaap_eps",
      label: "EPS",
      numericValue: 10,
      value: "$10.00",
    }, {
      key: "revenue",
      label: "Revenue",
      numericValue: 100,
      value: "$100",
    }], {
      consensusRevenue: 1_000,
    }, getEvent({
      epsConsensus: "$1.00",
      marketCap: 1_000_000_000,
    }));

    expect(reasons).toEqual([{
      message: "EPS $10.00 is unusually far from consensus $1.00.",
      metricKey: "gaap_eps",
      severity: "medium",
    }, {
      message: "Revenue $100 is unusually far from consensus $1K.",
      metricKey: "revenue",
      severity: "medium",
    }]);
    expect(hasHighSeveritySuspicion(reasons)).toBe(false);
  });

  test("compares REIT consensus against AFFO per share instead of GAAP EPS", () => {
    const reasons = getSuspiciousEarningsReasons([{
      key: "affo_per_share",
      label: "AFFO/share",
      numericValue: 11.78,
      value: "$11.78",
    }, {
      key: "gaap_eps",
      label: "EPS",
      numericValue: 4.83,
      value: "$4.83",
    }], {
      consensusEps: 10.14,
    }, getEvent({
      epsConsensus: "$10.14",
    }));

    expect(reasons).toEqual([]);
  });

  test("identifies EPS that is implausibly low relative to consensus", () => {
    const reasons = getSuspiciousEarningsReasons([{
      key: "gaap_eps",
      label: "EPS",
      numericValue: 1,
      value: "$1.00",
    }], null, getEvent({
      epsConsensus: "$14.47",
    }));

    expect(reasons).toEqual([{
      message: "EPS $1.00 is unusually far from consensus $14.47.",
      metricKey: "gaap_eps",
      severity: "medium",
    }]);
  });

  test("flags a negative EPS reported alongside a positive net income", () => {
    const reasons = getSuspiciousEarningsReasons([{
      key: "gaap_eps",
      label: "EPS",
      numericValue: -7,
      value: "-$7.00",
    }, {
      key: "net_income",
      label: "Net income",
      numericValue: 624_000_000,
      value: "$624M",
    }], null, getEvent({
      epsConsensus: "$0.44",
    }));

    expect(reasons).toEqual([{
      message: "EPS -$7.00 is negative while net income $624M is positive.",
      metricKey: "gaap_eps",
      severity: "medium",
    }]);
    expect(hasHighSeveritySuspicion(reasons)).toBe(false);
  });

  test("flags a positive EPS reported alongside a negative net income", () => {
    const reasons = getSuspiciousEarningsReasons([{
      key: "adjusted_eps",
      label: "Adj EPS",
      numericValue: 2.1,
      value: "$2.10",
    }, {
      key: "net_income",
      label: "Net income",
      numericValue: -310_000_000,
      value: "-$310M",
    }], null, getEvent());

    expect(reasons).toEqual([{
      message: "Adj EPS $2.10 is positive while net income -$310M is negative.",
      metricKey: "adjusted_eps",
      severity: "medium",
    }]);
    expect(hasHighSeveritySuspicion(reasons)).toBe(false);
  });

  test("does not flag a negative EPS that agrees with a negative net income", () => {
    const reasons = getSuspiciousEarningsReasons([{
      key: "gaap_eps",
      label: "EPS",
      numericValue: -0.5,
      value: "-$0.50",
    }, {
      key: "net_income",
      label: "Net income",
      numericValue: -120_000_000,
      value: "-$120M",
    }], null, getEvent());

    expect(reasons).toEqual([]);
    expect(hasHighSeveritySuspicion(reasons)).toBe(false);
  });
});

function getEvent(overrides: Partial<ReturnType<typeof getEventBase>> = {}) {
  return {
    ...getEventBase(),
    ...overrides,
  };
}

function getEventBase() {
  return {
    ticker: "EXM",
    when: "before_open" as const,
    date: "2026-05-01",
    importance: 1,
    companyName: "Example Corp",
    marketCap: 20_000_000_000,
    marketCapText: "$20B",
    epsConsensus: "$1.00",
  };
}
