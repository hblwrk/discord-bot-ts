import {beforeEach, describe, expect, test, vi} from "vitest";
import {clearAiProviderState} from "./ai-provider.ts";
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
    clearAiProviderState();
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
                sentences: [
                  {
                    text: "Example Corp reported first-quarter revenue of $10.2 billion and adjusted EPS of $1.42.",
                    sourceSnippet: "Revenue increased 12% to $10.2 billion and adjusted EPS was $1.42.",
                  },
                  {
                    text: "Segment demand remained resilient during the period.",
                    sourceSnippet: "segment demand remained resilient",
                  },
                  {
                    text: "Management guided fiscal 2026 revenue to $42 billion to $44 billion and adjusted EPS to $5.80 to $6.10.",
                    sourceSnippet: "Example Corp expects fiscal 2026 revenue of $42 billion to $44 billion. Management expects adjusted EPS of $5.80 to $6.10.",
                  },
                ],
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
      metrics: [{
        key: "revenue",
        label: "Revenue",
        numericValue: 10_200_000_000,
        value: "$10.2B",
      }],
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe(
      "Reported first-quarter revenue of `$10.2 billion` and adjusted EPS of `$1.42`. Segment demand remained resilient during the period. Management guided fiscal 2026 revenue to `$42 billion` to `$44 billion` and adjusted EPS to `$5.80` to `$6.10`.",
    );
    const requestBody = postWithRetryFn.mock.calls[0]?.[1] as {
      contents?: {parts?: {text?: string}[]}[];
      generationConfig?: {
        responseJsonSchema?: {
          properties?: {
            sentences?: {
              maxItems?: number;
              minItems?: number;
            };
          };
        };
      };
    };
    const prompt = requestBody.contents?.[0]?.parts?.find(part => "string" === typeof part.text)?.text ?? "";
    const filingText = prompt.split("Filing text:\n")[1] ?? "";
    expect(prompt).toContain("Return exactly three sentence objects in order");
    expect(prompt).toContain("Never claim that guidance or outlook is absent");
    expect(prompt).toContain("Return plain text only; do not include markdown, backticks, bullets, headings, or labels.");
    expect(prompt).toContain("Do not return raw table rows or pipe-delimited cell text");
    expect(prompt).toContain("Do not mention the company name in the summary");
    expect(prompt).toContain("Displayed result metrics:\n- Revenue: $10.2B");
    expect(requestBody.generationConfig?.responseJsonSchema?.properties?.sentences).toEqual(
      expect.objectContaining({
        maxItems: 3,
        minItems: 3,
      }),
    );
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
                summary: "EXM revenue rose 12% to $10.2 billion while operating margin expanded 180 basis points to 24.3%. EXM guided net sales to $690-$710M, adjusted EPS to $3.65-$3.85, and adjusted tax rate to 21%-22%. Revenue momentum remained broad.",
                sourceSnippets: [
                  "Revenue rose 12% to $10.2 billion while operating margin expanded 180 basis points to 24.3%.",
                  "Guidance calls for net sales of $690-$710M, adjusted EPS of $3.65-$3.85, and an adjusted tax rate of 21%-22%.",
                  "Revenue momentum remained broad.",
                ],
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
      html: `
        <html><body>
          <h1>Example Corp reports first quarter 2026 results</h1>
          <p>Revenue rose 12% to $10.2 billion while operating margin expanded 180 basis points to 24.3%.</p>
          <p>Guidance calls for net sales of $690-$710M, adjusted EPS of $3.65-$3.85, and an adjusted tax rate of 21%-22%.</p>
          <p>Revenue momentum remained broad.</p>
        </body></html>
      `,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe(
      "`EXM` revenue rose `12%` to `$10.2 billion` while operating margin expanded `180 basis points` to `24.3%`. `EXM` guided net sales to `$690-$710M`, adjusted EPS to `$3.65-$3.85`, and adjusted tax rate to `21%-22%`. Revenue momentum remained broad.",
    );
  });

  test("keeps grounded sentences when an unsupported no-outlook claim is returned", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                sentences: [{
                  text: "Revenue rose 12% to $10.2 billion.",
                  sourceSnippet: "Revenue rose 12% to $10.2 billion.",
                }, {
                  text: "Operating margin expanded 180 basis points.",
                  sourceSnippet: "Operating margin expanded 180 basis points.",
                }, {
                  text: "No quantified outlook was provided.",
                  sourceSnippet: "Example Corp reports first quarter 2026 results.",
                }],
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
      html: `
        <h1>Example Corp reports first quarter 2026 results.</h1>
        <p>Revenue rose 12% to $10.2 billion.</p>
        <p>Operating margin expanded 180 basis points.</p>
      `,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe(
      "Revenue rose `12%` to `$10.2 billion`. Operating margin expanded `180 basis points`.",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI earnings summary failed validation for EXM (sentence 3 was not grounded or safely formatted); using a grounded partial summary.",
    );
    expect(postWithRetryFn).toHaveBeenCalledTimes(1);
  });

  test("uses exact material filing snippets when the generated prose is unsupported", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                sentences: [{
                  text: "The top line was strong.",
                  sourceSnippet: "Revenue rose 12% to $10.2 billion",
                }, {
                  text: "Profitability changed.",
                  sourceSnippet: "Operating margin expanded 180 basis points.",
                }, {
                  text: "The release was issued.",
                  sourceSnippet: "Example Corp reports first quarter 2026 results.",
                }],
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
      html: `
        <h1>Example Corp reports first quarter 2026 results.</h1>
        <p>Revenue rose 12% to $10.2 billion</p>
        <p>Operating margin expanded 180 basis points.</p>
      `,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe(
      "Revenue rose `12%` to `$10.2 billion`. Operating margin expanded `180 basis points`.",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI earnings summary failed validation for EXM (sentence 1 was not grounded or safely formatted); using a grounded partial summary.",
    );
  });

  test("keeps two grounded sentence objects when the provider returns too few", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                sentences: [{
                  text: "U.S. sales increased 8%.",
                  sourceSnippet: "U.S. sales increased 8%.",
                }, {
                  text: "Commercial demand remained resilient.",
                  sourceSnippet: "Commercial demand remained resilient.",
                }],
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
      html: `
        <p>U.S. sales increased 8%.</p>
        <p>Commercial demand remained resilient.</p>
      `,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe("U.S. sales increased `8%`. Commercial demand remained resilient.");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI earnings summary failed validation for EXM (expected 3 sentence objects, received 2); using a grounded partial summary.",
    );
  });

  test("rejects summaries whose evidence is missing or does not support their numbers", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "Revenue reached $10.2 billion. Margins improved. Guidance increased.",
                sourceSnippets: [
                  "Revenue reached $9.8 billion.",
                  "Margins improved.",
                  "This guidance snippet was invented.",
                ],
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
      html: `
        <p>Revenue reached $9.8 billion.</p>
        <p>Margins improved.</p>
        <p>Guidance increased.</p>
      `,
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
      "AI earnings summary failed validation for EXM (sentence 1 was not grounded or safely formatted).",
    );
  });

  test("rejects summaries that conflict with displayed result metrics", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "OXY reported Q1 2026 net income of $3.2 billion and EPS of $3.13. Production improved. No quantified outlook was provided.",
              }),
            }],
          },
        }],
      },
    });

    const result = await summarizeEarningsWithAi({
      companyName: "Occidental Petroleum",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: "<html><body><h1>Occidental reports first quarter 2026 results</h1></body></html>",
      metrics: [{
        key: "net_income",
        label: "Net income",
        numericValue: -9_000_000,
        value: "-$9M",
      }],
      ticker: "OXY",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBeNull();
  });

  test("rejects summaries with bare money values that conflict with displayed result metrics", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "For Q1 2026, revenue rose to 1.980 billion of net income on 6.921 billion of total operating revenues. Results were driven by stronger realized oil prices. No quantified outlook is provided.",
              }),
            }],
          },
        }],
      },
    });

    const result = await summarizeEarningsWithAi({
      companyName: "EOG Resources, Inc.",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: "<html><body><h1>EOG reports first quarter 2026 results</h1></body></html>",
      metrics: [{
        key: "revenue",
        label: "Revenue",
        numericValue: 3.58,
        value: "$3.58",
      }, {
        key: "net_income",
        label: "Net income",
        numericValue: 1_460_000_000,
        value: "$1.46B",
      }],
      ticker: "EOG",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBeNull();
  });

  test("allows other metrics in a sentence when the displayed metric matches", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "DOC reported net income of $193.48 million and EPS of $0.34. Revenue grew year over year. Guidance increased.",
                sourceSnippets: [
                  "Net income was $193.48 million and EPS was $0.34.",
                  "Revenue grew year over year.",
                  "Guidance increased.",
                ],
              }),
            }],
          },
        }],
      },
    });

    const result = await summarizeEarningsWithAi({
      companyName: "Healthpeak Properties, Inc.",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: `
        <html><body>
          <h1>Healthpeak reports first quarter 2026 results</h1>
          <p>Net income was $193.48 million and EPS was $0.34.</p>
          <p>Revenue grew year over year.</p>
          <p>Guidance increased.</p>
        </body></html>
      `,
      metrics: [{
        key: "net_income",
        label: "Net income",
        numericValue: 193_480_000,
        value: "$193.48M",
      }],
      ticker: "DOC",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe(
      "`DOC` reported net income of `$193.48 million` and EPS of `$0.34`. Revenue grew year over year. Guidance increased.",
    );
  });

  test("rejects summaries with unexpected CJK characters", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "Revenue rose on stronger sales. Margins improved. No quantified outlook is提供.",
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

    expect(result).toBeNull();
  });

  test("rejects summaries with markdown or correction artifacts", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "Revenue was >$411 million and net income was $165 million. Free cash flow reached a record -? no, We reiterate: record free cash flow was $144 million. `The company reiterated production and cost guidance.`",
              }),
            }],
          },
        }],
      },
    });

    const result = await summarizeEarningsWithAi({
      companyName: "Hecla Mining Company",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: "<html><body><h1>Hecla reports first quarter 2026 results</h1></body></html>",
      ticker: "HL",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBeNull();
  });

  test("normalizes summary whitespace", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "  Example Corp grew revenue.\\n\\nMargins improved.   Guidance increased.  ",
                sourceSnippets: [
                  "Example Corp grew revenue.",
                  "Margins improved.",
                  "Guidance increased.",
                ],
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
      html: `
        <html><body>
          <h1>Example Corp reports first quarter 2026 results</h1>
          <p>Example Corp grew revenue.</p>
          <p>Margins improved.</p>
          <p>Guidance increased.</p>
        </body></html>
      `,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe("Grew revenue. Margins improved. Guidance increased.");
  });

  test("keeps summary content when company and ticker metadata are blank", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "Revenue rose 12%. Margins improved. Guidance increased.",
                sourceSnippets: [
                  "Revenue rose 12%.",
                  "Margins improved.",
                  "Guidance increased.",
                ],
              }),
            }],
          },
        }],
      },
    });

    const result = await summarizeEarningsWithAi({
      companyName: " ",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: `
        <html><body>
          <h1>Revenue rose 12%.</h1>
          <p>Margins improved.</p>
          <p>Guidance increased.</p>
        </body></html>
      `,
      ticker: " ",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe("Revenue rose `12%`. Margins improved. Guidance increased.");
  });

  test("strips leading company names that contain periods or suffixes", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: "L.B. Foster Company reported revenue of $10 million. L.B. Foster's margins improved. Guidance increased.",
                sourceSnippets: [
                  "L.B. Foster Company reported revenue of $10 million.",
                  "L.B. Foster's margins improved.",
                  "Guidance increased.",
                ],
              }),
            }],
          },
        }],
      },
    });

    const result = await summarizeEarningsWithAi({
      companyName: "L.B. Foster Company",
      filingForm: "8-K",
      filingUrl: "https://www.sec.gov/example",
      html: `
        <html><body>
          <h1>L.B. Foster Company reports results</h1>
          <p>L.B. Foster Company reported revenue of $10 million.</p>
          <p>L.B. Foster's margins improved.</p>
          <p>Guidance increased.</p>
        </body></html>
      `,
      ticker: "FSTR",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe("Reported revenue of `$10 million`. Margins improved. Guidance increased.");
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

  test("drops forward-looking legal boilerplate from a grounded partial summary", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                sentences: [
                  {
                    text: "Revenue reached $1.3 billion in the second quarter.",
                    sourceSnippet: "Revenue reached $1.3 billion in the second quarter.",
                  },
                  {
                    text: "Comparable sales rose 15.3% during the period.",
                    sourceSnippet: "Comparable sales rose 15.3% during the period.",
                  },
                  {
                    text: "The forward-looking statements include expectations for revenue generation and guidance for 2026.",
                    sourceSnippet: "The forward-looking statements include expectations for revenue generation and guidance for 2026.",
                  },
                ],
              }),
            }],
          },
        }],
      },
    });

    const result = await summarizeEarningsWithAi({
      companyName: "Example Corp",
      filingForm: "6-K",
      filingUrl: "https://www.sec.gov/example",
      html: `
        <p>Revenue reached $1.3 billion in the second quarter.</p>
        <p>Comparable sales rose 15.3% during the period.</p>
        <p>The forward-looking statements include expectations for revenue generation and guidance for 2026.</p>
      `,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).toBe(
      "Revenue reached `$1.3 billion` in the second quarter. Comparable sales rose `15.3%` during the period.",
    );
  });

  test("drops raw table rows from a grounded partial summary", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                sentences: [
                  {
                    text: "Net sales | $ | 6,090,975 | 15.9% | $ | 5,256,907.",
                    sourceSnippet: "Net sales | $ | 6,090,975 | 15.9% | $ | 5,256,907.",
                  },
                  {
                    text: "Comparable club sales increased 11.9% year over year.",
                    sourceSnippet: "Comparable club sales increased 11.9% year over year.",
                  },
                  {
                    text: "Adjusted EPS is expected to range from $4.60 to $4.80.",
                    sourceSnippet: "Adjusted EPS is expected to range from $4.60 to $4.80.",
                  },
                ],
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
      html: `
        <p>Net sales | $ | 6,090,975 | 15.9% | $ | 5,256,907.</p>
        <p>Comparable club sales increased 11.9% year over year.</p>
        <p>Adjusted EPS is expected to range from $4.60 to $4.80.</p>
      `,
      ticker: "EXM",
    }, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    });

    expect(result).not.toContain("|");
    expect(result).toContain("Comparable club sales increased `11.9%` year over year.");
    expect(result).toContain("Adjusted EPS is expected to range from `$4.60` to `$4.80`.");
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
