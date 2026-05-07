import {beforeEach, describe, expect, test, vi} from "vitest";
import {
  checkEarningsQualityWithAi,
  clearEarningsAiState,
  extractEarningsWithAi,
  getSuspiciousEarningsReasons,
  hasHighSeveritySuspicion,
  mergeAiMetrics,
} from "./earnings-results-ai.ts";
import type {EarningsResultMetric} from "./earnings-results-format.ts";

describe("AI earnings helpers", () => {
  const logger = {
    log: vi.fn(),
  };
  const readSecretFn = vi.fn((secretName: string) => {
    if ("gemini_api_key" === secretName) {
      return "gemini-key";
    }

    if ("gemini_calls_per_minute" === secretName) {
      return "1";
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

  test("extracts schema-constrained metrics with verified source snippets", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                quarterLabel: "Q1 2026",
                metrics: [{
                  key: "revenue",
                  numericValue: 42_000_000,
                  currencyCode: "USD",
                  sourceSnippet: "Revenue | 42.0",
                }],
                issues: [],
              }),
            }],
          },
        }],
      },
    });

    const result = await extractEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result?.quarterLabel).toBe("Q1 2026");
    expect(result?.metrics).toEqual([{
      currencyCode: "USD",
      key: "revenue",
      label: "Revenue",
      numericValue: 42_000_000,
      sourceSnippet: "Revenue | 42.0",
      value: "$42M",
    }]);
    expect(postWithRetryFn).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
      expect.objectContaining({
        generationConfig: expect.objectContaining({
          responseMimeType: "application/json",
          responseJsonSchema: expect.any(Object),
          temperature: 0,
        }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-goog-api-key": "gemini-key",
        }),
      }),
      expect.any(Object),
    );
  });

  test("uses default provider model and rate limit when optional provider secrets are missing", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                quarterLabel: null,
                metrics: [],
                issues: [],
              }),
            }],
          },
        }],
      },
    });

    await extractEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn: vi.fn((secretName: string) => {
        if ("gemini_api_key" === secretName) {
          return "gemini-key";
        }

        throw new Error(`missing ${secretName}`);
      }),
    });

    expect(postWithRetryFn).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  test("sends the provider a bounded SEC release excerpt instead of the whole filing", async () => {
    const longReleaseHtml = [
      "<html><body>",
      "<h1>Example Corp reports first quarter 2026 results</h1>",
      "<p>Amounts in millions of dollars, except per share amounts.</p>",
      ...Array.from({length: 400}, (_value, index) =>
        `<p>Revenue commentary ${index} ${"continued quarterly results discussion ".repeat(3)}</p>`,
      ),
      "<p>UNIQUE_TAIL_MARKER Revenue should not be included after truncation.</p>",
      "</body></html>",
    ].join("\n");
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                quarterLabel: null,
                metrics: [],
                issues: [],
              }),
            }],
          },
        }],
      },
    });

    await extractEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: longReleaseHtml,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    const requestBody = postWithRetryFn.mock.calls[0]?.[1] as {contents?: {parts?: {text?: string}[]}[]};
    const prompt = requestBody.contents?.[0]?.parts?.find(part => "string" === typeof part.text)?.text ?? "";
    const filingText = prompt.split("Filing text:\n")[1] ?? "";
    expect(filingText.length).toBeLessThanOrEqual(10_020);
    expect(filingText).toContain("Example Corp reports first quarter 2026 results");
    expect(filingText).toContain("[truncated]");
    expect(filingText).not.toContain("UNIQUE_TAIL_MARKER");
  });

  test("bounds single-line SEC release excerpts before calling the provider", async () => {
    const longSingleLineHtml = `<html><body>${"Revenue discussion ".repeat(900)}</body></html>`;
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                quarterLabel: null,
                metrics: [],
                issues: [],
              }),
            }],
          },
        }],
      },
    });

    await extractEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: longSingleLineHtml,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    const requestBody = postWithRetryFn.mock.calls[0]?.[1] as {contents?: {parts?: {text?: string}[]}[]};
    const prompt = requestBody.contents?.[0]?.parts?.find(part => "string" === typeof part.text)?.text ?? "";
    const filingText = prompt.split("Filing text:\n")[1] ?? "";
    expect(filingText.length).toBeLessThanOrEqual(10_020);
    expect(filingText).toContain("[truncated]");
  });

  test("does not call the provider when SEC release text is empty", async () => {
    const postWithRetryFn = vi.fn();

    const result = await extractEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: " \n\t ",
      ticker: "EXM",
    }, {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBeNull();
    expect(postWithRetryFn).not.toHaveBeenCalled();
  });

  test("drops AI metrics when their source snippets are not present", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                quarterLabel: null,
                metrics: [{
                  key: "revenue",
                  numericValue: 42_000_000,
                  currencyCode: "USD",
                  sourceSnippet: "Revenue was 42 million",
                }],
                issues: [],
              }),
            }],
          },
        }],
      },
    });

    const result = await extractEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result?.metrics).toEqual([]);
  });

  test("drops AI revenue metrics contradicted by evidence or extraction issues", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                quarterLabel: "Q1 2026",
                metrics: [{
                  key: "revenue",
                  numericValue: 17_741_000_000,
                  currencyCode: "USD",
                  sourceSnippet: "17,741 | 12,799 | 15,250 | Adjusted EBITDA",
                }, {
                  key: "revenue",
                  numericValue: 0,
                  currencyCode: "USD",
                  sourceSnippet: "No explicit consolidated revenue figure was provided in the supplied filing text.",
                }, {
                  key: "net_income",
                  numericValue: 5_694_000_000,
                  currencyCode: "USD",
                  sourceSnippet: "5,694 | 4,134 | 4,780 | Income attributable to Shell plc shareholders",
                }],
                issues: [
                  "No explicit consolidated revenue figure was provided in the supplied filing text; the available summary shows income, adjusted earnings, EBITDA, cash flow, and EPS, but not revenue.",
                ],
              }),
            }],
          },
        }],
      },
    });

    const result = await extractEarningsWithAi({
      companyName: "Shell",
      filingForm: "6-K",
      filingUrl: "https://www.sec.gov/example",
      html: `
        <p>17,741 | 12,799 | 15,250 | Adjusted EBITDA</p>
        <p>No explicit consolidated revenue figure was provided in the supplied filing text.</p>
        <p>5,694 | 4,134 | 4,780 | Income attributable to Shell plc shareholders</p>
      `,
      ticker: "SHEL",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result?.metrics).toEqual([expect.objectContaining({
      key: "net_income",
      value: "$5.69B",
    })]);
  });

  test("caps AI calls with the local per-minute limiter", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                quarterLabel: null,
                metrics: [],
                issues: [],
              }),
            }],
          },
        }],
      },
    });

    const input = {
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html,
      ticker: "EXM",
    };

    await extractEarningsWithAi(input, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });
    const secondResult = await extractEarningsWithAi(input, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(secondResult).toBeNull();
    expect(postWithRetryFn).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("earnings extraction for EXM: local 1/minute rate limit is exhausted."),
    );
  });

  test("releases local AI call capacity after one minute", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                quarterLabel: null,
                metrics: [],
                issues: [],
              }),
            }],
          },
        }],
      },
    });
    const input = {
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html,
      ticker: "EXM",
    };

    await extractEarningsWithAi(input, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });
    await extractEarningsWithAi(input, {
      logger,
      nowMs: () => 62_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(postWithRetryFn).toHaveBeenCalledTimes(2);
  });

  test("stays disabled when the active provider API key secret is missing", async () => {
    const postWithRetryFn = vi.fn();

    const result = await extractEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html,
      ticker: "EXM",
    }, {
      logger,
      postWithRetryFn,
      readSecretFn: vi.fn(() => {
        throw new Error("missing secret");
      }),
    });

    expect(result).toBeNull();
    expect(postWithRetryFn).not.toHaveBeenCalled();
  });

  test("returns null when AI extraction output is invalid JSON", async () => {
    const result = await extractEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html,
      ticker: "EXM",
    }, {
      logger,
      postWithRetryFn: vi.fn().mockResolvedValue({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: "{not-json",
              }],
            },
          }],
        },
      }),
      readSecretFn,
    });

    expect(result).toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI earnings extraction returned invalid JSON for EXM.",
    );
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

  test("merges AI metrics only for missing or suspicious deterministic metrics", () => {
    const deterministicMetrics: EarningsResultMetric[] = [{
      key: "gaap_eps",
      label: "EPS",
      numericValue: 20.8,
      value: "$20.80",
    }, {
      key: "revenue",
      label: "Revenue",
      numericValue: 267_000_000,
      value: "$267M",
    }];
    const aiMetrics: EarningsResultMetric[] = [{
      key: "gaap_eps",
      label: "EPS",
      numericValue: 1.3,
      value: "$1.30",
    }, {
      key: "revenue",
      label: "Revenue",
      numericValue: 14_550_000_000,
      value: "$14.55B",
    }, {
      key: "net_income",
      label: "Net income",
      numericValue: 2_000_000_000,
      value: "$2B",
    }];

    expect(mergeAiMetrics(deterministicMetrics, aiMetrics, [{
      message: "EPS is suspicious.",
      metricKey: "gaap_eps",
      severity: "high",
    }])).toEqual([{
      key: "gaap_eps",
      label: "EPS",
      numericValue: 1.3,
      value: "$1.30",
    }, {
      key: "revenue",
      label: "Revenue",
      numericValue: 267_000_000,
      value: "$267M",
    }, {
      key: "net_income",
      label: "Net income",
      numericValue: 2_000_000_000,
      value: "$2B",
    }]);
    expect(mergeAiMetrics(deterministicMetrics, [], [])).toBe(deterministicMetrics);
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
      severity: "high",
    }]);
    expect(hasHighSeveritySuspicion(reasons)).toBe(true);
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
