import {readFileSync} from "node:fs";
import {beforeEach, describe, expect, test, vi} from "vitest";
import {clearAiProviderState} from "./ai-provider.ts";
import {checkEarningsQualityWithAi} from "./earnings-results-ai.ts";
import {parseEarningsDocument} from "./earnings-results-format.ts";
import {summarizeEarningsWithAi} from "./earnings-results-summary.ts";
import {readEarningsFilingFixture} from "./test-utils/earnings-filing-fixtures.ts";

type RecordedFixture = {id: string; ticker: string; response: unknown};
const fixtures = JSON.parse(readFileSync(new URL("./test-fixtures/ai-document-regressions.json", import.meta.url), "utf8")) as RecordedFixture[];
const readSecretFn = (name: string) => ({ai_provider: "openai", openai_api_key: "test-key"})[name] ?? "";
const logger = {log: vi.fn()};
const openAiResponse = (value: unknown) => ({data: {
  status: "completed",
  output: [{type: "reasoning", content: []}, {type: "message", content: [{type: "output_text", text: JSON.stringify(value)}]}],
}});

describe("recorded document-model regressions", () => {
  beforeEach(() => clearAiProviderState());

  test.each(fixtures.filter(fixture => fixture.id.startsWith("summary-")))("omits unusable recorded summary fallback: $id", async fixture => {
    const html = readEarningsFilingFixture(fixture.ticker);
    const postWithRetryFn = vi.fn().mockResolvedValue(openAiResponse(fixture.response));
    const result = await summarizeEarningsWithAi({
      companyName: fixture.ticker, ticker: fixture.ticker.toUpperCase(), filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example", html, metrics: parseEarningsDocument(html).metrics,
    }, {logger, readSecretFn, postWithRetryFn});
    expect(result).toBeNull();
    expect(postWithRetryFn.mock.calls[0]?.[1]).toMatchObject({model: "gpt-6-luna", reasoning: {effort: "medium"}});
    expect(postWithRetryFn.mock.calls[0]?.[3].timeoutMs).toBe(30_000);
  });

  test.each(fixtures.filter(fixture => fixture.id.startsWith("quality-")))("rejects a recorded approval with unresolved substantive issues: $id", async fixture => {
    const html = readEarningsFilingFixture(fixture.ticker);
    const result = await checkEarningsQualityWithAi({
      companyName: fixture.ticker, ticker: fixture.ticker.toUpperCase(), filingForm: "8-K", filingUrl: "https://www.sec.gov/example", html,
      event: {ticker: fixture.ticker, when: "before_open", date: "2026-10-07", importance: 1},
      message: "Pending corrupted post", metrics: parseEarningsDocument(html).metrics, surprise: null,
      reasons: [{severity: "high", message: "Verify the reported metric sign and scale."}],
    }, {logger, readSecretFn, postWithRetryFn: vi.fn().mockResolvedValue(openAiResponse(fixture.response))});
    expect(result).toBeNull();
  });

  test.each([
    "•Revenue guidance increased to $12 million.",
    "Reports Second Quarter Fiscal 2027 Financial Results Q2 Net Sales Increased to $12 million.",
    "For the third quarter of 2027, the Company expects:",
  ])("retains useful prose without the fragment %s", async fragment => {
    const sentences = ["Revenue reached $10 million.", "Operating margin expanded to 24%.", fragment];
    const result = await summarizeEarningsWithAi({
      companyName: "Example Corp", ticker: "EXM", filingForm: "8-K", filingUrl: "https://www.sec.gov/example",
      html: sentences.map(text => `<p>${text}</p>`).join("\n"),
    }, {logger, readSecretFn, postWithRetryFn: vi.fn().mockResolvedValue(openAiResponse({
      sentences: sentences.map(text => ({text, sourceSnippet: text})),
    }))});
    expect(result).toBe("Revenue reached `$10 million`. Operating margin expanded to `24%`.");
  });

  test.each(["low", "medium", "high", "invalid-source"])("allows only fully grounded low-severity verification notes: %s", async severity => {
    const snippet = "Revenue reached $10 million in the reported quarter.";
    const issues = [{severity: "low", metricKey: "revenue", message: "Verified quarterly revenue.", sourceSnippet: snippet}, {
      severity: "invalid-source" === severity ? "high" : severity, metricKey: "revenue", message: "Additional verification note.",
      sourceSnippet: "invalid-source" === severity ? "This quotation is not in the filing." : snippet,
    }];
    const result = await checkEarningsQualityWithAi({
      companyName: "Example Corp", ticker: "EXM", filingForm: "8-K", filingUrl: "https://www.sec.gov/example", html: `<p>${snippet}</p>`,
      event: {ticker: "EXM", when: "before_open", date: "2026-10-07", importance: 1},
      message: "Revenue: $10M", metrics: [], surprise: null, reasons: [{severity: "high", message: "Verify revenue."}],
    }, {logger, readSecretFn, postWithRetryFn: vi.fn().mockResolvedValue(openAiResponse({decision: "allow", confidence: 0.99, reason: "Review complete.", issues}))});
    expect(result?.decision ?? null).toBe("low" === severity ? "allow" : null);
  });

  test("does not approve flagged revenue using only an unrelated EPS verification note", async () => {
    const snippet = "Adjusted EPS was $1.25 in the reported quarter.";
    const result = await checkEarningsQualityWithAi({
      companyName: "Example Corp", ticker: "EXM", filingForm: "8-K", filingUrl: "https://www.sec.gov/example", html: `<p>${snippet}</p>`,
      event: {ticker: "EXM", when: "before_open", date: "2026-10-07", importance: 1},
      message: "Revenue: $10T", metrics: [], surprise: null, reasons: [{severity: "high", metricKey: "revenue", message: "Verify revenue."}],
    }, {logger, readSecretFn, postWithRetryFn: vi.fn().mockResolvedValue(openAiResponse({
      decision: "allow", confidence: 0.99, reason: "EPS matches.",
      issues: [{severity: "low", metricKey: "adjusted_eps", message: "Verified EPS.", sourceSnippet: snippet}],
    }))});
    expect(result).toBeNull();
  });
});
