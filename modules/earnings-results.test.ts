import moment from "moment-timezone";
import {
  clearEarningsResultCaches,
  getEarningsResultAnnouncements,
  getExampleEarningsResultOutput,
} from "./earnings-results.js";

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

  test("builds a breaking-news announcement from a watched SEC filing", async () => {
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
    expect(result.announcements[0]!.message).toContain("Earnings: Exxon Mobil (`XOM`) Q1 2026");
    expect(result.announcements[0]!.message).toContain("Adj EPS: `$1.16` vs est. `$0.96` - beat");
    expect(result.announcements[0]!.message).toContain("Revenue: `$85.14B` vs est. `$80.74B` - beat");
    expect(result.announcements[0]!.message).toContain("SEC: 8-K Item 2.02, 9.01");
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

  test("provides a concrete example output", () => {
    expect(getExampleEarningsResultOutput()).toContain("Apple Inc. (`AAPL`)");
    expect(getExampleEarningsResultOutput()).toContain("EPS: `$2.84` vs est. `$2.67` - beat");
  });
});
