import {beforeEach, describe, expect, test, vi} from "vitest";
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
