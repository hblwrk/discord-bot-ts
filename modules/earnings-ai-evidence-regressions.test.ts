import {readFileSync} from "node:fs";
import {beforeEach, describe, expect, test, vi} from "vitest";
import {clearAiProviderState} from "./ai-provider.ts";
import {checkEarningsQualityWithAi} from "./earnings-results-ai.ts";
import {adjudicateEarningsCandidatesWithAi} from "./earnings-results-adjudicate.ts";
import {parseEarningsDocument} from "./earnings-results-format.ts";
import {readEarningsFilingFixture} from "./test-utils/earnings-filing-fixtures.ts";

type RecordedApproval = {id: string; ticker: string; target: string; testedValue: string; response: unknown};
const fixtures = JSON.parse(readFileSync(new URL("./test-fixtures/ai-evidence-regressions.json", import.meta.url), "utf8")) as RecordedApproval[];
const logger = {log: vi.fn()};
const readSecretFn = (name: string) => ({ai_provider: "openai", openai_api_key: "test-key"})[name] ?? "";
const response = (value: unknown) => ({data: {status: "completed", output_text: JSON.stringify(value)}});

beforeEach(() => clearAiProviderState());

describe("full AI corpus evidence regressions", () => {
  test.each(fixtures)("blocks the recorded wrong sign/scale approval $id", async fixture => {
    const html = readEarningsFilingFixture(fixture.ticker);
    const metrics = parseEarningsDocument(html).metrics.map(metric => metric.key === fixture.target ? {
      ...metric, value: fixture.testedValue,
      numericValue: fixture.id.includes("-sign:") ? -(metric.numericValue ?? 0) : (metric.numericValue ?? 0) * 1_000,
    } : metric);
    const result = await checkEarningsQualityWithAi({
      companyName: fixture.ticker, ticker: fixture.ticker.toUpperCase(), filingForm: "8-K", filingUrl: "https://www.sec.gov/example", html,
      metrics, message: metrics.map(metric => `${metric.label}: ${metric.value}`).join("\n"), surprise: null,
      event: {ticker: fixture.ticker, when: "before_open", date: "2026-10-07", importance: 1},
      reasons: [{severity: "high", metricKey: fixture.target, message: "Verify the flagged sign and scale."}],
    }, {logger, readSecretFn, postWithRetryFn: vi.fn().mockResolvedValue(response(fixture.response))});
    expect(result).toBeNull();
  });

  test.each([false, true])("validates the chosen candidate value independently of its ID (corrupt=%s)", async corrupt => {
    const sourceSnippet = "GAAP diluted EPS was $(0.28) in the reported quarter.";
    const candidates = [-0.28, 0.28].map((value, index) => ({
      id: `html:gaap_eps:${index}`, source: "html" as const, basis: "gaap" as const,
      period: {label: "Q2 2026"}, metric: {key: "gaap_eps", label: "EPS", value: String(value), numericValue: value, currencyCode: "USD"},
    }));
    const result = await adjudicateEarningsCandidatesWithAi({
      companyName: "Example Corp", ticker: "EXM", filingForm: "8-K", filingUrl: "https://www.sec.gov/example", html: sourceSnippet,
      candidates, conflicts: [{key: "gaap_eps", reason: "conflicting_values", candidateIds: candidates.map(candidate => candidate.id)}],
    }, {logger, readSecretFn, postWithRetryFn: vi.fn().mockResolvedValue(response({selections: [{
      key: "gaap_eps", candidateId: candidates[corrupt ? 1 : 0]?.id, sourceSnippet,
    }]}))});
    expect([...result]).toEqual(corrupt ? [] : [["gaap_eps", "html:gaap_eps:0"]]);
  });

  test("omits an existing candidate selected without filing evidence", async () => {
    const candidate = {id: "html:revenue:0", source: "html" as const, basis: "gaap" as const, period: {label: "Q2 2026"},
      metric: {key: "revenue", label: "Revenue", value: "$40M", numericValue: 40_000_000, currencyCode: "USD"}};
    const result = await adjudicateEarningsCandidatesWithAi({
      companyName: "Example Corp", ticker: "EXM", filingForm: "8-K", filingUrl: "https://www.sec.gov/example", html: "Revenue was $40 million.",
      candidates: [candidate], conflicts: [{key: "revenue", reason: "conflicting_values", candidateIds: [candidate.id]}],
    }, {logger, readSecretFn, postWithRetryFn: vi.fn().mockResolvedValue(response({selections: [{key: "revenue", candidateId: candidate.id}]}))});
    expect(result.size).toBe(0);
  });
});
