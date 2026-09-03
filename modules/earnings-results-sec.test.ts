import {beforeEach, describe, expect, test, vi} from "vitest";
import {parseEarningsDocument} from "./earnings-results-format.ts";
import {
  clearSecEarningsResultCaches,
  isLikelyEarningsFiling,
  loadSecCurrentFilings,
  loadSecFilingDetails,
  loadSecTickerMap,
  parseSecCurrentFilingsAtom,
  type SecCurrentFiling,
} from "./earnings-results-sec.ts";

describe("SEC earnings result source", () => {
  const logger = {
    log: vi.fn(),
  };
  const getWithRetryFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    clearSecEarningsResultCaches();
  });

  test("parses current filings atom entries and extracts earnings items", () => {
    const filings = parseSecCurrentFilingsAtom(`
      <feed>
        <entry>
          <title>8-K - EXXON MOBIL CORP</title>
          <id>urn:tag:sec.gov,2026:accession-number=0000034088-26-000042</id>
          <updated>2026-05-01T10:01:00-04:00</updated>
          <category term="8-K" />
          <link href="https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/0000034088-26-000042-index.htm" />
          <summary>
            &lt;b&gt;CIK:&lt;/b&gt; 0000034088&lt;br/&gt;
            &lt;b&gt;Items:&lt;/b&gt; 2.02, 9.01
          </summary>
        </entry>
      </feed>
    `);

    expect(filings).toEqual([{
      accessionNumber: "0000034088-26-000042",
      cik: "0000034088",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/0000034088-26-000042-index.htm",
      form: "8-K",
      items: ["2.02", "9.01"],
      title: "8-K - EXXON MOBIL CORP",
      updated: "2026-05-01T10:01:00-04:00",
    }]);
    expect(isLikelyEarningsFiling(filings[0]!)).toBe(true);
  });

  test("rejects non-earnings 8-K items", () => {
    expect(isLikelyEarningsFiling({
      accessionNumber: "0000000000-26-000000",
      cik: "0000000001",
      filingUrl: "https://www.sec.gov/example",
      form: "10-K",
      items: [],
      title: "10-K",
      updated: "2026-05-01T10:01:00-04:00",
    })).toBe(false);

    expect(isLikelyEarningsFiling({
      accessionNumber: "0000000000-26-000001",
      cik: "0000000001",
      filingUrl: "https://www.sec.gov/example",
      form: "8-K",
      items: ["5.02"],
      title: "8-K",
      updated: "2026-05-01T10:01:00-04:00",
    })).toBe(false);

    expect(isLikelyEarningsFiling({
      accessionNumber: "0000000000-26-000002",
      cik: "0000000001",
      filingUrl: "https://www.sec.gov/example",
      form: "8-K",
      items: ["7.01", "9.01"],
      title: "8-K",
      updated: "2026-05-01T10:01:00-04:00",
    })).toBe(false);

    expect(isLikelyEarningsFiling({
      accessionNumber: "0000000000-26-000003",
      cik: "0000000001",
      filingUrl: "https://www.sec.gov/example",
      form: "8-K",
      items: ["2.02", "9.01"],
      title: "8-K",
      updated: "2026-05-01T10:01:00-04:00",
    })).toBe(true);
  });

  test("parses title fallback forms, URL-derived CIKs, and compact accession URLs", () => {
    const filings = parseSecCurrentFilingsAtom(`
      <feed>
        <entry>
          <title>6-K - Foreign Issuer &amp; Co</title>
          <updated>2026-05-01T10:01:00-04:00</updated>
          <link href="https://www.sec.gov/Archives/edgar/data/1234567/000123456726000123/foreign-issuer-6k.htm" />
        </entry>
        <entry>
          <title>Missing accession</title>
          <category term="8-K" />
          <summary>CIK: 0000000001</summary>
        </entry>
      </feed>
    `);

    expect(filings).toEqual([{
      accessionNumber: "0001234567-26-000123",
      cik: "0001234567",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/1234567/000123456726000123/foreign-issuer-6k.htm",
      form: "6-K",
      items: [],
      title: "6-K - Foreign Issuer & Co",
      updated: "2026-05-01T10:01:00-04:00",
    }]);
    expect(isLikelyEarningsFiling(filings[0]!)).toBe(true);
  });

  test("loads SEC ticker map with normalized symbols and caches successful responses", async () => {
    getWithRetryFn.mockResolvedValue({
      data: {
        0: {
          cik_str: 320193,
          ticker: "BRK.B",
          title: "Berkshire Hathaway Inc.",
        },
        1: {
          cik_str: "",
          ticker: "BAD",
          title: "Bad Row",
        },
      },
    });
    const dependencies = {
      getWithRetryFn,
      logger,
    } as Parameters<typeof loadSecTickerMap>[0];

    const firstMap = await loadSecTickerMap(dependencies);
    const secondMap = await loadSecTickerMap(dependencies);

    expect(firstMap.get("BRK.B")).toEqual({
      cik: "0000320193",
      ticker: "BRK.B",
      title: "Berkshire Hathaway Inc.",
    });
    expect(firstMap.has("BAD")).toBe(false);
    expect(secondMap).toBe(firstMap);
    expect(getWithRetryFn).toHaveBeenCalledTimes(1);
    expect(getWithRetryFn).toHaveBeenCalledWith(
      "https://www.sec.gov/files/company_tickers.json",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Accept-Encoding": "gzip, deflate",
          "User-Agent": "hblwrk discord-bot-ts admin@hblwrk.de",
        }),
      }),
    );
  });

  test("loads current 8-K and 6-K filings, logs failed feeds, and dedupes accessions", async () => {
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.includes("type=8-K")) {
        return {
          data: `
            <feed>
              <entry>
                <title>8-K - FIRST COMPANY</title>
                <id>accession-number=0000000001-26-000001</id>
                <updated>2026-05-01T10:01:00-04:00</updated>
                <category term="8-K" />
                <link href="https://www.sec.gov/Archives/edgar/data/1/000000000126000001/index.htm" />
                <summary>CIK: 0000000001<br/>Items: 2.02, 9.01</summary>
              </entry>
            </feed>
          `,
        };
      }

      throw new Error("SEC feed unavailable");
    });
    const dependencies = {
      getWithRetryFn,
      logger,
    } as Parameters<typeof loadSecCurrentFilings>[0];

    const filings = await loadSecCurrentFilings(dependencies, 25);

    expect(filings).toHaveLength(1);
    expect(filings[0]?.accessionNumber).toBe("0000000001-26-000001");
    expect(getWithRetryFn).toHaveBeenCalledWith(
      expect.stringContaining("count=25"),
      expect.objectContaining({
        responseType: "text",
      }),
    );
    expect(logger.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Loading SEC current filings failed"),
    );
  });

  test("loads filing details by preferring earnings-release exhibits over index noise", async () => {
    const filing = createFiling({
      accessionNumber: "0000034088-26-000042",
      cik: "0000034088",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/0000034088-26-000042-index.htm",
    });
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.endsWith("/index.json")) {
        return {
          data: {
            directory: {
              item: [
                {
                  name: "xom-20260501.xml",
                  type: "XML",
                },
                {
                  name: "xom-ex991.htm",
                  type: "EX-99.1",
                },
                {
                  name: "primary-8k.htm",
                  type: "8-K",
                },
              ],
            },
          },
        };
      }

      return {
        data: "<html>earnings release</html>",
      };
    });
    const dependencies = {
      getWithRetryFn,
      logger,
    } as Parameters<typeof loadSecFilingDetails>[1];

    const details = await loadSecFilingDetails(filing, dependencies);

    expect(details).toEqual({
      documentUrl: "https://www.sec.gov/Archives/edgar/data/34088/000003408826000042/xom-ex991.htm",
      html: "<html>earnings release</html>",
    });
  });

  test("selects real SEC earnings HTML before wrappers, images, and XBRL reports", async () => {
    const filing = createFiling({
      accessionNumber: "0000034088-26-000065",
      cik: "0000034088",
    });
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.endsWith("/index.json")) {
        return {
          data: {
            directory: {
              item: [
                {
                  name: "0000034088-26-000065-index-headers.html",
                  type: "text.gif",
                },
                {
                  name: "0000034088-26-000065-index.html",
                  type: "text.gif",
                },
                {
                  name: "0000034088-26-000065.txt",
                  type: "text.gif",
                },
                {
                  name: "a1q26earningswaterfallsqte.jpg",
                  type: "image2.gif",
                },
                {
                  name: "R1.htm",
                  type: "text.gif",
                },
                {
                  name: "xom-20260501.htm",
                  type: "text.gif",
                },
                {
                  name: "livef8k1q26991.htm",
                  type: "text.gif",
                },
                {
                  name: "livef8k1q26992.htm",
                  type: "text.gif",
                },
              ],
            },
          },
        };
      }

      return {
        data: "<html>xom earnings release</html>",
      };
    });
    const dependencies = {
      getWithRetryFn,
      logger,
    } as Parameters<typeof loadSecFilingDetails>[1];

    const details = await loadSecFilingDetails(filing, dependencies);

    expect(details).toEqual({
      documentUrl: "https://www.sec.gov/Archives/edgar/data/34088/000003408826000065/livef8k1q26991.htm",
      html: "<html>xom earnings release</html>",
    });
  });

  test("does not use a complete submission file when an image-only exhibit is unusable", async () => {
    const filing = createFiling({
      accessionNumber: "0001628280-26-059271",
      cik: "0001820953",
    });
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.endsWith("/index.json")) {
        return {
          data: {
            directory: {
              item: [
                {name: "affirmfq426shareholderle.htm", type: "EX-99.1"},
                {name: "afrm-20260825.htm", type: "8-K"},
                {name: "0001628280-26-059271.txt", type: "text.gif"},
              ],
            },
          },
        };
      }

      if (url.endsWith(".txt")) {
        return {data: "Quarterly revenue and unrelated $4.00 compensation metadata"};
      }

      return {data: "<html><img src='shareholder-letter-page.jpg'></html>"};
    });
    const dependencies = {
      getWithRetryFn,
      logger,
    } as Parameters<typeof loadSecFilingDetails>[1];

    const details = await loadSecFilingDetails(filing, dependencies, {
      isUsableDocument: html => html.includes("Quarterly revenue"),
    });

    expect(details.documentUrl).toContain("affirmfq426shareholderle.htm");
    expect(getWithRetryFn).not.toHaveBeenCalledWith(
      expect.stringContaining("0001628280-26-059271.txt"),
      expect.anything(),
    );
  });

  test("falls back from an empty 99.1 stub to a usable shareholder letter exhibit", async () => {
    const filing = createFiling({
      accessionNumber: "0001973239-26-000062",
      cik: "0001973239",
      form: "6-K",
      items: [],
    });
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.endsWith("/index.json")) {
        return {
          data: {
            directory: {
              item: [
                {
                  name: "arm-20260506.htm",
                  type: "text.gif",
                },
                {
                  name: "exhibit991fye26q431-marx26.htm",
                  type: "text.gif",
                },
                {
                  name: "exhibit992fye26q431-marx26.htm",
                  type: "text.gif",
                },
              ],
            },
          },
        };
      }

      if (url.endsWith("/exhibit991fye26q431-marx26.htm")) {
        return {
          data: "<html><body><h1>Arm Holdings plc Reports Results</h1></body></html>",
        };
      }

      if (url.endsWith("/exhibit992fye26q431-marx26.htm")) {
        return {
          data: "<html><body><h1>Q4 FYE26 Financial Overview</h1><p>Total revenue increased to $1,490 million.</p></body></html>",
        };
      }

      return {
        data: "<html><body>Form 6-K wrapper</body></html>",
      };
    });
    const dependencies = {
      getWithRetryFn,
      logger,
    } as Parameters<typeof loadSecFilingDetails>[1];

    const details = await loadSecFilingDetails(filing, dependencies, {
      isUsableDocument: html => html.includes("Total revenue"),
    });

    expect(details).toEqual({
      documentUrl: "https://www.sec.gov/Archives/edgar/data/1973239/000197323926000062/exhibit992fye26q431-marx26.htm",
      html: "<html><body><h1>Q4 FYE26 Financial Overview</h1><p>Total revenue increased to $1,490 million.</p></body></html>",
    });
    expect(getWithRetryFn).toHaveBeenCalledWith(
      "https://www.sec.gov/Archives/edgar/data/1973239/000197323926000062/exhibit991fye26q431-marx26.htm",
      expect.objectContaining({
        responseType: "text",
      }),
    );
  });

  test("content-scores generic exhibits so the earnings release beats financial statements", async () => {
    const filing = createFiling({
      accessionNumber: "0001437749-26-029554",
      cik: "0001690639",
      form: "6-K",
      items: [],
    });
    const statements = "<html><h1>Consolidated Financial Statements</h1><p>Revenue C$38.8 million</p></html>";
    const pressRelease = [
      "<html><h1>VersaBank Reports Third Quarter Fiscal 2026 Results</h1>",
      "<p>Revenue C$38.8 million. Net income C$10.1 million.",
      "Earnings per share C$0.31. Adjusted earnings per share C$0.38.</p></html>",
    ].join("");
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.endsWith("/index.json")) {
        return {
          data: {
            directory: {
              item: [
                {name: "ex_1009993.htm", type: "text.gif"},
                {name: "ex_1010554.htm", type: "text.gif"},
              ],
            },
          },
        };
      }

      return {data: url.endsWith("/ex_1010554.htm") ? pressRelease : statements};
    });
    const dependencies = {
      getWithRetryFn,
      logger,
    } as Parameters<typeof loadSecFilingDetails>[1];

    const details = await loadSecFilingDetails(filing, dependencies, {
      getDocumentScore: html => (html.includes("Reports") ? 40 : 10),
      isUsableDocument: html => html.includes("Revenue"),
    });

    expect(details).toEqual({
      documentUrl: "https://www.sec.gov/Archives/edgar/data/1690639/000143774926029554/ex_1010554.htm",
      html: pressRelease,
    });
  });

  test("selects a usable press release ahead of an MD&A with later-quarter guidance", async () => {
    const filing = createFiling({
      accessionNumber: "0001858985-26-000018",
      cik: "0001858985",
      form: "6-K",
      items: [],
    });
    const pressRelease = `
      <h1>On Reports Results</h1>
      <p>Key metrics for the three-month period ended June 30, 2026 include:</p>
      <p>Net sales increased to CHF 850.3 million.</p>
    `;
    const managementDiscussion = `
      <h1>Management Discussion and Analysis</h1>
      <p>Net sales for the three-month period ended June 30, 2026 were CHF 850.3 million.</p>
      <p>For the third quarter of 2026, management expects continued growth.</p>
    `;
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.endsWith("/index.json")) {
        return {
          data: {
            directory: {
              item: [
                {name: "a26q2-exhibit992xmda.htm", type: "text.gif"},
                {name: "a26q2-ex993xpressrelease.htm", type: "text.gif"},
              ],
            },
          },
        };
      }

      return {
        data: url.endsWith("/a26q2-ex993xpressrelease.htm")
          ? pressRelease
          : managementDiscussion,
      };
    });
    const dependencies = {
      getWithRetryFn,
      logger,
    } as Parameters<typeof loadSecFilingDetails>[1];

    const details = await loadSecFilingDetails(filing, dependencies, {
      isUsableDocument: html => {
        const parsedDocument = parseEarningsDocument(html);
        return undefined !== parsedDocument.quarterLabel && 0 < parsedDocument.metrics.length;
      },
    });

    expect(details).toEqual({
      documentUrl: "https://www.sec.gov/Archives/edgar/data/1858985/000185898526000018/a26q2-ex993xpressrelease.htm",
      html: pressRelease,
    });
    expect(getWithRetryFn).not.toHaveBeenCalledWith(
      expect.stringContaining("a26q2-exhibit992xmda.htm"),
      expect.anything(),
    );
  });

  test("selects underscore exhibit 99.1 filenames before primary 8-K HTML", async () => {
    const filing = createFiling({
      accessionNumber: "0001104659-26-052145",
      cik: "0001571949",
    });
    getWithRetryFn.mockImplementation(async (url: string) => {
      if (url.endsWith("/index.json")) {
        return {
          data: {
            directory: {
              item: [
                {
                  name: "tm2612824d1_8k.htm",
                  type: "text.gif",
                },
                {
                  name: "tm2612824d1_ex99-1.htm",
                  type: "text.gif",
                },
              ],
            },
          },
        };
      }

      return {
        data: "<html>ice earnings release</html>",
      };
    });
    const dependencies = {
      getWithRetryFn,
      logger,
    } as Parameters<typeof loadSecFilingDetails>[1];

    const details = await loadSecFilingDetails(filing, dependencies);

    expect(details).toEqual({
      documentUrl: "https://www.sec.gov/Archives/edgar/data/1571949/000110465926052145/tm2612824d1_ex99-1.htm",
      html: "<html>ice earnings release</html>",
    });
  });

  test("falls back to filing URL when archive index has no content document", async () => {
    const filing = createFiling();
    getWithRetryFn.mockResolvedValue({
      data: {
        directory: {
          item: {
            name: "metadata.json",
            type: "JSON",
          },
        },
      },
    });
    const dependencies = {
      getWithRetryFn,
      logger,
    } as Parameters<typeof loadSecFilingDetails>[1];

    await expect(loadSecFilingDetails(filing, dependencies)).resolves.toEqual({
      documentUrl: filing.filingUrl,
      html: "",
    });
  });
});

function createFiling(overrides: Partial<SecCurrentFiling> = {}): SecCurrentFiling {
  return {
    accessionNumber: "0000000001-26-000001",
    cik: "0000000001",
    filingUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/index.htm",
    form: "8-K",
    items: ["2.02"],
    title: "8-K",
    updated: "2026-05-01T10:01:00-04:00",
    ...overrides,
  };
}
