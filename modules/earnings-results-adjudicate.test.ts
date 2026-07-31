import {beforeEach, describe, expect, test, vi} from "vitest";
import {clearAiProviderState} from "./ai-provider.ts";
import {adjudicateEarningsCandidatesWithAi} from "./earnings-results-adjudicate.ts";
import type {
  EarningsMetricCandidate,
  EarningsMetricConflict,
} from "./earnings-results-reconcile.ts";

describe("earnings candidate adjudication", () => {
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
        <p>Revenue was $40 million.</p>
      </body>
    </html>
  `;

  beforeEach(() => {
    vi.clearAllMocks();
    clearAiProviderState();
  });

  test("selects only a supplied candidate ID", async () => {
    const candidates = getConflictingRevenueCandidates();
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                selections: [{
                  candidateId: "html:revenue:0",
                  key: "revenue",
                }],
              }),
            }],
          },
        }],
      },
    });

    const result = await adjudicateEarningsCandidatesWithAi({
      candidates,
      companyName: "Example Corp",
      conflicts: getRevenueConflicts(candidates),
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

    expect(result).toEqual(new Map([["revenue", "html:revenue:0"]]));
    const requestBody = postWithRetryFn.mock.calls[0]?.[1] as {
      generationConfig?: {
        responseJsonSchema?: {
          properties?: {
            selections?: {
              items?: {
                properties?: {
                  candidateId?: {
                    enum?: string[];
                  };
                };
              };
            };
          };
        };
      };
    };
    expect(
      requestBody.generationConfig?.responseJsonSchema?.properties?.selections
        ?.items?.properties?.candidateId?.enum,
    ).toEqual(["xbrl:revenue:0", "html:revenue:0"]);
  });

  test("rejects invented candidate IDs", async () => {
    const candidates = getConflictingRevenueCandidates();
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                selections: [{
                  candidateId: "ai:invented:0",
                  key: "revenue",
                }],
              }),
            }],
          },
        }],
      },
    });

    const result = await adjudicateEarningsCandidatesWithAi({
      candidates,
      companyName: "Example Corp",
      conflicts: getRevenueConflicts(candidates),
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

    expect(result).toEqual(new Map());
  });

  test("does not call AI without conflicts or filing evidence", async () => {
    const candidates = getConflictingRevenueCandidates();
    const postWithRetryFn = vi.fn();
    const dependencies = {
      logger,
      postWithRetryFn,
      readSecretFn,
    };

    expect(await adjudicateEarningsCandidatesWithAi({
      candidates,
      companyName: "Example Corp",
      conflicts: [],
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html,
      ticker: "EXM",
    }, dependencies)).toEqual(new Map());
    expect(await adjudicateEarningsCandidatesWithAi({
      candidates,
      companyName: "Example Corp",
      conflicts: getRevenueConflicts(candidates),
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: "",
      ticker: "EXM",
    }, dependencies)).toEqual(new Map());
    expect(postWithRetryFn).not.toHaveBeenCalled();
  });
});

function getConflictingRevenueCandidates(): EarningsMetricCandidate[] {
  return [{
    basis: "gaap",
    concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
    id: "xbrl:revenue:0",
    metric: {
      currencyCode: "USD",
      key: "revenue",
      label: "Revenue",
      numericValue: 42_000_000,
      value: "$42M",
    },
    period: {
      durationDays: 91,
      end: "2026-03-31",
      fiscalPeriod: "Q1",
      fiscalYear: "2026",
      label: "Q1 2026",
      start: "2026-01-01",
    },
    source: "xbrl",
  }, {
    basis: "gaap",
    evidence: "Revenue was $40 million.",
    id: "html:revenue:0",
    metric: {
      currencyCode: "USD",
      key: "revenue",
      label: "Revenue",
      numericValue: 40_000_000,
      value: "$40M",
    },
    period: {
      label: "Q1 2026",
    },
    source: "html",
  }];
}

function getRevenueConflicts(candidates: EarningsMetricCandidate[]): EarningsMetricConflict[] {
  return [{
    candidateIds: candidates.map(candidate => candidate.id),
    key: "revenue",
    reason: "conflicting_values",
  }];
}
