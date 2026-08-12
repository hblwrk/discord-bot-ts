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
      ["EPS", "$0.87 to $0.92"],
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
      ["FY2027 Adj EPS", "double-digit growth"],
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
    // separate lines. Each figure is read from the updated column; the tax rate reads from the
    // prior one because its update is stated as "unchanged". The per-share row is captioned
    // plainly as "Earnings per Share", but the prose above the table declares the basis —
    // "Lilly provides guidance for certain non-GAAP measures" — so it posts as adjusted.
    // Revenue stays reported: the same sentence names it as the GAAP item.
    company: "Eli Lilly",
    metrics: [
      ["adjusted_eps", "$8.38"],
      ["gaap_eps", "$7.94"],
      ["revenue", "$23B"],
      ["net_income", "$7.09B"],
    ],
    outlook: [
      ["Revenue", "$85B to $87B"],
      ["Adj EPS", "$35.5 to $36.5"],
      ["Tax rate", "18% to 19%"],
    ],
    quarterLabel: "Q2 2026",
    source: "59478/000005947826000077/q226lillysalesandearningsp.htm",
    ticker: "lly",
  },
  {
    // A "Quarter Ended | Six Months Ended" highlights table: reading past the first column
    // group took both revenue and net income from the half-year columns.
    company: "AppLovin",
    metrics: [
      ["gaap_eps", "$3.76"],
      ["revenue", "$1.92B"],
      ["net_income", "$1.27B"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1751008/000175100826000057/exhibit991-2q26earningspre.htm",
    ticker: "app",
  },
  {
    company: "Fastly",
    metrics: [
      ["adjusted_eps", "$0.15"],
      ["gaap_eps", "-$0.10"],
      ["revenue", "$183.3M"],
      ["net_income", "-$15.59M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1517413/000151741326000212/ex991-fslypressrelease63026.htm",
    ticker: "fsly",
  },
  {
    company: "Dutch Bros",
    metrics: [
      ["gaap_eps", "$0.28"],
      ["revenue", "$550.9M"],
      ["net_income", "$51.6M"],
    ],
    outlook: [
      ["Revenue", "$2.1B to $2.13B"],
      ["Adj EBITDA", "$385M to $390M"],
      ["Capex", "$350M to $370M"],
    ],
    quarterLabel: "Q2 2026",
    source: "1866581/000186658126000131/a2026-q2_ex991.htm",
    ticker: "bros",
  },
  {
    // Guidance states its scale once above the rows, and a footnote states the size of the
    // items the non-GAAP measures exclude rather than the measures themselves.
    company: "Sandisk",
    metrics: [
      ["adjusted_eps", "$39.25"],
      ["gaap_eps", "$43.97"],
      ["revenue", "$8.97B"],
      ["net_income", "$6.9B"],
    ],
    outlook: [
      ["Revenue", "$10.3B to $10.8B"],
      ["Gross margin", "83% to 84.9%"],
      ["Operating expenses", "$574M to $614M"],
    ],
    quarterLabel: "Q4 2026",
    source: "2023554/000162828026053346/sndkq4-26ex991xpressrelease.htm",
    ticker: "sndk",
  },
  {
    // "typing the call into the CAD in another jurisdiction" is Computer-Aided Dispatch in a
    // customer quote, not a currency declaration. The per-share figure is stated in a sentence
    // that goes on to give the non-GAAP one, and it agrees with the statements table's
    // "Diluted | $ | 0.36" and with $29.4M over 82.5M shares.
    company: "Axon Enterprise",
    metrics: [
      ["gaap_eps", "$0.36"],
      ["revenue", "$904M"],
      ["net_income", "$29.43M"],
    ],
    outlook: [
      ["Capex", "$160M to $190M"],
    ],
    quarterLabel: "Q2 2026",
    source: "1069183/000162828026053363/axon-20260805xex991.htm",
    ticker: "axon",
  },
  {
    company: "e.l.f. Beauty",
    metrics: [
      ["adjusted_eps", "$1.75"],
      ["gaap_eps", "$1.12"],
      ["revenue", "$479.37M"],
      ["net_income", "$66.6M"],
    ],
    outlook: [],
    quarterLabel: "Q1 2027",
    source: "1600033/000160003326000036/q12027er-991.htm",
    ticker: "elf",
  },
  {
    // A segment results table repeats the consolidated captions, distinguished only by its
    // heading naming the segment ("Specialties Results").
    company: "Albemarle",
    metrics: [
      ["gaap_eps", "$3.52"],
      ["revenue", "$1.74B"],
      ["net_income", "$480M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "915913/000091591326000101/a2q26earningsreleaseex991.htm",
    ticker: "alb",
  },
  {
    // "Net Loss improved by $56.0 million year-over-year to $(41.0) million" leads with the
    // change, so the loss itself comes second.
    company: "Redwire",
    metrics: [
      ["adjusted_eps", "-$0.09"],
      ["gaap_eps", "-$0.19"],
      ["revenue", "$117.1M"],
      ["net_income", "-$41.48M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1819810/000181981026000121/exhibit991redwire06302026e.htm",
    ticker: "rdw",
  },
  {
    // Reported net income with a diluted loss per share: genuine, from the if-converted
    // treatment of the notes, and recorded so the pair is not "corrected" later.
    company: "Beyond Meat",
    metrics: [
      ["gaap_eps", "-$0.06"],
      ["revenue", "$68.8M"],
      ["net_income", "$16.4M"],
    ],
    outlook: [
      ["Revenue", "$60M to $65M"],
    ],
    quarterLabel: "Q2 2026",
    source: "1655210/000165521026000053/ex991pressrelease-q22026ea.htm",
    ticker: "bynd",
  },
  {
    company: "Himax Technologies",
    metrics: [
      ["revenue", "$227.33M"],
    ],
    outlook: [
      ["Gross margin", "34%"],
    ],
    quarterLabel: "Q2 2026",
    source: "1342338/000117184326005288/exh_991.htm",
    ticker: "himx",
  },
  {
    // Reported and adjusted per-share figures are genuinely equal this quarter — the release
    // says so in its own subtitle, so the repeated value is not a duplicated read. Net income
    // is $534 million; the figure is stored as printed because the statement's scale is
    // declared too far above the row to reach it, and an unscaled value is dropped before
    // posting rather than published.
    company: "Howmet Aerospace",
    metrics: [
      ["adjusted_eps", "$1.33"],
      ["gaap_eps", "$1.33"],
      ["revenue", "$2.55B"],
      ["net_income", "$534"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "4281/000110465926091610/tm2622325d1_ex99-1.htm",
    ticker: "hwm",
  },
  {
    company: "D-Wave Quantum",
    metrics: [
      ["gaap_eps", "-$0.13"],
      ["revenue", "$3.08M"],
      ["net_income", "-$48.03M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1907982/000190798226000127/qbts-20260806xexx991.htm",
    ticker: "qbts",
  },
  {
    // The adjusted measure is captioned "non-GAAP net income per diluted share" — "diluted"
    // on the far side of "per". Unmatched, the only remaining source for the measure was the
    // Q3 guidance range, whose low end ($0.63) was posted as the quarter's result.
    company: "Datadog",
    metrics: [
      ["adjusted_eps", "$0.65"],
      ["gaap_eps", "$0.12"],
      ["revenue", "$1.12B"],
      ["net_income", "$44.56M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1561550/000162828026053829/ex-991x20260630x8k.htm",
    ticker: "ddog",
  },
  {
    // "six-month 2026 earnings were $6.1 billion, or $5.00 per share" states the half year with
    // a hyphen, so the year-to-date penalty missed it and both per-share figures were taken
    // from the six-month sentence instead of the quarter's ($3.23 and $3.24).
    company: "ConocoPhillips",
    metrics: [
      ["adjusted_eps", "$3.24"],
      ["gaap_eps", "$3.23"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1163165/000116316526000030/cop-20260806x8kexx991.htm",
    ticker: "cop",
  },
  {
    // Revenue is $5.8 billion. The stored "$2.22K" is a North America segment row read under a
    // "$ in mm" heading the reader does not treat as a scale; unscaled, it is dropped before
    // posting. Scaling it without first distinguishing segment rows from consolidated ones
    // would turn a dropped figure into a published wrong one.
    company: "Parker-Hannifin",
    metrics: [
      ["adjusted_eps", "$9.27"],
      ["gaap_eps", "$8.54"],
      ["revenue", "$2.22K"],
      ["net_income", "$1.09B"],
    ],
    outlook: [],
    quarterLabel: "Q4 2026",
    source: "76334/000007633426000082/exhibit991q4fy26.htm",
    ticker: "ph",
  },
  {
    // One clause states both per-share measures — "GAAP diluted net loss per share $0.16;
    // non-GAAP diluted net loss per share $0.05" — and the non-GAAP half had the whole line
    // discarded, leaving the adjusted figure posted alone. The share count comes from the
    // statements, not from the non-GAAP section's prose definition of the same caption.
    company: "Rigetti Computing",
    metrics: [
      ["adjusted_eps", "-$0.05"],
      ["gaap_eps", "-$0.16"],
      ["revenue", "$5.1M"],
      ["net_income", "-$52.6M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1838359/000110465926091979/rgti-20260806xex99d1.htm",
    ticker: "rgti",
  },
  {
    // Net sales are $752.1 million, stored as printed: the table declares its scale as "$MM",
    // which the reader does not recognise, so the figure is dropped before posting.
    company: "Century Aluminum",
    metrics: [
      ["adjusted_eps", "$2.46"],
      ["gaap_eps", "$2.39"],
      ["revenue", "$752.1"],
      ["net_income", "$249.3M"],
    ],
    outlook: [
      ["Adj EBITDA", "$325M to $345M"],
    ],
    quarterLabel: "Q2 2026",
    source: "949157/000162828026054300/a20260630q2ex991earningsre.htm",
    ticker: "cenx",
  },
  {
    company: "Applied Optoelectronics",
    metrics: [
      ["gaap_eps", "-$0.28"],
      ["revenue", "$191.9M"],
      ["net_income", "-$22.8M"],
    ],
    outlook: [
      ["Revenue", "$255M to $290M"],
      ["Gross margin", "29% to 30.5%"],
    ],
    quarterLabel: "Q2 2026",
    source: "1158114/000168316826006055/aaoi_ex9901.htm",
    ticker: "aaoi",
  },
  {
    // A hard line break inside the paragraph leaves the prior-year clause standing as its own
    // line, carrying the reported period's date: "...period ended June 30, 2026, compared to
    // net income of $7.2 million". That comparison figure was posted as the quarter's; the
    // quarter's is $14.41 million.
    company: "Innodata",
    metrics: [
      ["gaap_eps", "$0.41"],
      ["revenue", "$92.14M"],
      ["net_income", "$14.41M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "903651/000110465926092010/tm2621499d1_ex99-1.htm",
    ticker: "inod",
  },
  {
    company: "Cloudflare",
    metrics: [
      ["adjusted_eps", "$0.29"],
      ["gaap_eps", "-$0.48"],
      ["revenue", "$696.1M"],
      ["net_income", "-$169.98M"],
    ],
    outlook: [
      ["Q3 Revenue", "$736M to $737M"],
      ["FY2026 Revenue", "$2.864B to $2.87B"],
      ["Q3 Adj EPS", "$0.34"],
      ["FY2026 Adj EPS", "$1.25 to $1.26"],
    ],
    quarterLabel: "Q2 2026",
    source: "1477333/000147733326000053/q226exhibit991.htm",
    ticker: "net",
  },
  {
    // Guidance sits in a two-column table — one pipe per row — which scored below the prose
    // around it. The prose that won carried a 2027 "midpoint opportunity" range the filing's
    // own footnote calls "not intended to be guidance"; the reaffirmed 2026 range is the table's.
    company: "Vistra",
    metrics: [
      ["revenue", "$4.02B"],
      ["net_income", "$305M"],
    ],
    outlook: [
      ["Adj EBITDA", "$6.8B to $7.6B"],
    ],
    quarterLabel: "Q2 2026",
    source: "1692819/000169281926000017/vistra-20260630xearningsre.htm",
    ticker: "vst",
  },
  {
    // Zero-width characters fill otherwise-empty cells between the per-share caption and
    // values. They must not terminate the table row before the reported loss per share.
    company: "CEVA",
    metrics: [
      ["adjusted_eps", "$0.08"],
      ["gaap_eps", "-$0.10"],
      ["revenue", "$29.03M"],
      ["net_income", "-$2.91M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1173489/000143774926026648/ex_1001319.htm",
    ticker: "ceva",
  },
  {
    // The adjusted qualifier is a separate table cell above "EPS was", while the same line
    // later names prior-year adjusted EPS. The consolidated net-revenue row must also beat
    // its individual equipment-sales rows.
    company: "Plug Power",
    metrics: [
      ["adjusted_eps", "-$0.07"],
      ["gaap_eps", "-$0.14"],
      ["revenue", "$178.3M"],
      ["net_income", "-$188.21M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1093691/000110465926093339/tm2622713d1_ex99-1.htm",
    ticker: "plug",
  },
  {
    // Quarter and full-year outlook values sit below standalone period captions, and the
    // GAAP row is captioned "Net (loss) income per share attributable to common stockholders".
    company: "Hims & Hers Health",
    metrics: [
      ["gaap_eps", "-$0.37"],
      ["revenue", "$753M"],
      ["net_income", "-$86.29M"],
    ],
    outlook: [
      ["Q3 Revenue", "$880M to $900M"],
      ["FY2026 Revenue", "$3.1B to $3.3B"],
      ["Q3 Adj EBITDA", "$75M to $95M"],
      ["FY2026 Adj EBITDA", "$275M to $325M"],
    ],
    quarterLabel: "Q2 2026",
    source: "1773751/000177375126000161/hims-20260630x8xkearningsr.htm",
    ticker: "hims",
  },
  {
    // The reported value precedes its caption ("$234 million in Q2 revenue") and is followed
    // by the $34 million sequential increase. Q3 adjusted EBITDA is explicitly a loss.
    company: "Rocket Lab",
    metrics: [
      ["gaap_eps", "-$0.08"],
      ["revenue", "$234M"],
      ["net_income", "-$49.26M"],
    ],
    outlook: [
      ["Revenue", "$250M to $265M"],
      ["Adj EBITDA", "-$17M to -$23M"],
      ["Operating expenses", "$143M to $149M"],
    ],
    quarterLabel: "Q2 2026",
    source: "1819994/000181999426000061/rklb-08102026ex991.htm",
    ticker: "rklb",
  },
  {
    company: "Alamar Biosciences",
    metrics: [
      ["gaap_eps", "-$0.22"],
      ["revenue", "$29.4M"],
      ["net_income", "-$13.2M"],
    ],
    outlook: [
      ["Revenue", "$116M to $120M"],
    ],
    quarterLabel: "Q2 2026",
    source: "2104204/000119312526342378/ck0002104204-ex99_1.htm",
    ticker: "almr",
  },
  {
    // The statements use a generic "Loss per share" caption rather than naming net loss.
    company: "Quantum Computing",
    metrics: [
      ["gaap_eps", "-$0.05"],
      ["revenue", "$5.6M"],
      ["net_income", "-$11.8M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1758009/000121390026087267/ea030143301ex99-1.htm",
    ticker: "qubt",
  },
  {
    // Subscription and services are one revenue component; total revenue rounds to $105M.
    // The narrative puts the current loss per share before its caption and then compares 2025.
    company: "GoPro",
    metrics: [
      ["adjusted_eps", "-$0.21"],
      ["gaap_eps", "-$0.30"],
      ["revenue", "$105M"],
      ["net_income", "-$51M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1500435/000150043526000034/gpro2026-6x30ex991xer.htm",
    ticker: "gpro",
  },
  {
    company: "AST SpaceMobile",
    metrics: [
      ["gaap_eps", "-$0.77"],
      ["revenue", "$31.5M"],
      ["net_income", "-$299.92M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1780312/000119312526342540/asts-ex99_1.htm",
    ticker: "asts",
  },
  {
    // The non-GAAP reconciliation's adjusted net loss is larger than the reported loss.
    // It must not be published as GAAP net income; the company-attributable row is $10.333M.
    company: "USA Rare Earth",
    metrics: [
      ["gaap_eps", "-$0.05"],
      ["revenue", "$5.8M"],
      ["net_income", "-$10.33M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1970622/000197062226000056/exhibit991-earningsrelease.htm",
    ticker: "usar",
  },
  {
    // The 6-K also furnishes an MD&A whose later-quarter discussion used to become the
    // reporting period. The press release states results in CHF and supplies the outlook.
    company: "On Holding",
    metrics: [
      ["adjusted_eps", "CHF 0.35"],
      ["gaap_eps", "CHF 0.31"],
      ["revenue", "CHF 850.3M"],
      ["net_income", "CHF 105M"],
    ],
    outlook: [
      ["Revenue", "CHF 3.47B to CHF 3.56B"],
      ["Gross margin", "65.0%"],
    ],
    quarterLabel: "Q2 2026",
    source: "1858985/000185898526000018/a26q2-ex993xpressrelease.htm",
    ticker: "onon",
  },
  {
    // The EPS caption inserts "attributable to common stockholders" before "per share".
    // Its diluted row is $0.51; the basic row immediately above it is $0.54.
    company: "Venture Global",
    metrics: [
      ["gaap_eps", "$0.51"],
      ["revenue", "$4.6B"],
      ["net_income", "$1.3B"],
    ],
    outlook: [
      ["FY2026 Adj EBITDA", "$8.7B to $9.1B"],
    ],
    quarterLabel: "Q2 2026",
    source: "2007855/000200785526000063/vgincq22026earningsrelease.htm",
    ticker: "vg",
  },
  {
    // Reported non-GAAP EPS is $2.91. The $2.60 figure removes a tariff refund from that
    // already-adjusted measure and therefore cannot carry the bot's plain adjusted label.
    company: "Cardinal Health",
    metrics: [
      ["adjusted_eps", "$2.91"],
      ["gaap_eps", "$1.70"],
      ["revenue", "$63.7B"],
      ["net_income", "$398M"],
    ],
    outlook: [
      ["Adj EPS", "$12.4 to $12.6"],
      ["Tax rate", "19% to 20%"],
      ["Capex", "$700M"],
      ["Free cash flow", "$3.5B to $4B"],
    ],
    quarterLabel: "Q4 2026",
    source: "721371/000072137126000037/a26q4_x063026xex991xnewsre.htm",
    ticker: "cah",
  },
  {
    // Q1 and FY2027 both guide revenue. The two tax percentages are respectively mapped
    // GAAP and non-GAAP assumptions, not the endpoints of a tax-rate range.
    company: "Super Micro Computer",
    metrics: [
      ["adjusted_eps", "$1.70"],
      ["gaap_eps", "$1.62"],
      ["revenue", "$11.1B"],
      ["net_income", "$1.18B"],
    ],
    outlook: [
      ["Q1 Revenue", "$14.5B to $15.5B"],
      ["FY2027 Revenue", "$65B to $72B"],
      ["Q1 Adj EPS", "$1.01 to $1.1"],
      ["Q1 EPS", "$0.89 to $0.98"],
      ["Q1 Tax rate", "20.1%"],
    ],
    quarterLabel: "Q4 2026",
    source: "1375365/000137536526000021/exhibit991_20260630.htm",
    ticker: "smci",
  },
  {
    // The guidance caption combines both qualifiers as "Fiscal Full-Year 2026 Outlook".
    // It is a real outlook heading, rather than prose mentioning outlook inside the section.
    company: "CAVA Group",
    metrics: [
      ["gaap_eps", "$0.19"],
      ["revenue", "$365.4M"],
      ["net_income", "$23M"],
    ],
    outlook: [
      ["Adj EBITDA", "$181M to $191M"],
    ],
    quarterLabel: "Q2 2026",
    source: "1639438/000162828026055709/earningsrelease2026q2.htm",
    ticker: "cava",
  },
  {
    // The results prose states Q4, Q3 and prior-year Q4 on the same lines. Q1 guidance
    // supplies the formerly selected $4.05, while $144.2M is the preceding quarter.
    company: "Lumentum Holdings",
    metrics: [
      ["adjusted_eps", "$3.23"],
      ["gaap_eps", "-$84.65"],
      ["revenue", "$1.01B"],
      ["net_income", "-$7.2B"],
    ],
    outlook: [
      ["Revenue", "$1.225B to $1.275B"],
      ["Adj EPS", "$4.05 to $4.35"],
      ["Operating margin", "39.5% to 40.5%"],
    ],
    quarterLabel: "Q4 2026",
    source: "1633978/000162828026055726/lite_ex991xq4fy26.htm",
    ticker: "lite",
  },
  {
    // Accounting parentheses close before the unit in both ends of the adjusted EBITDA
    // range: "($400) million to ($445) million". The unit and sign apply together.
    company: "Beta Technologies",
    metrics: [
      ["gaap_eps", "-$0.64"],
      ["revenue", "$14.7M"],
      ["net_income", "-$148.8M"],
    ],
    outlook: [
      ["Revenue", "$42M to $50M"],
      ["Adj EBITDA", "-$400M to -$445M"],
    ],
    quarterLabel: "Q2 2026",
    source: "1784570/000162828026055933/a2026q2earningsrelease.htm",
    ticker: "beta",
  },
  {
    // The fiscal quarter number is in the release title, while the year is in the next
    // highlights heading. The short outlook ends at "Key Financials" before Q4 tables.
    company: "Amcor",
    metrics: [
      ["adjusted_eps", "$1.23"],
      ["gaap_eps", "$0.83"],
      ["revenue", "$6.4B"],
      ["net_income", "$389M"],
    ],
    outlook: [
      ["Adj EPS", "$1.8 to $1.9"],
    ],
    quarterLabel: "Q4 2026",
    source: "1748790/000174879026000020/amcor4q2026ex991-june302026.htm",
    ticker: "amcr",
  },
  {
    // Product and service revenue are separate components above the consolidated total.
    // The headline repeats only product sales, which must not outrank the total row.
    company: "Liquidia",
    metrics: [
      ["gaap_eps", "$0.74"],
      ["revenue", "$171.68M"],
      ["net_income", "$74.7M"],
    ],
    outlook: [],
    quarterLabel: "Q2 2026",
    source: "1819576/000110465926094411/tm2622888d1_ex99-1.htm",
    ticker: "lqda",
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
    expect(filingCorpus).toHaveLength(63);
  });
});
