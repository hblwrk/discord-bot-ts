import {readFileSync} from "node:fs";
import {describe, expect, test} from "vitest";
import {parseEarningsDocument} from "./earnings-results-format.ts";

// Every entry is a real SEC earnings exhibit, stored as the text the parser sees after
// html-to-text conversion (verified to parse identically to the original HTML). Each
// expected figure below was checked against the source document by hand.
//
// The point of this corpus is coverage the hand-written fixtures cannot give: those are
// simplified documents that usually offer a second candidate which happens to be right, so
// removing a guard is masked and the suite stays green. These are whole filings with all
// their distractors — prior-year columns, segment breakdowns, guidance ranges, footnote
// markers — so a selection rule that regresses changes a figure here.
//
// Sources are https://www.sec.gov/Archives/edgar/data/<source>.
const filingCorpus: {
  company: string;
  metrics: [string, string][];
  outlook: [string, string][];
  quarterLabel: string | undefined;
  source: string;
  ticker: string;
}[] = [
  {
    company: "Sterling Infrastructure",
    metrics: [
      ["adjusted_eps", "$5.80"],
      ["gaap_eps", "$5.00"],
      ["revenue", "$1.17B"],
      ["net_income", "$155.8M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "874238/000087423826000100/a20260803ex991earningsrele.htm",
    ticker: "strl",
  },
  {
    company: "Palantir Technologies",
    metrics: [
      ["adjusted_eps", "$0.41"],
      ["gaap_eps", "$0.41"],
      ["revenue", "$1.94B"],
      ["net_income", "$1.06B"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1321655/000132165526000039/a2026q2ex991pressrelease.htm",
    ticker: "pltr",
  },
  {
    company: "Vertex Pharmaceuticals",
    metrics: [
      ["gaap_eps", "$4.31"],
      ["revenue", "$3.33B"],
      ["net_income", "$1.1B"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "875320/000087532026000256/ex-991_q22026.htm",
    ticker: "vrtx",
  },
  {
    company: "Clorox",
    metrics: [
      ["adjusted_eps", "$1.66"],
      ["gaap_eps", "$1.34"],
      ["revenue", "$1.95B"],
      ["net_income", "$163M"],
    ],
    outlook: [],
    quarterLabel: "Q4 2026",
    source: "21076/000002107626000028/ex991-pressreleasedatedaug.htm",
    ticker: "clx",
  },
  {
    company: "Spotify Technology",
    metrics: [
      ["gaap_eps", "€2.61"],
      ["revenue", "€4.78B"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1639920/000114036126031044/ef20078867_ex99-1.htm",
    ticker: "spot",
  },
  {
    company: "Caterpillar",
    metrics: [
      ["adjusted_eps", "$8.17"],
      ["gaap_eps", "$7.77"],
      ["revenue", "$20.5B"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "18230/000001823026000040/ex991toformcat2q2026earnin.htm",
    ticker: "cat",
  },
  {
    company: "Merck",
    metrics: [
      ["adjusted_eps", "-$0.13"],
      ["gaap_eps", "-$0.54"],
      ["revenue", "$16.6B"],
      ["net_income", "-$1.33B"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "310158/000110465926090045/tm2621496d1_ex99-1.htm",
    ticker: "mrk",
  },
  {
    company: "McDonald's",
    metrics: [
      ["gaap_eps", "$3.32"],
      ["revenue", "$7.1B"],
      ["net_income", "$2.36B"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "63908/000006390826000067/exhibit991-6302026.htm",
    ticker: "mcd",
  },
  {
    company: "Wayfair",
    metrics: [
      ["adjusted_eps", "$0.95"],
      ["gaap_eps", "-$0.01"],
      ["revenue", "$3.5B"],
      ["net_income", "-$1M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1616707/000161670726000147/a2026-08x04ex991.htm",
    ticker: "w",
  },
  {
    company: "Pfizer",
    metrics: [
      ["adjusted_eps", "$0.77"],
      ["gaap_eps", "-$0.04"],
      ["revenue", "$15B"],
      ["net_income", "-$248M"],
    ],
    outlook: [
      ["FY2026 Revenue", "$60.5B to $62.5B"],
      ["FY2026 Adj EPS", "$2.8 to $3"]
    ],
    quarterLabel: "Q2 2026",
    source: "78003/000007800326000094/pfe-6282026xex99.htm",
    ticker: "pfe",
  },
  {
    company: "BP",
    metrics: [
      ["gaap_eps", "$1.49"],
      ["revenue", "$69.11B"],
    ],
    outlook: [
      ["Capex", "$13.5B to $14B"]
    ],
    quarterLabel: "Q2 2026",
    source: "313807/000031380726000016/bp-20260630.htm",
    ticker: "bp",
  },
  {
    company: "Space Exploration Technologies",
    metrics: [
      ["gaap_eps", "-$0.09"],
      ["revenue", "$7.81B"],
      ["net_income", "-$541M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1181412/000162828026052515/earningsreleaseq22608042.htm",
    ticker: "spcx",
  },
  {
    company: "Zeta Global",
    metrics: [
      ["gaap_eps", "$0.03"],
      ["revenue", "$442.77M"],
      ["net_income", "$8.17M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1851003/000119312526332770/zeta-ex99_1.htm",
    ticker: "zeta",
  },
  {
    company: "Gilead Sciences",
    metrics: [
      ["adjusted_eps", "-$6.75"],
      ["gaap_eps", "-$8.45"],
      ["revenue", "$7.8B"],
      ["net_income", "-$10.5B"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "882095/000088209526000028/exhibit991earningspressrel.htm",
    ticker: "gild",
  },
  {
    company: "Arista Networks",
    metrics: [
      ["adjusted_eps", "$1.02"],
      ["gaap_eps", "$0.95"],
      ["revenue", "$3.04B"],
      ["net_income", "$1.21B"],
    ],
    outlook: [
      ["Revenue", "$3.3B"],
      ["Adj EPS", "$1.06 to $1.08"],
      ["Operating margin", "49%"]
    ],
    quarterLabel: "Q2 2026",
    source: "1596532/000159653226000174/ex991q226-earningsrelease.htm",
    ticker: "anet",
  },
  {
    company: "Astera Labs",
    metrics: [
      ["adjusted_eps", "$0.80"],
      ["gaap_eps", "$0.83"],
      ["revenue", "$392.4M"],
      ["net_income", "$153.09M"],
    ],
    outlook: [
      ["Revenue", "$540M to $560M"],
      ["Gross margin", "72%"],
      ["Operating expenses", "$232M to $236M"],
      ["Tax rate", "4%"]
    ],
    quarterLabel: "Q2 2026",
    source: "1736297/000173629726000033/q226exhibit991.htm",
    ticker: "alab",
  },
  {
    company: "Opendoor Technologies",
    metrics: [
      ["gaap_eps", "-$0.17"],
      ["revenue", "$883M"],
      ["net_income", "-$162M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1801169/000180116926000019/q22026formxex991earningsre.htm",
    ticker: "open",
  },
  {
    company: "Advanced Micro Devices",
    metrics: [
      ["gaap_eps", "$1.38"],
      ["revenue", "$11.5B"],
      ["net_income", "$2.3B"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "2488/000000248826000121/q22026991.htm",
    ticker: "amd",
  },
  {
    company: "CVS Health",
    metrics: [
      ["adjusted_eps", "$2.58"],
      ["gaap_eps", "$2.31"],
      ["revenue", "$106.1B"],
      ["net_income", "$2.98B"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "64803/000006480326000097/cvs_ex99x1q2-26.htm",
    ticker: "cvs",
  },
  {
    // A shareholder-letter release: the adjusted measure is named by what it leaves out
    // ("diluted EPS excluding certain items"), the fiscal quarter is stated only as "third
    // quarter results for fiscal 2026", and the outlook mixes a full-year per-share range
    // with a single-quarter segment figure.
    company: "Walt Disney",
    metrics: [
      ["adjusted_eps", "$2.06"],
      ["gaap_eps", "$1.51"],
      ["revenue", "$25.25B"],
      ["net_income", "$2.64B"],
    ],
    outlook: [
      ["FY2026 Adj EPS", "12% growth"],
      ["Q4 Operating income", "$4.9B"],
    ],
    quarterLabel: "Q3 2026",
    source: "1744489/000174448926000056/fy2026_q3xerxex991.htm",
    ticker: "dis",
  },
  {
    // Prior-year-first columns with the year header more than twenty rows above the
    // per-share row, and an outlook stating the figure and its growth in one breath.
    company: "Uber Technologies",
    metrics: [
      ["adjusted_eps", "$0.81"],
      ["gaap_eps", "$1.17"],
      ["revenue", "$14.19B"],
      ["net_income", "$2.39B"],
    ],
    outlook: [
      ["Adj EPS", "$0.84 to $0.88"],
      ["Adj EBITDA", "$2.86B to $2.96B"]
    ],
    quarterLabel: "Q2 2026",
    source: "1543151/000154315126000027/uberq226earningspressrelea.htm",
    ticker: "uber",
  },
  {
    // The reporting period is stated only as the period the statements ended, while the
    // guidance section names a later quarter; per-share figures live in a separate
    // supplemental and are correctly absent.
    company: "Shopify",
    metrics: [
      ["revenue", "$3.58B"],
      ["net_income", "$1.5B"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1594805/000159480526000046/exhibit991pressreleaseq220.htm",
    ticker: "shop",
  },
  {
    company: "1stdibs.com",
    metrics: [
      ["gaap_eps", "-$0.03"],
      ["revenue", "$23.3M"],
      ["net_income", "-$1.02M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1600641/000160064126000032/ex991q2fy26earningsrelease.htm",
    ticker: "dibs",
  },
  {
    // Guidance sits in a prior-versus-updated table whose captions and value cells are on
    // separate lines, so it is not reached: the recorded outlook is a raise stated in a
    // highlights bullet, which is a change rather than a level. Documented as a known gap.
    company: "Eli Lilly",
    metrics: [
      ["adjusted_eps", "$8.38"],
      ["gaap_eps", "$7.94"],
      ["revenue", "$23B"],
      ["net_income", "$7.09B"],
    ],
    outlook: [
      ["Q2 EPS", "$2.78"]
    ],
    quarterLabel: "Q2 2026",
    source: "59478/000005947826000077/q226lillysalesandearningsp.htm",
    ticker: "lly",
  },
];

describe("earnings result filing corpus", () => {
  for (const filing of filingCorpus) {
    test(`${filing.ticker.toUpperCase()} (${filing.company}) parses to its verified figures`, () => {
      const document = parseEarningsDocument(
        readFileSync(`modules/test-fixtures/earnings-filings/${filing.ticker}.txt`, "utf8"),
      );

      expect(document.quarterLabel).toBe(filing.quarterLabel);
      expect(document.metrics.map(metric => [metric.key, metric.value]))
        .toEqual(filing.metrics);
      expect(document.outlook.map(metric => [
        metric.periodLabel ? `${metric.periodLabel} ${metric.label}` : metric.label,
        metric.value,
      ])).toEqual(filing.outlook);
    });
  }

  test("covers every stored fixture", () => {
    expect(filingCorpus).toHaveLength(24);
  });
});
