import {
  isLikelyEarningsFiling,
  parseSecCurrentFilingsAtom,
} from "./earnings-results-sec.js";

describe("SEC earnings result source", () => {
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
    expect(isLikelyEarningsFiling(filings[0])).toBe(true);
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
  });
});
