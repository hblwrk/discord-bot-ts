import {describe, expect, test} from "vitest";
import {
  createAiMetricCandidates,
  createHtmlMetricCandidates,
  getProviderMatchedEpsMetric,
  isProviderMatchedRevenueMetric,
  reconcileEarningsMetricCandidates,
  type EarningsMetricCandidate,
} from "./earnings-results-reconcile.ts";

describe("earnings metric reconciliation", () => {
  test("prefers a quarterly XBRL fact when filing evidence agrees", () => {
    const htmlCandidates = createHtmlMetricCandidates([{
      currencyCode: "USD",
      key: "revenue",
      label: "Revenue",
      numericValue: 200_600_000_000,
      sourceSnippet: "Net sales increased to $200.6 billion in the second quarter.",
      value: "$200.6B",
    }], "Q2 2026");
    const xbrlCandidate = getXbrlCandidate({
      numericValue: 200_606_000_000,
      value: "$200.61B",
    });

    const resolution = reconcileEarningsMetricCandidates([
      xbrlCandidate,
      ...htmlCandidates,
    ]);

    expect(resolution.conflicts).toEqual([]);
    expect(resolution.metrics).toEqual([xbrlCandidate.metric]);
    expect(resolution.selectedCandidateIds).toEqual(["xbrl:revenue:0"]);
  });

  test("does not publish a metric when verified sources disagree", () => {
    const htmlCandidates = createHtmlMetricCandidates([{
      currencyCode: "USD",
      key: "revenue",
      label: "Revenue",
      numericValue: 169_000_000_000,
      sourceSnippet: "AWS reached a $169 billion annualized revenue run rate.",
      value: "$169B",
    }], "Q2 2026");
    const xbrlCandidate = getXbrlCandidate({
      numericValue: 200_606_000_000,
      value: "$200.61B",
    });

    const resolution = reconcileEarningsMetricCandidates([
      xbrlCandidate,
      ...htmlCandidates,
    ]);

    expect(resolution.metrics).toEqual([]);
    expect(resolution.conflicts).toEqual([{
      candidateIds: ["xbrl:revenue:0", "html:revenue:0"],
      key: "revenue",
      reason: "conflicting_values",
    }]);
  });

  test("does not merge agreeing values from different reporting periods", () => {
    const htmlCandidates = createHtmlMetricCandidates([{
      currencyCode: "USD",
      key: "revenue",
      label: "Revenue",
      numericValue: 200_600_000_000,
      sourceSnippet: "Net sales increased to $200.6 billion in the second quarter.",
      value: "$200.6B",
    }], "Q2 2026");
    const xbrlCandidate = {
      ...getXbrlCandidate({
        numericValue: 200_600_000_000,
        value: "$200.6B",
      }),
      period: {
        durationDays: 91,
        end: "2026-03-31",
        label: "Q1 2026",
        start: "2026-01-01",
      },
    };

    const resolution = reconcileEarningsMetricCandidates([
      xbrlCandidate,
      ...htmlCandidates,
    ]);

    expect(resolution.metrics).toEqual([]);
    expect(resolution.conflicts).toEqual([{
      candidateIds: ["xbrl:revenue:0", "html:revenue:0"],
      key: "revenue",
      reason: "period_mismatch",
    }]);
  });

  test("accepts an AI selection only when it references a verified existing candidate", () => {
    const htmlCandidates = createHtmlMetricCandidates([{
      currencyCode: "USD",
      key: "gaap_eps",
      label: "EPS",
      numericValue: 5.75,
      sourceSnippet: "Net income was $62.6 billion, or $5.75 per diluted share.",
      value: "$5.75",
    }], "Q2 2026");
    const xbrlCandidate: EarningsMetricCandidate = {
      basis: "gaap",
      concept: "us-gaap:EarningsPerShareDiluted",
      id: "xbrl:gaap_eps:0",
      metric: {
        currencyCode: "USD",
        key: "gaap_eps",
        label: "EPS",
        numericValue: 8.53,
        value: "$8.53",
      },
      period: {
        durationDays: 91,
        end: "2026-06-30",
        start: "2026-04-01",
      },
      source: "xbrl",
    };

    const candidates = [xbrlCandidate, ...htmlCandidates];
    const resolution = reconcileEarningsMetricCandidates(
      candidates,
      new Map([["gaap_eps", "html:gaap_eps:0"]]),
    );

    expect(resolution.conflicts).toEqual([]);
    expect(resolution.metrics).toEqual([htmlCandidates[0]?.metric]);

    const inventedSelection = reconcileEarningsMetricCandidates(
      candidates,
      new Map([["gaap_eps", "invented:gaap_eps:0"]]),
    );
    expect(inventedSelection.metrics).toEqual([]);
    expect(inventedSelection.conflicts).toHaveLength(1);
  });

  test("does not publish AI-only or periodless HTML candidates", () => {
    const aiCandidates = createAiMetricCandidates([{
      currencyCode: "USD",
      key: "revenue",
      label: "Revenue",
      numericValue: 42_000_000,
      sourceSnippet: "Revenue was $42 million.",
      value: "$42M",
    }], "Q1 2026");
    const periodlessHtml = createHtmlMetricCandidates([{
      currencyCode: "USD",
      key: "net_income",
      label: "Net income",
      numericValue: 10_000_000,
      sourceSnippet: "Net income was $10 million.",
      value: "$10M",
    }], undefined);

    const resolution = reconcileEarningsMetricCandidates([
      ...aiCandidates,
      ...periodlessHtml,
    ]);

    expect(resolution.metrics).toEqual([]);
    expect(resolution.conflicts).toEqual([
      {
        candidateIds: ["ai:revenue:0"],
        key: "revenue",
        reason: "unverified_source",
      },
      {
        candidateIds: ["html:net_income:0"],
        key: "net_income",
        reason: "unverified_source",
      },
    ]);
  });

  test("matches estimates only through the provider's paired actual", () => {
    const metrics = [{
      currencyCode: "USD",
      key: "affo_per_share",
      label: "AFFO/share",
      numericValue: 11.78,
      value: "$11.78",
    }, {
      currencyCode: "USD",
      key: "gaap_eps",
      label: "EPS",
      numericValue: 4.83,
      value: "$4.83",
    }];

    expect(getProviderMatchedEpsMetric(metrics, {
      actualEps: 11.78,
      consensusEps: 10.14,
    })?.key).toBe("affo_per_share");
    expect(getProviderMatchedEpsMetric(metrics, {
      actualEps: 7,
      consensusEps: 10.14,
    })).toBeUndefined();
    expect(isProviderMatchedRevenueMetric({
      currencyCode: "USD",
      key: "revenue",
      label: "Revenue",
      numericValue: 200_606_000_000,
      value: "$200.61B",
    }, {
      actualRevenue: 200_600_000_000,
    })).toBe(true);
  });
});

function getXbrlCandidate({
  numericValue,
  value,
}: {
  numericValue: number;
  value: string;
}): EarningsMetricCandidate {
  return {
    basis: "gaap",
    concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
    id: "xbrl:revenue:0",
    metric: {
      currencyCode: "USD",
      key: "revenue",
      label: "Revenue",
      numericValue,
      value,
    },
    period: {
      durationDays: 91,
      end: "2026-06-30",
      start: "2026-04-01",
    },
    source: "xbrl",
  };
}
