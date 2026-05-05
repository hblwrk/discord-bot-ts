import {beforeEach, describe, expect, test, vi} from "vitest";
import {summarizeEarningsWithAi} from "./earnings-results-summary.ts";

describe("AI earnings summaries", () => {
  const logger = {
    log: vi.fn(),
  };
  const readSecretFn = vi.fn((secretName: string) => {
    if ("gemini_api_key" === secretName) {
      return "gemini-key";
    }

    throw new Error(`missing ${secretName}`);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("summarizes a bounded opening excerpt plus later guidance context", async () => {
    const html = [
      "<html><body>",
      "<h1>Example Corp reports first quarter 2026 results</h1>",
      "<p>Revenue increased 12% to $10.2 billion and adjusted EPS was $1.42.</p>",
      ...Array.from({length: 260}, (_value, index) =>
        `<p>Operating commentary ${index} ${"segment demand remained resilient ".repeat(3)}</p>`,
      ),
      "<h2>Financial Outlook</h2>",
      "<p>Example Corp expects fiscal 2026 revenue of $42 billion to $44 billion.</p>",
      "<p>Management expects adjusted EPS of $5.80 to $6.10.</p>",
      ...Array.from({length: 20}, (_value, index) => `<p>Appendix note ${index}</p>`),
      "<p>UNIQUE_TAIL_MARKER should stay outside the summary prompt.</p>",
      "</body></html>",
    ].join("\n");
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "Example Corp reported first-quarter revenue of $10.2 billion and adjusted EPS of $1.42. Segment demand remained resilient during the period. Management guided fiscal 2026 revenue to $42 billion to $44 billion and adjusted EPS to $5.80 to $6.10.",
              }),
            }],
          },
        }],
      },
    });

    const result = await summarizeEarningsWithAi({
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

    expect(result).toBe(
      "Example Corp reported first-quarter revenue of `$10.2 billion` and adjusted EPS of `$1.42`. Segment demand remained resilient during the period. Management guided fiscal 2026 revenue to `$42 billion` to `$44 billion` and adjusted EPS to `$5.80` to `$6.10`.",
    );
    const requestBody = postWithRetryFn.mock.calls[0]?.[1] as {contents?: {parts?: {text?: string}[]}[]};
    const prompt = requestBody.contents?.[0]?.parts?.find(part => "string" === typeof part.text)?.text ?? "";
    const filingText = prompt.split("Filing text:\n")[1] ?? "";
    expect(prompt).toContain("Write exactly three concise plain-text sentences.");
    expect(filingText.length).toBeLessThanOrEqual(20_100);
    expect(filingText).toContain("Opening excerpt:");
    expect(filingText).toContain("Example Corp reports first quarter 2026 results");
    expect(filingText).toContain("Guidance/outlook excerpt:");
    expect(filingText).toContain("Example Corp expects fiscal 2026 revenue of $42 billion to $44 billion.");
    expect(filingText).not.toContain("UNIQUE_TAIL_MARKER");
  });

  test("formats returned ticker symbols and metrics as inline code", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "EXM revenue rose 12% to $10.2 billion while operating margin expanded 180 basis points to 24.3%. EXM guided adjusted EPS to $5.80 to $6.10. Revenue momentum remained broad.",
              }),
            }],
          },
        }],
      },
    });

    const result = await summarizeEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: "<html><body><h1>Example Corp reports first quarter 2026 results</h1></body></html>",
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe(
      "`EXM` revenue rose `12%` to `$10.2 billion` while operating margin expanded `180 basis points` to `24.3%`. `EXM` guided adjusted EPS to `$5.80` to `$6.10`. Revenue momentum remained broad.",
    );
  });

  test("normalizes summary whitespace", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "  Example Corp grew revenue.\\n\\nMargins improved.   Guidance increased.  ",
              }),
            }],
          },
        }],
      },
    });

    const result = await summarizeEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: "<html><body><h1>Example Corp reports first quarter 2026 results</h1></body></html>",
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe("Example Corp grew revenue. Margins improved. Guidance increased.");
  });

  test("returns null when the provider is unavailable", async () => {
    const postWithRetryFn = vi.fn();

    const result = await summarizeEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: "<html><body><h1>Example Corp reports first quarter 2026 results</h1></body></html>",
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

  test("logs invalid summary JSON", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: "not-json",
            }],
          },
        }],
      },
    });

    const result = await summarizeEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: "<html><body><h1>Example Corp reports first quarter 2026 results</h1></body></html>",
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI earnings summary returned invalid JSON for EXM.",
    );
  });
});
