import moment from "moment-timezone";
import {beforeEach, describe, expect, test, vi} from "vitest";
import {
  clearEarningsResultCaches,
  getEarningsResultAnnouncements,
  getExampleEarningsResultOutput,
  startEarningsResultWatcher,
} from "./earnings-results.ts";

describe("earnings result announcements", () => {
  const logger = {
    log: vi.fn(),
  };
  const getEarningsResultFn = vi.fn();
  const getWithRetryFn = vi.fn();
  const postWithRetryFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    clearEarningsResultCaches();
    getEarningsResultFn.mockResolvedValue({
      status: "ok",
      events: [{
        ticker: "XOM",
        when: "before_open",
        date: "2026-05-01",
        importance: 1,
        companyName: "Exxon Mobil",
        marketCap: 475_000_000_000,
        marketCapText: "$475B",
        epsConsensus: "$0.96",
      }],
    });
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.includes("company_tickers.json")) {
        return {
          data: {
            0: {
              cik_str: 34088,
              ticker: "XOM",
              title: "EXXON MOBIL CORP",
            },
          },
        };
      }

      if (url.includes("type=8-K")) {
        return {
          data: `
            <feed>
              <entry>
                <title>8-K - EXXON MOBIL CORP</title>
                <id>urn:tag:sec.gov,2026:accession-number=0000034088-26-000042</id>
                <updated>2026-05-01T08:01:00-04:00</updated>
                <category term="8-K" />
                <link href="https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/0000034088-26-000042-index.htm" />
                <summary>
                  &lt;b&gt;CIK:&lt;/b&gt; 0000034088&lt;br/&gt;
                  &lt;b&gt;Items:&lt;/b&gt; 2.02, 9.01
                </summary>
              </entry>
            </feed>
          `,
        };
      }

      if (url.includes("type=6-K")) {
        return {
          data: "<feed></feed>",
        };
      }

      if (url.includes("companyfacts/CIK0000034088.json")) {
        return {
          data: {
            facts: {
              "us-gaap": {
                RevenueFromContractWithCustomerExcludingAssessedTax: {
                  units: {
                    USD: [{
                      accn: "0000034088-26-000042",
                      end: "2026-03-31",
                      fp: "Q1",
                      form: "8-K",
                      frame: "CY2026Q1",
                      start: "2026-01-01",
                      val: 85_140_000_000,
                    }],
                  },
                },
              },
            },
          },
        };
      }

      if (url.endsWith("/index.json")) {
        return {
          data: {
            directory: {
              item: [{
                name: "xom-ex991.htm",
                type: "EX-99.1",
              }],
            },
          },
        };
      }

      if (url.endsWith("/xom-ex991.htm")) {
        return {
          data: `
            <html>
              <body>
                <h1>Exxon Mobil reports first quarter 2026 results</h1>
                <p>Financial data in millions of dollars, except per share amounts.</p>
                <table>
                  <tr><td>Adjusted EPS</td><td>$1.16</td></tr>
                  <tr><td>Diluted earnings per share</td><td>$1.00</td></tr>
                  <tr><td>Total revenues and other income</td><td>85,140</td></tr>
                </table>
              </body>
            </html>
          `,
        };
      }

      if (url.includes("/XOM/earnings-surprise")) {
        return {
          data: {
            data: {
              earningsSurpriseTable: {
                rows: [{
                  dateReported: "5/1/2026",
                  eps: "$1.16",
                  consensusForecast: "$0.96",
                  percentageSurprise: "20.83",
                  revenueEstimate: "$80.74B",
                }],
              },
            },
          },
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
  });

  test("posts only one result per ticker and day when multiple current filings match", async () => {
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.includes("company_tickers.json")) {
        return {
          data: {
            0: {
              cik_str: 34088,
              ticker: "XOM",
              title: "EXXON MOBIL CORP",
            },
          },
        };
      }

      if (url.includes("type=8-K")) {
        return {
          data: `
            <feed>
              <entry>
                <title>8-K - EXXON MOBIL CORP</title>
                <id>urn:tag:sec.gov,2026:accession-number=0000034088-26-000042</id>
                <updated>2026-05-01T08:01:00-04:00</updated>
                <category term="8-K" />
                <link href="https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/0000034088-26-000042-index.htm" />
                <summary>
                  &lt;b&gt;CIK:&lt;/b&gt; 0000034088&lt;br/&gt;
                  &lt;b&gt;Items:&lt;/b&gt; 2.02, 9.01
                </summary>
              </entry>
              <entry>
                <title>8-K - EXXON MOBIL CORP</title>
                <id>urn:tag:sec.gov,2026:accession-number=0000034088-26-000043</id>
                <updated>2026-05-01T08:03:00-04:00</updated>
                <category term="8-K" />
                <link href="https://www.sec.gov/Archives/edgar/data/34088/000003408826000043/0000034088-26-000043-index.htm" />
                <summary>
                  &lt;b&gt;CIK:&lt;/b&gt; 0000034088&lt;br/&gt;
                  &lt;b&gt;Items:&lt;/b&gt; 2.02, 9.01
                </summary>
              </entry>
            </feed>
          `,
        };
      }

      if (url.includes("type=6-K")) {
        return {
          data: "<feed></feed>",
        };
      }

      if (url.includes("000003408826000042/index.json")) {
        return {
          data: {
            directory: {
              item: [{
                name: "xom-ex991.htm",
                type: "EX-99.1",
              }],
            },
          },
        };
      }

      if (url.includes("000003408826000042/xom-ex991.htm")) {
        return {
          data: `
            <html>
              <body>
                <h1>Exxon Mobil reports first quarter 2026 results</h1>
                <p>Financial data in millions of dollars, except per share amounts.</p>
                <table>
                  <tr><td>Adjusted EPS</td><td>$1.16</td></tr>
                  <tr><td>Total revenues and other income</td><td>85,140</td></tr>
                </table>
              </body>
            </html>
          `,
        };
      }

      if (url.includes("companyfacts/CIK0000034088.json")) {
        return {
          data: {
            facts: {},
          },
        };
      }

      if (url.includes("/XOM/earnings-surprise")) {
        return {
          data: {
            data: {
              earningsSurpriseTable: {
                rows: [{
                  dateReported: "5/1/2026",
                  eps: "$1.16",
                  consensusForecast: "$0.96",
                  revenueEstimate: "$80.74B",
                }],
              },
            },
          },
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
    });

    expect(result.announcements).toHaveLength(1);
    expect(getWithRetryFn).not.toHaveBeenCalledWith(
      expect.stringContaining("000003408826000043/index.json"),
      expect.anything(),
    );
  });

  test("builds an earnings result announcement from a watched SEC filing", async () => {
    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
    });

    expect(result.active).toBe(true);
    expect(result.watchedCompanies).toBe(1);
    expect(result.announcements).toHaveLength(1);
    expect(result.announcements[0]!.message).toContain(
      "**Exxon Mobil (`XOM`)** - Q1 2026 - [8-K](https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/xom-ex991.htm)",
    );
    expect(result.announcements[0]!.message).toContain("📊 **Results**");
    expect(result.announcements[0]!.message).toContain("- **Adj EPS:** `$1.16` vs est. `$0.96` (🟢 beat)");
    expect(result.announcements[0]!.message).toContain("- **Revenue:** `$85.14B` vs est. `$80.74B` (🟢 beat)");
  });

  test("adds an AI summary to the earnings result announcement when available", async () => {
    const rawSummary = "XOM reported Q1 2026 adjusted EPS of $1.16 and revenue of $85.14B, both ahead of consensus. Results were supported by broad earnings strength across the business. The company did not provide a quantified outlook.";
    const formattedSummary = "`XOM` reported Q1 2026 adjusted EPS of `$1.16` and revenue of `$85.14B`, both ahead of consensus. Results were supported by broad earnings strength across the business. The company did not provide a quantified outlook.";
    postWithRetryFn.mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summary: rawSummary,
              }),
            }],
          },
        }],
      },
    });

    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
        postWithRetryFn,
        readSecretFn: vi.fn((secretName: string) => {
          if ("gemini_api_key" === secretName) {
            return "gemini-key";
          }

          throw new Error(`missing ${secretName}`);
        }),
      },
    });

    const message = result.announcements[0]!.message;
    expect(message).toContain(`📝 ${formattedSummary}`);
    expect(message).not.toContain("📝 **Summary**");
    expect(message.indexOf(`📝 ${formattedSummary}`)).toBeLessThan(message.indexOf("📊 **Results**"));
    expect(postWithRetryFn).toHaveBeenCalledTimes(1);
  });

  test("skips accessions that were already announced", async () => {
    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
      seenAccessions: new Set(["0000034088-26-000042"]),
    });

    expect(result.announcements).toHaveLength(0);
  });

  test("skips companies outside the scheduled earnings announcement scope", async () => {
    getEarningsResultFn.mockResolvedValue({
      status: "ok",
      events: [{
        ticker: "XOM",
        when: "before_open",
        date: "2026-05-01",
        importance: 1,
        companyName: "Exxon Mobil",
        marketCap: 9_999_999_999,
        marketCapText: "$10B",
        epsConsensus: "$0.96",
      }],
    });

    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
    });

    expect(result).toEqual({
      active: false,
      announcements: [],
      watchedCompanies: 0,
    });
    expect(getWithRetryFn).toHaveBeenCalledWith(
      "https://www.sec.gov/files/company_tickers.json",
      expect.anything(),
    );
    expect(getWithRetryFn).not.toHaveBeenCalledWith(
      expect.stringContaining("browse-edgar"),
      expect.anything(),
    );
  });

  test("skips SEC filings updated on a different US Eastern day", async () => {
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.includes("company_tickers.json")) {
        return {
          data: {
            0: {
              cik_str: 34088,
              ticker: "XOM",
              title: "EXXON MOBIL CORP",
            },
          },
        };
      }

      if (url.includes("type=8-K")) {
        return {
          data: `
            <feed>
              <entry>
                <title>8-K - EXXON MOBIL CORP</title>
                <id>urn:tag:sec.gov,2026:accession-number=0000034088-26-000042</id>
                <updated>2026-04-30T23:59:00-04:00</updated>
                <category term="8-K" />
                <link href="https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/0000034088-26-000042-index.htm" />
                <summary>
                  &lt;b&gt;CIK:&lt;/b&gt; 0000034088&lt;br/&gt;
                  &lt;b&gt;Items:&lt;/b&gt; 2.02, 9.01
                </summary>
              </entry>
            </feed>
          `,
        };
      }

      if (url.includes("type=6-K")) {
        return {
          data: "<feed></feed>",
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
    });

    expect(result.active).toBe(true);
    expect(result.watchedCompanies).toBe(1);
    expect(result.announcements).toEqual([]);
    expect(getWithRetryFn).not.toHaveBeenCalledWith(
      expect.stringContaining("/index.json"),
      expect.anything(),
    );
  });

  test("skips the scan when the SEC ticker map is blocked", async () => {
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.includes("company_tickers.json")) {
        throw new Error("Request failed with status code 403");
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
    });

    expect(result).toEqual({
      active: false,
      announcements: [],
      watchedCompanies: 0,
    });
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping earnings result scan: SEC ticker map could not be loaded: Error: Request failed with status code 403",
    );
  });

  test("skips one announcement when SEC filing details are blocked", async () => {
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.includes("company_tickers.json")) {
        return {
          data: {
            0: {
              cik_str: 34088,
              ticker: "XOM",
              title: "EXXON MOBIL CORP",
            },
          },
        };
      }

      if (url.includes("type=8-K")) {
        return {
          data: `
            <feed>
              <entry>
                <title>8-K - EXXON MOBIL CORP</title>
                <id>urn:tag:sec.gov,2026:accession-number=0000034088-26-000042</id>
                <updated>2026-05-01T08:01:00-04:00</updated>
                <category term="8-K" />
                <link href="https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/0000034088-26-000042-index.htm" />
                <summary>
                  &lt;b&gt;CIK:&lt;/b&gt; 0000034088&lt;br/&gt;
                  &lt;b&gt;Items:&lt;/b&gt; 2.02, 9.01
                </summary>
              </entry>
            </feed>
          `,
        };
      }

      if (url.includes("type=6-K")) {
        return {
          data: "<feed></feed>",
        };
      }

      if (url.endsWith("/index.json")) {
        throw new Error("Request failed with status code 403");
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
    });

    expect(result.active).toBe(true);
    expect(result.watchedCompanies).toBe(1);
    expect(result.announcements).toEqual([]);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping earnings result announcement for XOM: SEC filing details could not be loaded: Error: Request failed with status code 403",
    );
  });

  test("backs off SEC-only filings when no earnings metrics or outlook can be parsed", async () => {
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.includes("company_tickers.json")) {
        return {
          data: {
            0: {
              cik_str: 34088,
              ticker: "XOM",
              title: "EXXON MOBIL CORP",
            },
          },
        };
      }

      if (url.includes("type=8-K")) {
        return {
          data: `
            <feed>
              <entry>
                <title>8-K - EXXON MOBIL CORP</title>
                <id>urn:tag:sec.gov,2026:accession-number=0000034088-26-000042</id>
                <updated>2026-05-01T08:01:00-04:00</updated>
                <category term="8-K" />
                <link href="https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/0000034088-26-000042-index.htm" />
                <summary>
                  &lt;b&gt;CIK:&lt;/b&gt; 0000034088&lt;br/&gt;
                  &lt;b&gt;Items:&lt;/b&gt; 2.02, 9.01
                </summary>
              </entry>
            </feed>
          `,
        };
      }

      if (url.includes("type=6-K")) {
        return {
          data: "<feed></feed>",
        };
      }

      if (url.endsWith("/index.json")) {
        return {
          data: {
            directory: {
              item: [{
                name: "xom-ex991.htm",
                type: "EX-99.1",
              }],
            },
          },
        };
      }

      if (url.endsWith("/xom-ex991.htm")) {
        return {
          data: "<html><body><h1>Exxon Mobil reports first quarter 2026 results</h1></body></html>",
        };
      }

      if (url.includes("/XOM/earnings-surprise")) {
        return {
          data: {
            data: {
              earningsSurpriseTable: {
                rows: [],
              },
            },
          },
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const skippedNoMetricsAccessions = new Map<string, number>();
    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
      skippedNoMetricsAccessions,
    });

    expect(result.announcements).toEqual([]);
    expect(skippedNoMetricsAccessions.get("0000034088-26-000042")).toBe(
      moment.tz("2026-05-01 08:10", "YYYY-MM-DD HH:mm", "US/Eastern").valueOf(),
    );
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping earnings result announcement for XOM: no earnings metrics or outlook could be parsed.",
    );

    getWithRetryFn.mockClear();
    logger.log.mockClear();

    const secondResult = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:06", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
      skippedNoMetricsAccessions,
    });

    expect(secondResult.announcements).toEqual([]);
    expect(logger.log).not.toHaveBeenCalledWith(
      "warn",
      "Skipping earnings result announcement for XOM: no earnings metrics or outlook could be parsed.",
    );
    expect(getWithRetryFn).not.toHaveBeenCalledWith(
      expect.stringContaining("/index.json"),
      expect.anything(),
    );
  });

  test("retries SEC filings after a no-metrics backoff", async () => {
    let indexRequests = 0;
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.includes("company_tickers.json")) {
        return {
          data: {
            0: {
              cik_str: 34088,
              ticker: "XOM",
              title: "EXXON MOBIL CORP",
            },
          },
        };
      }

      if (url.includes("type=8-K")) {
        return {
          data: `
            <feed>
              <entry>
                <title>8-K - EXXON MOBIL CORP</title>
                <id>urn:tag:sec.gov,2026:accession-number=0000034088-26-000042</id>
                <updated>2026-05-01T08:01:00-04:00</updated>
                <category term="8-K" />
                <link href="https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/0000034088-26-000042-index.htm" />
                <summary>
                  &lt;b&gt;CIK:&lt;/b&gt; 0000034088&lt;br/&gt;
                  &lt;b&gt;Items:&lt;/b&gt; 2.02, 9.01
                </summary>
              </entry>
            </feed>
          `,
        };
      }

      if (url.includes("type=6-K")) {
        return {
          data: "<feed></feed>",
        };
      }

      if (url.includes("companyfacts/CIK0000034088.json")) {
        return {
          data: {
            facts: {},
          },
        };
      }

      if (url.endsWith("/index.json")) {
        indexRequests++;
        return {
          data: {
            directory: {
              item: 1 === indexRequests ? [{
                name: "xom-20260331.htm",
                type: "8-K",
              }] : [{
                name: "xom-ex991.htm",
                type: "EX-99.1",
              }],
            },
          },
        };
      }

      if (url.endsWith("/xom-20260331.htm")) {
        return {
          data: `
            <html>
              <body>
                <h1>Item 2.02 Results of Operations and Financial Condition</h1>
                <p>A copy of the press release is furnished as Exhibit 99.1.</p>
              </body>
            </html>
          `,
        };
      }

      if (url.endsWith("/xom-ex991.htm")) {
        return {
          data: `
            <html>
              <body>
                <h1>Exxon Mobil reports first quarter 2026 results</h1>
                <p>Financial data in millions of dollars.</p>
                <p>Total revenues were $100 million.</p>
                <p>Net income was $10 million.</p>
              </body>
            </html>
          `,
        };
      }

      if (url.includes("/XOM/earnings-surprise")) {
        return {
          data: {
            data: {
              earningsSurpriseTable: {
                rows: [],
              },
            },
          },
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const skippedNoMetricsAccessions = new Map<string, number>();
    const firstResult = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
      skippedNoMetricsAccessions,
    });
    expect(firstResult.announcements).toEqual([]);

    const secondResult = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:11", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
      skippedNoMetricsAccessions,
    });

    expect(secondResult.announcements).toHaveLength(1);
    expect(secondResult.announcements[0]?.message).toContain("**Revenue:** `$100M`");
    expect(skippedNoMetricsAccessions.has("0000034088-26-000042")).toBe(false);
  });

  test("does not spend AI calls on primary 8-K shells with no parsed metrics", async () => {
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.includes("company_tickers.json")) {
        return {
          data: {
            0: {
              cik_str: 34088,
              ticker: "XOM",
              title: "EXXON MOBIL CORP",
            },
          },
        };
      }

      if (url.includes("type=8-K")) {
        return {
          data: `
            <feed>
              <entry>
                <title>8-K - EXXON MOBIL CORP</title>
                <id>urn:tag:sec.gov,2026:accession-number=0000034088-26-000042</id>
                <updated>2026-05-01T08:01:00-04:00</updated>
                <category term="8-K" />
                <link href="https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/0000034088-26-000042-index.htm" />
                <summary>
                  &lt;b&gt;CIK:&lt;/b&gt; 0000034088&lt;br/&gt;
                  &lt;b&gt;Items:&lt;/b&gt; 2.02, 9.01
                </summary>
              </entry>
            </feed>
          `,
        };
      }

      if (url.includes("type=6-K")) {
        return {
          data: "<feed></feed>",
        };
      }

      if (url.includes("companyfacts/CIK0000034088.json")) {
        return {
          data: {
            facts: {},
          },
        };
      }

      if (url.endsWith("/index.json")) {
        return {
          data: {
            directory: {
              item: [{
                name: "xom-20260331.htm",
                type: "8-K",
              }],
            },
          },
        };
      }

      if (url.endsWith("/xom-20260331.htm")) {
        return {
          data: `
            <html>
              <body>
                <h1>Item 2.02 Results of Operations and Financial Condition</h1>
                <p>A copy of the press release is furnished as Exhibit 99.1.</p>
              </body>
            </html>
          `,
        };
      }

      if (url.includes("/XOM/earnings-surprise")) {
        return {
          data: {
            data: {
              earningsSurpriseTable: {
                rows: [],
              },
            },
          },
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
        postWithRetryFn,
        readSecretFn: vi.fn((secretName: string) => {
          if ("gemini_api_key" === secretName) {
            return "gemini-key";
          }

          throw new Error(`missing ${secretName}`);
        }),
      },
    });

    expect(result.announcements).toEqual([]);
    expect(postWithRetryFn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping earnings result announcement for XOM: no earnings metrics or outlook could be parsed.",
    );
  });

  test("watcher sends new announcements once, schedules active polling, and clears its timer on stop", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const timeoutHandle = {
      unref: vi.fn(),
    } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutMock = vi.fn((_callback: () => void, _delayMs: number) => timeoutHandle);
    const clearTimeoutFn = vi.fn();
    const fetchMessages = vi.fn().mockResolvedValue(new Map());

    const watcher = startEarningsResultWatcher({
      channels: {
        cache: {
          get: vi.fn(() => ({
            messages: {
              fetch: fetchMessages,
            },
            send,
          })),
        },
      },
    }, "breaking-news-channel-id", {
      clearTimeoutFn,
      getEarningsResultFn,
      getWithRetryFn,
      logger,
      now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      pollIntervalMs: 123,
      setTimeoutFn: setTimeoutMock as unknown as typeof setTimeout,
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });

    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining("**Exxon Mobil (`XOM`)** - Q1 2026 - [8-K](https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/xom-ex991.htm)"),
      allowedMentions: {
        parse: [],
      },
    });
    expect(fetchMessages).toHaveBeenCalledWith({
      limit: 100,
    });
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 123);
    expect(timeoutHandle.unref).toHaveBeenCalledTimes(1);

    const secondScan = await watcher.runOnce();
    expect(secondScan.announcements).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);

    watcher.stop();

    expect(clearTimeoutFn).toHaveBeenCalledWith(timeoutHandle);
  });

  test("watcher sends announcements to the optional results thread and seeds thread plus parent history", async () => {
    const parentSend = vi.fn().mockResolvedValue(undefined);
    const threadSend = vi.fn().mockResolvedValue(undefined);
    const parentFetchMessages = vi.fn().mockResolvedValue(new Map());
    const threadFetchMessages = vi.fn().mockResolvedValue(new Map());
    const timeoutHandle = {
      unref: vi.fn(),
    } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutMock = vi.fn((_callback: () => void, _delayMs: number) => timeoutHandle);

    const watcher = startEarningsResultWatcher({
      channels: {
        cache: {
          get: vi.fn((channelID: string) => {
            if ("earnings-results-thread-id" === channelID) {
              return {
                messages: {
                  fetch: threadFetchMessages,
                },
                send: threadSend,
              };
            }

            return {
              messages: {
                fetch: parentFetchMessages,
              },
              send: parentSend,
            };
          }),
        },
      },
    }, "breaking-news-channel-id", {
      announcementThreadID: "earnings-results-thread-id",
      getEarningsResultFn,
      getWithRetryFn,
      logger,
      now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      pollIntervalMs: 123,
      setTimeoutFn: setTimeoutMock as unknown as typeof setTimeout,
    });

    await vi.waitFor(() => {
      expect(threadSend).toHaveBeenCalledTimes(1);
    });

    expect(threadFetchMessages).toHaveBeenCalledWith({
      limit: 100,
    });
    expect(parentFetchMessages).toHaveBeenCalledWith({
      limit: 100,
    });
    expect(threadSend).toHaveBeenCalledWith({
      content: expect.stringContaining("**Exxon Mobil (`XOM`)** - Q1 2026 - [8-K](https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/xom-ex991.htm)"),
      allowedMentions: {
        parse: [],
      },
    });
    expect(parentSend).not.toHaveBeenCalled();

    watcher.stop();
  });

  test("watcher seeds announced accessions from channel history before scanning", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const timeoutHandle = {
      unref: vi.fn(),
    } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutMock = vi.fn((_callback: () => void, _delayMs: number) => timeoutHandle);
    const fetchMessages = vi.fn().mockResolvedValue(new Map([
      ["message-id", {
        content: "**Exxon Mobil (`XOM`)** - Q1 2026 - [8-K](https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/xom-ex991.htm)",
      }],
    ]));

    const watcher = startEarningsResultWatcher({
      channels: {
        cache: {
          get: vi.fn(() => ({
            messages: {
              fetch: fetchMessages,
            },
            send,
          })),
        },
      },
    }, "breaking-news-channel-id", {
      getEarningsResultFn,
      getWithRetryFn,
      logger,
      now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      pollIntervalMs: 123,
      setTimeoutFn: setTimeoutMock as unknown as typeof setTimeout,
    });

    await vi.waitFor(() => {
      expect(setTimeoutMock).toHaveBeenCalled();
    });

    expect(fetchMessages).toHaveBeenCalledWith({
      limit: 100,
    });
    expect(send).not.toHaveBeenCalled();
    expect(getWithRetryFn).not.toHaveBeenCalledWith(
      expect.stringContaining("/index.json"),
      expect.anything(),
    );

    watcher.stop();
  });

  test("watcher seeds same-day result tickers from channel history before scanning", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const timeoutHandle = {
      unref: vi.fn(),
    } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutMock = vi.fn((_callback: () => void, _delayMs: number) => timeoutHandle);
    const fetchMessages = vi.fn().mockResolvedValue(new Map([
      ["message-id", {
        content: "**Exxon Mobil (`XOM`)** - Q1 2026 - [8-K](https://www.sec.gov/Archives/edgar/data/34088/000003408826000041/xom-ex991.htm)",
        createdTimestamp: moment.tz("2026-05-01 08:04", "YYYY-MM-DD HH:mm", "US/Eastern").valueOf(),
      }],
    ]));

    const watcher = startEarningsResultWatcher({
      channels: {
        cache: {
          get: vi.fn(() => ({
            messages: {
              fetch: fetchMessages,
            },
            send,
          })),
        },
      },
    }, "breaking-news-channel-id", {
      getEarningsResultFn,
      getWithRetryFn,
      logger,
      now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      pollIntervalMs: 123,
      setTimeoutFn: setTimeoutMock as unknown as typeof setTimeout,
    });

    await vi.waitFor(() => {
      expect(setTimeoutMock).toHaveBeenCalled();
    });

    expect(send).not.toHaveBeenCalled();
    expect(getWithRetryFn).not.toHaveBeenCalledWith(
      expect.stringContaining("/index.json"),
      expect.anything(),
    );

    watcher.stop();
  });

  test("uses AI extraction and suppresses suspicious earnings metrics when quality gate rejects them", async () => {
    getEarningsResultFn.mockResolvedValue({
      status: "ok",
      events: [{
        ticker: "BUD",
        when: "before_open",
        date: "2026-05-01",
        importance: 1,
        companyName: "Anheuser-Busch Inbev SA",
        marketCap: 100_000_000_000,
        marketCapText: "$100B",
        epsConsensus: "$0.90",
      }],
    });
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.includes("company_tickers.json")) {
        return {
          data: {
            0: {
              cik_str: 1668717,
              ticker: "BUD",
              title: "ANHEUSER-BUSCH INBEV SA/NV",
            },
          },
        };
      }

      if (url.includes("type=8-K")) {
        return {
          data: "<feed></feed>",
        };
      }

      if (url.includes("type=6-K")) {
        return {
          data: `
            <feed>
              <entry>
                <title>6-K - ANHEUSER-BUSCH INBEV SA/NV</title>
                <id>urn:tag:sec.gov,2026:accession-number=0001193125-26-123456</id>
                <updated>2026-05-01T08:01:00-04:00</updated>
                <category term="6-K" />
                <link href="https://www.sec.gov/Archives/edgar/data/1668717/000119312526123456/0001193125-26-123456-index.htm" />
                <summary>&lt;b&gt;CIK:&lt;/b&gt; 0001668717</summary>
              </entry>
            </feed>
          `,
        };
      }

      if (url.endsWith("/index.json")) {
        return {
          data: {
            directory: {
              item: [{
                name: "bud-ex991.htm",
                type: "EX-99.1",
              }],
            },
          },
        };
      }

      if (url.endsWith("/bud-ex991.htm")) {
        return {
          data: `
            <html>
              <body>
                <h1>Anheuser-Busch InBev reports first quarter 2026 results</h1>
                <p>Revenue increased to 14.55 billion USD.</p>
                <table>
                  <tr><td>EPS</td><td>20.80</td></tr>
                  <tr><td>Revenue</td><td>267</td></tr>
                </table>
              </body>
            </html>
          `,
        };
      }

      if (url.includes("companyfacts/CIK0001668717.json")) {
        return {
          data: {
            facts: {},
          },
        };
      }

      if (url.includes("/BUD/earnings-surprise")) {
        return {
          data: {
            data: {
              earningsSurpriseTable: {
                rows: [{
                  dateReported: "5/1/2026",
                  consensusForecast: "$0.90",
                  revenueEstimate: "$14.4B",
                }],
              },
            },
          },
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    postWithRetryFn
      .mockResolvedValueOnce({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  quarterLabel: "Q1 2026",
                  metrics: [{
                    key: "revenue",
                    numericValue: 14_550_000_000,
                    currencyCode: "USD",
                    sourceSnippet: "Revenue increased to 14.55 billion USD.",
                  }],
                  issues: [],
                }),
              }],
            },
          }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  decision: "suppress",
                  confidence: 0.91,
                  reason: "EPS was parsed from a table fragment and does not match the supported filing text.",
                  issues: [{
                    severity: "high",
                    metricKey: "gaap_eps",
                    message: "The EPS value is likely a parsing artifact.",
                    sourceSnippet: "EPS | 20.80",
                  }],
                }),
              }],
            },
          }],
        },
      });

    const skippedQualityGateAccessions = new Map<string, number>();
    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
        postWithRetryFn,
        readSecretFn: vi.fn((secretName: string) => {
          if ("gemini_api_key" === secretName) {
            return "gemini-key";
          }

          if ("gemini_calls_per_minute" === secretName) {
            return "14";
          }

          throw new Error(`missing ${secretName}`);
        }),
      },
      skippedQualityGateAccessions,
    });

    expect(result.announcements).toEqual([]);
    expect(postWithRetryFn).toHaveBeenCalledTimes(2);
    expect(skippedQualityGateAccessions.get("0001193125-26-123456")).toBe(
      moment.tz("2026-05-01 08:10", "YYYY-MM-DD HH:mm", "US/Eastern").valueOf(),
    );
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping earnings result announcement for BUD: suspicious metrics were not verified.",
    );

    postWithRetryFn.mockClear();
    logger.log.mockClear();

    const secondResult = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:06", "YYYY-MM-DD HH:mm", "US/Eastern"),
        postWithRetryFn,
        readSecretFn: vi.fn((secretName: string) => {
          if ("gemini_api_key" === secretName) {
            return "gemini-key";
          }

          if ("gemini_calls_per_minute" === secretName) {
            return "14";
          }

          throw new Error(`missing ${secretName}`);
        }),
      },
      skippedQualityGateAccessions,
    });

    expect(secondResult.announcements).toEqual([]);
    expect(postWithRetryFn).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalledWith(
      "warn",
      "Skipping earnings result announcement for BUD: suspicious metrics were not verified.",
    );

    postWithRetryFn
      .mockResolvedValueOnce({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  metrics: [{
                    key: "revenue",
                    label: "Revenue",
                    value: "14.55",
                    unit: "billion",
                    currencyCode: "USD",
                    sourceSnippet: "Revenue increased to 14.55 billion USD.",
                  }],
                  issues: [],
                }),
              }],
            },
          }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  decision: "allow",
                  confidence: 0.92,
                  reason: "The filing text supports the metrics after retry.",
                  issues: [],
                }),
              }],
            },
          }],
        },
      });

    const retryResult = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:11", "YYYY-MM-DD HH:mm", "US/Eastern"),
        postWithRetryFn,
        readSecretFn: vi.fn((secretName: string) => {
          if ("gemini_api_key" === secretName) {
            return "gemini-key";
          }

          if ("gemini_calls_per_minute" === secretName) {
            return "14";
          }

          throw new Error(`missing ${secretName}`);
        }),
      },
      skippedQualityGateAccessions,
    });

    expect(retryResult.announcements).toHaveLength(1);
    expect(postWithRetryFn).toHaveBeenCalledTimes(3);
    expect(skippedQualityGateAccessions.has("0001193125-26-123456")).toBe(false);
  });

  test("watcher skips scans until channel history can be checked", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const timeoutHandle = {
      unref: vi.fn(),
    } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutMock = vi.fn((_callback: () => void, _delayMs: number) => timeoutHandle);

    const watcher = startEarningsResultWatcher({
      channels: {
        cache: {
          get: vi.fn(() => ({
            messages: {
              fetch: vi.fn().mockRejectedValue(new Error("missing permission")),
            },
            send,
          })),
        },
      },
    }, "breaking-news-channel-id", {
      getEarningsResultFn,
      getWithRetryFn,
      logger,
      now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      pollIntervalMs: 123,
      setTimeoutFn: setTimeoutMock as unknown as typeof setTimeout,
    });

    await vi.waitFor(() => {
      expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 123);
    });

    expect(getEarningsResultFn).not.toHaveBeenCalled();
    expect(getWithRetryFn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Could not seed earnings result announcements from channel history: Error: missing permission",
    );

    watcher.stop();
  });

  test("provides a concrete example output", () => {
    expect(getExampleEarningsResultOutput()).toContain(
      "**Apple Inc. (`AAPL`)** - Q1 2026 - [8-K](https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/a8-kex991q1202612272025.htm)",
    );
    expect(getExampleEarningsResultOutput()).toContain("📝 Apple reported Q1 2026 results");
    expect(getExampleEarningsResultOutput()).toContain("📊 **Results**");
    expect(getExampleEarningsResultOutput()).toContain("- **EPS:** `$2.84` vs est. `$2.67` (🟢 beat)");
  });
});
