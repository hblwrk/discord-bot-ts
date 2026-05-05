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
    expect(result.announcements[0]!.message).toContain("**Exxon Mobil (XOM) - Q1 2026**");
    expect(result.announcements[0]!.message).toContain("📊 **Results**");
    expect(result.announcements[0]!.message).toContain("- **Adj EPS:** $1.16 vs est. $0.96 (🟢 beat)");
    expect(result.announcements[0]!.message).toContain("- **Revenue:** $85.14B vs est. $80.74B (🟢 beat)");
    expect(result.announcements[0]!.message).toContain("SEC: [8-K](https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/xom-ex991.htm) Item 2.02, 9.01");
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

  test("skips SEC-only filings when no earnings metrics or outlook can be parsed", async () => {
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

    const result = await getEarningsResultAnnouncements({
      dependencies: {
        getEarningsResultFn,
        getWithRetryFn,
        logger,
        now: () => moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
      },
    });

    expect(result.announcements).toEqual([]);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping earnings result announcement for XOM: no filing details could be parsed.",
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
      content: expect.stringContaining("**Exxon Mobil (XOM) - Q1 2026**"),
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
      content: expect.stringContaining("**Exxon Mobil (XOM) - Q1 2026**"),
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
        content: "SEC: [8-K](https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/xom-ex991.htm) Item 2.02, 9.01",
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
    expect(getExampleEarningsResultOutput()).toContain("**Apple Inc. (AAPL) - Q1 2026**");
    expect(getExampleEarningsResultOutput()).toContain("📊 **Results**");
    expect(getExampleEarningsResultOutput()).toContain("- **EPS:** $2.84 vs est. $2.67 (🟢 beat)");
    expect(getExampleEarningsResultOutput()).toContain("SEC: [8-K](https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/a8-kex991q1202612272025.htm) Item 2.02, 9.01");
  });
});
