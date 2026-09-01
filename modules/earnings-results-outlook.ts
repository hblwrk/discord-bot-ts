import {
  hasStandaloneFullYearPeriod,
  isDefinitionalLine,
} from "./earnings-results-format-selection.ts";
import {getMoneyScaleFromContextText} from "./earnings-results-money.ts";
import {gaapTermSource, hasStandaloneGaapTerm} from "./earnings-results-terms.ts";

export type EarningsOutlookMetric = {
  key: string;
  label: string;
  periodLabel?: string | undefined;
  sourceSnippet?: string | undefined;
  value: string;
};

type OutlookValueType = "eps" | "money" | "percent" | "text";

type OutlookMetricDefinition = {
  key: string;
  label: string;
  patterns: RegExp[];
  valueType: OutlookValueType;
};

type OutlookMetricCandidate = {
  metric: EarningsOutlookMetric;
  score: number;
};

type ParsedMoneyValue = {
  currencyCode: string;
  value: number;
};

type OutlookSection = {
  heading?: string | undefined;
  // A guidance table states its scale once, above the rows ("(in millions, except per share
  // amounts)"). Without it a row reading "$10,300 - $10,800" is published as $10.3K.
  moneyUnit?: string | undefined;
  lines: string[];
  mixedPeriods: boolean;
  // A guidance section states its basis once, in the prose above the table ("Lilly provides
  // guidance for certain non-GAAP measures"), and then captions its rows plainly — "Earnings
  // per Share", not "non-GAAP EPS". Under the reported label such a row understates the
  // guidance by whatever it excludes.
  nonGaapMeasures: boolean;
  // A guidance table headed "Prior | Updated" restates each figure twice. Its rows are the
  // guidance, so they are read rather than dismissed as a comparison table, and the updated
  // column is the one that now applies.
  revisedColumns: boolean;
  // A comparison table can put guidance in its first value column and historical results
  // after it. Those rows are safe to read, but only the first populated financial cell is
  // forward-looking.
  guidanceFirstColumns: boolean;
  // A low/high table places the two endpoints in separate cells without an inline range
  // separator. Both cells together are the guidance value.
  guidanceRangeColumns: boolean;
};

const moneyUnitPatternSource = String.raw`(?:trillions?|billions?|millions?|thousands?|tn|bn|mm|[tbmk])\b`;
// Some releases close accounting parentheses before the scale word — "($400) million" —
// while others put the scale inside them — "($400 million)". Treat both forms as one
// token so the scale and negative sign survive range parsing.
const moneyTokenPatternSource = String.raw`(?<![\d.])\(?\s*(?:(?:US\s*\$|C\s*\$|[$€£¥])\s*|(?:(?:USD|CAD|EUR|GBP|JPY|CHF)\s+))?-?\d+(?:,\d{3})*(?:\.\d+)?\s*\)?\s*(?:${moneyUnitPatternSource})?\)?`;
const moneyRangePattern = new RegExp(`(${moneyTokenPatternSource})\\s*(?:to|through|-|–|and)\\s*(${moneyTokenPatternSource})`, "gi");
const moneyPlusMinusPattern = new RegExp(`(${moneyTokenPatternSource})\\s*(?:\\+\\s*\\/\\s*-|±|plus\\s+or\\s+minus)\\s*(${moneyTokenPatternSource})`, "i");
const moneyPercentPlusMinusPattern = new RegExp(`(${moneyTokenPatternSource})\\s*(?:\\+\\s*\\/\\s*-|±|plus\\s+or\\s+minus)\\s*(\\d+(?:\\.\\d+)?)\\s*%`, "i");
const singleMoneyPattern = new RegExp(moneyTokenPatternSource, "gi");

// Held separately because a plainly captioned per-share row is relabelled to it when the
// section declares a non-GAAP basis, and the two must not drift apart.
const adjustedEpsDefinition: OutlookMetricDefinition = {
  key: "adjusted_eps",
  label: "Adj EPS",
  patterns: [
    /\badj\.?\s+(?:diluted\s+)?eps\b/i,
    /\badjusted\s+continuing(?:\s+operations?)?\s+(?:diluted\s+)?eps\b/i,
    /\badjusted\s+continuing(?:\s+operations?)?\s+earnings\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b/i,
    /\badjusted\s+(?:\d{1,2}\s+)?(?:diluted\s+)?eps\b/i,
    /\badjusted\s+(?:\d{1,2}\s+)?(?:diluted\s+)?(?:earnings|net\s+income)\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b/i,
    /\bnon-gaap\s+(?:fully\s+)?(?:diluted\s+)?net\s+eps\s+to\s+be\s+in\s+(?:a|the)\s+range\b/i,
    /\bestimates?\b.{0,60}\bnon-gaap\s+(?:fully\s+)?(?:diluted\s+)?net\s+eps\b/i,
    /\bnon-gaap\s+(?:fully\s+)?(?:diluted\s+)?(?:eps|(?:earnings|net\s+income)\s+per\s+(?:common\s+)?(?:diluted\s+)?share)\b/i,
    /^(?:Q[1-4]|FY20\d{2})?\s*non-gaap\s+(?:fully\s+)?(?:diluted\s+)?net\s+income\s+per\s+share\s+attributable\s+to\b/i,
    /\bnon-gaap\s+net\s+loss\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b/i,
  ],
  valueType: "eps",
};

const outlookMetricDefinitions: OutlookMetricDefinition[] = [
  {
    key: "revenue",
    label: "Revenue",
    patterns: [/\brevenues?\b/i, /\bnet\s+sales\b/i, /\btotal\s+sales\b/i],
    valueType: "text",
  },
  adjustedEpsDefinition,
  {
    key: "eps",
    label: "EPS",
    patterns: [
      /\bgaap\s+net\s+income\s+per\s+share\b.{0,100}?\bis\s+expected\s+to\s+be\s+approximately\s+(?=[$€£¥])/i,
      new RegExp(String.raw`${gaapTermSource}\s+(?:continuing(?:\s+operations?)?\s+)?(?:diluted\s+)?eps\b`, "i"),
      new RegExp(String.raw`${gaapTermSource}\s+(?:diluted\s+)?(?:earnings|net\s+income)\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b`, "i"),
      new RegExp(String.raw`${gaapTermSource}\s+(?:diluted\s+)?loss\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b`, "i"),
      // Guidance for a non-GAAP per-share measure must not be posted under the GAAP label,
      // so an occurrence carrying that qualifier is passed over. One sentence often guides
      // on both measures ("Earnings per Share (EPS) is expected to be between $4.05 and
      // $4.25 ... Adjusted EPS is estimated in the range of $4.80 to $5.00"), so this
      // rejects the qualified occurrence rather than the whole line, which would discard
      // the GAAP figure alongside it.
      /(?<!\b(?:adj\.?|adjusted|non-gaap)\s)(?<!\b(?:adjusted|non-gaap)\s\w{1,14}\s)\b(?:continuing(?:\s+operations?)?\s+)?(?:diluted\s+)?eps\b/i,
      /(?<!\b(?:adjusted|non-gaap)\s)(?<!\b(?:adjusted|non-gaap)\s\w{1,14}\s)\bearnings\s+per\s+(?:common\s+)?share\b/i,
    ],
    valueType: "eps",
  },
  {
    key: "adjusted_ebitda",
    label: "Adj EBITDA",
    patterns: [/\badjusted\s+ebitda\b/i],
    valueType: "money",
  },
  {
    key: "dcf_per_share",
    label: "DCF/share",
    patterns: [/\bdcf\s+per\s+share\b/i, /\bdistributable\s+cash\s+flow\s+per\s+share\b/i],
    valueType: "eps",
  },
  {
    key: "gross_margin",
    label: "Gross margin",
    patterns: [/\bgross(?:\s+profit)?\s+margin\b/i],
    valueType: "percent",
  },
  {
    key: "operating_margin",
    label: "Operating margin",
    patterns: [/\boperating\s+margins?\b/i],
    valueType: "percent",
  },
  {
    key: "operating_income",
    label: "Operating income",
    patterns: [/\boperating\s+income\b/i],
    valueType: "money",
  },
  {
    key: "adjusted_operating_income",
    label: "Adj operating income",
    patterns: [
      /\bnon-gaap\s+(?:operating\s+loss|loss\s+from\s+operations)\b/i,
      /\badjusted\s+operating\s+loss\b/i,
    ],
    valueType: "money",
  },
  {
    key: "gaap_operating_expenses",
    label: "GAAP operating expenses",
    patterns: [
      /\bguidance\s+for\s+operating\s+expenses?\b.{0,260}\bgaap\s+operating\s+expenses?\b/i,
    ],
    valueType: "money",
  },
  {
    key: "operating_expenses",
    label: "Operating expenses",
    patterns: [/\boperating\s+expenses?\b/i, /\bopex\b/i],
    valueType: "money",
  },
  {
    key: "tax_rate",
    label: "Tax rate",
    patterns: [/\btax\s+rate\b/i],
    valueType: "percent",
  },
  {
    key: "capex",
    label: "Capex",
    patterns: [/\bcapex\b/i, /\bcapital\s+expenditures?\b/i],
    valueType: "money",
  },
  {
    key: "free_cash_flow",
    label: "Free cash flow",
    patterns: [/\bfree\s+cash\s+flow\b/i],
    valueType: "money",
  },
];

export function extractOutlookMetrics(
  lines: string[],
  documentCurrencyCode = "USD",
): EarningsOutlookMetric[] {
  const section = getOutlookSection(lines);
  if (0 === section.lines.length) {
    return [];
  }

  const metrics: EarningsOutlookMetric[] = [];
  const seenMetrics = new Set<string>();
  for (const definition of outlookMetricDefinitions) {
    const definitionMetrics = extractOutlookMetricsForDefinition(
      section.lines,
      definition,
      section.mixedPeriods &&
        (false === section.revisedColumns || section.lines.some(line => /\boriginal\b.*\bas\s+of\b/i.test(line))),
      section.heading,
      documentCurrencyCode,
      section.revisedColumns,
      section.moneyUnit,
      section.nonGaapMeasures,
      section.guidanceFirstColumns,
      section.guidanceRangeColumns,
    );
    for (const metric of definitionMetrics) {
      const identity = `${metric.periodLabel ?? ""}:${metric.key}`;
      if (true === seenMetrics.has(identity)) {
        continue;
      }

      metrics.push(metric);
      seenMetrics.add(identity);
    }
  }

  return metrics.slice(0, 6);
}

function getOutlookSection(lines: string[]): OutlookSection {
  const joinedLines = joinSplitOutlookLines(lines);
  const sectionLines: string[] = [];
  let collecting = false;
  let heading: string | undefined;
  let mixedPeriods = false;
  const compactSeparators = joinedLines.some(line =>
    /\boriginal\b.*\bas\s+of\b/i.test(line) || /^\s*20\d{2}\s+guidance\s*$/i.test(line));

  for (const line of joinedLines) {
    if (true === isOutlookHeading(line)) {
      const nestedPeriodLabel = true === collecting && /\bguidance\s+metrics\b/i.test(line)
        ? getLineOutlookPeriodLabel(line)
        : undefined;
      // A generic section can contain period-specific table headings for the quarter and
      // full year. Keep those headings in the body so their rows inherit the right period;
      // replacing the section heading with the last one labels every earlier row as FY.
      if (undefined !== nestedPeriodLabel) {
        sectionLines.push(line);
        mixedPeriods = true;
        continue;
      }

      // An inline guidance sentence is only a fallback for releases without a dedicated
      // section. If a real Outlook heading appears later, discard the intervening results
      // prose so historical actuals cannot be merged into the guidance candidates.
      if (true === collecting && undefined === heading) {
        sectionLines.length = 0;
      }
      if (true === collecting && /\|/.test(line) && /\bfull[\s–—-]+year\s+FY\s*\d{2}\b/i.test(line)) {
        sectionLines.push(line);
      }
      collecting = true;
      heading = line;
      mixedPeriods = isMixedPeriodOutlookHeading(line);
      // An inline heading such as "2026 Outlook: revenue ..." carries the only metric
      // value and therefore belongs to the section body.
      if (true === hasInlineOutlookMetricValue(line)) {
        sectionLines.push(line);
      }
      continue;
    }

    if (false === collecting) {
      if (false === isInlineOutlookMetricLine(line)) {
        continue;
      }

      collecting = true;
      sectionLines.push(line);
      continue;
    }

    if (true === isOutlookSectionEnd(line)) {
      // A release deck can repeat an Outlook title on its cover or contents page. If the
      // next line is already another section heading, abandon that empty occurrence and
      // keep looking for the populated section later in the document.
      if (0 === sectionLines.length) {
        collecting = false;
        heading = undefined;
        mixedPeriods = false;
        continue;
      }
      break;
    }

    if (false === compactSeparators || false === isEmptyOutlookSeparator(line)) {
      sectionLines.push(line);
    }
    if (sectionLines.length >= 30) {
      break;
    }
  }

  const expandedSectionLines = expandParallelPeriodGuidanceRows(
    joinVerticalRevisedGuidanceRows(sectionLines),
  );
  return {
    guidanceFirstColumns: hasGuidanceFirstColumnHeader(expandedSectionLines),
    guidanceRangeColumns: hasGuidanceRangeColumnHeader(expandedSectionLines),
    heading,
    moneyUnit: getSectionMoneyUnit([heading ?? "", ...expandedSectionLines]),
    lines: expandedSectionLines,
    mixedPeriods: mixedPeriods ||
      hasMixedOutlookPeriods(expandedSectionLines) ||
      hasMixedOutlookPeriods([
        heading ?? "",
        ...getStructuredOutlookPeriodLines(expandedSectionLines),
      ]),
    nonGaapMeasures: hasNonGaapGuidanceBasis(expandedSectionLines),
    revisedColumns: hasRevisedColumnHeaders(expandedSectionLines),
  };
}

// Inline-XBRL can render a revised table vertically: caption, prior value, updated value.
// Rejoin those three lines into the same row shape used by ordinary HTML tables so the
// updated-column selector can read it without treating the prior value as authoritative.
function joinVerticalRevisedGuidanceRows(lines: string[]): string[] {
  if (false === hasSplitRevisedColumnHeaders(lines)) {
    return lines;
  }

  const joinedLines: string[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const priorValueLine = lines[lineIndex + 1] ?? "";
    const updatedValueLine = lines[lineIndex + 2] ?? "";
    const isMetricCaption = /\b(?:revenues?|net\s+sales|sales|eps|earnings\s+per\s+share|operating\s+(?:income|margin|expenses?)|gross(?:\s+profit)?\s+margin|tax\s+rate|capex|capital\s+expenditures?|free\s+cash\s+flow)\b/i.test(line);
    const isPriorValue = /^\s*\|/.test(priorValueLine) && /\d/.test(priorValueLine);
    const isUpdatedValue = /^\s*\|/.test(updatedValueLine) &&
      (/\d/.test(updatedValueLine) || /\bno\s+change\b/i.test(updatedValueLine));
    if (true === isMetricCaption && true === isPriorValue && true === isUpdatedValue) {
      joinedLines.push(`${line} ${priorValueLine} ${updatedValueLine}`);
      lineIndex += 2;
      continue;
    }

    joinedLines.push(line);
  }

  return joinedLines;
}

// Inline font tags sometimes split a semantic label into separate text lines. Reattach only
// known Outlook headings, section endings, and metric captions so prose remains line-bounded
// for the candidate scorer. For example: "Fiscal" / "Year 2026 ... Outlook" and
// "| · | Net" / "sales growth ...".
function joinSplitOutlookLines(lines: string[]): string[] {
  const joinedLines: string[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const nextLine = lines[lineIndex + 1];
    if (undefined === nextLine) {
      joinedLines.push(line);
      continue;
    }

    const combinedLine = `${line} ${nextLine}`.replace(/\s+/g, " ").trim();
    const cleanNextLine = nextLine
      .replace(/^[\s|•▪◦–—-]+/, "")
      .trim();
    const isSplitMetricCaption =
      /\b(?:net|total|diluted|adjusted|capital)\s*$/i.test(line) &&
      /^(?:sales|revenues?|eps|earnings\s+per\s+share|expenditures?)\b/i.test(cleanNextLine) &&
      /[$€£¥]|\d+(?:\.\d+)?\s*%/i.test(nextLine);
    const isShortLabelFragment = line.length <= 40 &&
      line.trim().split(/\s+/).length <= 4 &&
      false === /\d/.test(line);
    const isSplitHeading =
      true === isShortLabelFragment &&
      ((true === isOutlookHeading(combinedLine) && false === isOutlookHeading(line)) ||
        (true === isOutlookSectionEnd(combinedLine) && false === isOutlookSectionEnd(line)));

    if (false === isSplitMetricCaption && false === isSplitHeading) {
      joinedLines.push(line);
      continue;
    }

    joinedLines.push(combinedLine);
    lineIndex += 1;
  }

  return joinedLines;
}

// Some guidance tables put one quarter and the full year in parallel columns. Convert each
// row into two period-qualified rows so the ordinary one-candidate-per-period reader can
// retain both ranges instead of dropping the dense comparison-shaped row.
function expandParallelPeriodGuidanceRows(lines: string[]): string[] {
  const headerText = lines.slice(0, 10).join(" ");
  const hasSplitFiscalYearColumns = lines.some(line =>
    /^\s*\|\s*Q[1-4]\s+Fiscal\s+Year\s+20\d{2}\s*$/i.test(line)) &&
    lines.some(line => /^\s*\|\s*\|\s*Fiscal\s+Year\s+20\d{2}\s*$/i.test(line));
  if (false === hasSplitFiscalYearColumns &&
      false === lines.some(line => /\bannual\s+recurring\s+revenue\b/i.test(line))) {
    return lines;
  }

  const quarterMatch = /\bQ([1-4])\s+(?:(?:fiscal\s+year|FY)\s*)?(\d{2}|20\d{2})\b/i.exec(headerText);
  const remainingHeaderText = headerText.slice(
    (quarterMatch?.index ?? 0) + (quarterMatch?.[0].length ?? 0),
  );
  const fullYearMatch = /\b(?:full[\s–—-]+year(?:\s+FY)?|fiscal\s+year|FY)\s*(\d{2}|20\d{2})\b/i
    .exec(remainingHeaderText);
  if (undefined === quarterMatch?.[1] || undefined === fullYearMatch?.[1]) {
    return lines;
  }

  const fiscalYear = 2 === fullYearMatch[1].length
    ? `20${fullYearMatch[1]}`
    : fullYearMatch[1];
  return lines.flatMap(line => {
    const cells = line.split("|").map(cell => cell.trim());
    const caption = cells[0] ?? "";
    const valueCells = cells.slice(1).filter(cell => /\d/.test(cell));
    if ("" === caption || 2 !== valueCells.length) {
      return [line];
    }

    return [
      `Q${quarterMatch[1]} ${caption} | ${valueCells[0]}`,
      `FY${fiscalYear} ${caption} | ${valueCells[1]}`,
    ];
  });
}

function isEmptyOutlookSeparator(line: string): boolean {
  return /^\s*(?:\|\s*)+$/.test(line);
}

function getStructuredOutlookPeriodLines(lines: string[]): string[] {
  return lines.filter(line =>
    true === isStandaloneOutlookPeriodCaption(line) ||
    (false === isDefinitionalLine(line) &&
      true === hasInlineOutlookMetricValue(line) &&
      /\b(?:expects?|expected|guidance|outlook|forecast|projected|raises?|raised)\b/i.test(line)));
}

function hasInlineOutlookMetricValue(line: string): boolean {
  const content = line.slice(Math.max(0, line.indexOf(":") + 1));
  return /\b(?:revenues?|net\s+sales|eps|earnings\s+per\s+share|gross(?:\s+profit)?\s+margin|operating\s+(?:margin|income|loss|expenses?)|capex|capital\s+expenditures?|tax\s+rate)\b/i.test(content) &&
    /[$€£¥]|\b(?:USD|CAD|EUR|GBP|JPY|CHF)\b|\d+(?:\.\d+)?\s*%/i.test(content);
}

function isInlineOutlookMetricLine(line: string): boolean {
  const isGuidanceSentence = /\bguidance\s+for\b/i.test(line) &&
    /\b(?:expects?|expected|forecast|projected)\b/i.test(line);
  const isInlineOutlookHeading = /\b(?:20\d{2}|fy\s*\d{2})\s+outlook\s*:/i.test(line) &&
    /\b(?:raises?|raised|updates?|provides?|expects?|reiterates?|reaffirms?)\b/i.test(line);
  // MD&A prose does not always put a one-line annual forecast under an Outlook heading.
  // Keep this to the company's or management's own annual expectation so a project-level
  // amount ("our share of the project capex is expected ...") is not promoted to guidance.
  const isDirectCompanyAnnualForecast = /\b(?:our\s+(?:total\s+)?(?:capex|capital\s+expenditures?)|management\b.{0,60}\b(?:capex|capital\s+expenditures?)|the\s+company(?:'s)?\s+(?:total\s+)?(?:capex|capital\s+expenditures?))\b/i.test(line) &&
    /\b(?:20\d{2}|fy\s*\d{2}|fiscal(?:\s+year)?|full[-\s]+year)\b/i.test(line) &&
    /\b(?:expects?|expected|forecast|projected)\b/i.test(line);
  const isResultsAnnouncement = /\b(?:announces?|reports?)\b.{0,80}\b(?:quarter|results?)\b/i.test(line);
  return false === isResultsAnnouncement &&
    (isGuidanceSentence || isInlineOutlookHeading || isDirectCompanyAnnualForecast) &&
    true === hasInlineOutlookMetricValue(line);
}

// Only a sentence declaring what the guidance *is* counts. The boilerplate footnote that a
// filer "does not provide reconciliations of forward-looking non-GAAP measures" mentions the
// same words while saying nothing about the basis of these rows.
function hasNonGaapGuidanceBasis(lines: string[]): boolean {
  const sectionText = lines.join(" ");
  return /\bnon-gaap\s+(?:financial\s+)?guidance\b/i.test(sectionText) ||
    /\bguidance\s+for\s+(?:certain\s+)?non-gaap\s+measures\b/i.test(sectionText);
}

const unitByMoneyScale = new Map<number, string>([
  [1_000, "thousand"],
  [1_000_000, "million"],
  [1_000_000_000, "billion"],
]);

function getSectionMoneyUnit(lines: string[]): string | undefined {
  for (const line of lines) {
    const scale = getMoneyScaleFromContextText(line);
    if (null !== scale) {
      return unitByMoneyScale.get(scale);
    }
  }

  return undefined;
}

// The header of a revised-guidance table, carrying only the two column captions.
function hasRevisedColumnHeader(line: string): boolean {
  return (/\bprior\b/i.test(line) &&
      /\bupdated\b/i.test(line) &&
      false === /\d/.test(line)) ||
    (/\boriginal\b/i.test(line) && 2 <= (line.match(/\bas\s+of\b/gi)?.length ?? 0));
}

function hasRevisedColumnHeaders(lines: string[]): boolean {
  return lines.some(line => hasRevisedColumnHeader(line)) ||
    hasSplitRevisedColumnHeaders(lines);
}

function hasSplitRevisedColumnHeaders(lines: string[]): boolean {
  return lines.some((line, lineIndex) =>
    /\bprior\b.*\b(?:outlook|guidance)\b/i.test(line) &&
    /\bupdated\b.*\b(?:outlook|guidance)\b/i.test(lines[lineIndex + 1] ?? ""));
}

function hasGuidanceFirstColumnHeader(lines: string[]): boolean {
  if (true === hasParallelGaapNonGaapColumnHeader(lines)) {
    return true;
  }

  for (const [lineIndex, line] of lines.entries()) {
    if (false === /\b(?:guidance|outlook)\b/i.test(line)) {
      continue;
    }

    const headerText = lines.slice(lineIndex, lineIndex + 3).join(" ");
    if (/\bresults?\b/i.test(headerText) && /\bq[1-4]\b/i.test(headerText)) {
      return true;
    }
  }

  return false;
}

function hasParallelGaapNonGaapColumnHeader(lines: string[]): boolean {
  return lines.some(line =>
    /^\s*\|\s*GAAP\s*\|\s*Non-GAAP\s*\|?\s*$/i.test(line));
}

function hasGuidanceRangeColumnHeader(lines: string[]): boolean {
  return lines.some((line, lineIndex) => {
    const headerText = [line, lines[lineIndex + 1] ?? ""].join(" ");
    return /\|/.test(headerText) && /\blow\b[\s\S]*\bhigh\b/i.test(headerText);
  });
}

function hasMixedOutlookPeriods(lines: string[]): boolean {
  const sectionText = lines
    // Per-share guidance footnotes can mention the quarter in which a tariff or other
    // adjustment occurred. That is an input to annual guidance, not a second guided period.
    .filter((_line, lineIndex) => false === /\bguidance\s+includes\b.{0,260}\b(?:impact|benefit)\b/i.test(
      lines.slice(Math.max(0, lineIndex - 1), lineIndex + 1).join(" "),
    ))
    .join(" ");
  const hasQuarter = /\b(?:q[1-4]|first|second|third|fourth)[\s–—-]+quarter\b/i.test(sectionText) ||
    /\bq[1-4]\b/i.test(sectionText) ||
    /\b[1-4]q(?:20)?\d{2}\b/i.test(sectionText);
  return hasQuarter && (hasStandaloneFullYearPeriod(sectionText) ||
    /\bfiscal(?:\s+year)?\s+ending\s+[A-Z][a-z]+\s+\d{1,2},\s+20\d{2}\b/i.test(sectionText) ||
    /(?:^|\|)\s*20\d{2}\s+guidance\b/im.test(sectionText));
}

function isOutlookHeading(line: string): boolean {
  const isExplicitOutlookTitle = /^\s*(?:financial|business)\s+outlook\b/i.test(line);
  if (line.length > (isExplicitOutlookTitle ? 240 : 140) ||
      /^\s*[•▪◦]/.test(line) ||
      /\b(?:announces?|reports?|reported|results?)\b/i.test(line) ||
      /\bforward-looking\s+statements?\b/i.test(line)) {
    return false;
  }

  const wrappedGenericHeading = /^\s*\|\s*((?:financial\s+|business\s+)?(?:outlook|guidance))\s*\|\s*$/i
    .exec(line)?.[1];
  const normalizedLine = wrappedGenericHeading ?? line
    .replace(/^[\s•–—-]+/, "")
    .replace(/[\s|–—-]+$/, "")
    .trim();

  return /^(?:forward[\s–—-]+looking\s+)?(?:business\s+|financial\s+)?(?:outlook|guidance)\b/i.test(normalizedLine) ||
    /^(?:the\s+)?company\s+(?:raises?|updates?|reaffirms?|provides?|issues?)\b.*\b(?:outlook|guidance)\b/i.test(normalizedLine) ||
    /^(?:(?:(?:fiscal(?:\s+year)?|fiscal\s+full[\s–—-]+year)\s+)?(?:20\d{2}|fy\s?\d{2}|q[1-4]\s+20\d{2}|quarter)|(?:first|second|third|fourth)[\s–—-]+quarter)\b.*\b(?:outlook|guidance)\b/i.test(normalizedLine) ||
    /^full[\s–—-]+year\s+fiscal(?:\s+year)?\s+(?:20\d{2}|\d{2})\b.*\bguidance\b/i.test(normalizedLine);
}

function isMixedPeriodOutlookHeading(line: string): boolean {
  return (/\bq[1-4]\b/i.test(line) ||
    /\b(?:first|second|third|fourth)[\s–—-]+quarter\b/i.test(line)) &&
    /\bfull[\s–—-]+year\b/i.test(line);
}

function isOutlookSectionEnd(line: string): boolean {
  if (true === isNextSectionHeading(line)) {
    return true;
  }

  if (line.length <= 140 &&
      /\b(?:forward-looking\s+statements?|safe\s+harbor|legal\s+notice\s+regarding\s+forward-looking)\b/i.test(line)) {
    return true;
  }

  if (/\b(?:conference\s+call|press\s+contact|investor\s+relations|condensed\s+consolidated|financial\s+statements?)\b/i.test(line) ||
      (/\babout\s+\b/i.test(line) &&
        false === /\|/.test(line) &&
        false === /\bsee\b.{0,40}\babout\s+non-gaap\s+financial\s+measures\b/i.test(line))) {
    return true;
  }

  if (line.length <= 90 && /\b(?:business|financial)\s+highlights?\s*$/i.test(line)) {
    return true;
  }

  if (line.length <= 140 &&
      /^\s*(?:use\s+of\s+)?(?:non-gaap|reconciliation)\b/i.test(line) &&
      false === /\d|\|/.test(line) &&
      false === /\b(?:eps|earnings\s+per\s+share|net\s+loss\s+per\s+share|operating\s+(?:income|loss)|loss\s+from\s+operations|gross(?:\s+profit)?\s+margin)\b/i.test(line)) {
    return true;
  }

  return line.length <= 90 &&
    /^(?:results|key\s+financials?|balance\s+sheets?|cash\s+flows?|appendix|contacts?|media|webcast)$/i.test(line);
}

function isNextSectionHeading(line: string): boolean {
  const normalizedLine = line
    .replace(/^[\s•–—-]+/, "")
    .replace(/[\s|–—-]+$/, "")
    .trim();
  if (normalizedLine.length > 90 || /\b(?:outlook|guidance)\b/i.test(normalizedLine)) {
    return false;
  }

  return /^[A-Z][A-Z0-9&/().,:' -]+$/.test(normalizedLine) &&
    /[A-Z]{3,}/.test(normalizedLine);
}

function extractOutlookMetricsForDefinition(
  lines: string[],
  definition: OutlookMetricDefinition,
  includePeriodLabel: boolean,
  sectionHeading: string | undefined,
  documentCurrencyCode: string,
  revisedColumns: boolean,
  sectionMoneyUnit: string | undefined,
  nonGaapMeasures: boolean,
  guidanceFirstColumns: boolean,
  guidanceRangeColumns: boolean,
): EarningsOutlookMetric[] {
  const bestCandidateByPeriod = new Map<string, OutlookMetricCandidate>();
  for (const [lineIndex, line] of lines.entries()) {
    if ("revenue" === definition.key && /\bannual\s+recurring\s+revenues?\b/i.test(line)) {
      continue;
    }
    if ("adjusted_eps" === definition.key &&
        /^(?:Q[1-4]|FY20\d{2})?\s*weighted[-\s]+average\s+shares\b/i.test(line)) {
      continue;
    }
    if ("adjusted_eps" === definition.key &&
        /\bguidance\s+includes\b.*\bimpact\b/i.test(line)) {
      continue;
    }

    if (false === revisedColumns &&
        false === guidanceFirstColumns &&
        true === isNoisyOutlookLine(line, guidanceRangeColumns)) {
      continue;
    }

    // A footnote to a guidance table states what the measure excludes, not the measure:
    // "(1) ... guidance excludes ... totaling $59 million to $81 million" is the size of the
    // exclusions, and reading it reports that range as the guidance itself.
    if (true === isDefinitionalLine(line)) {
      continue;
    }

    for (const pattern of definition.patterns) {
      if (false === pattern.test(line)) {
        continue;
      }

      // A guidance table can carry its caption on one line and its cells on the next
      // ("Earnings per Share" / "| | | $35.50 to $37.00 | $35.50 to $36.50 |").
      const valueLine = getOutlookMetricValueLine(
        lines,
        lineIndex,
        revisedColumns,
        guidanceFirstColumns,
        guidanceRangeColumns,
      );
      const value = extractOutlookValue(
        valueLine,
        pattern,
        definition.key,
        definition.valueType,
        documentCurrencyCode,
        revisedColumns,
        sectionMoneyUnit,
        guidanceFirstColumns,
        guidanceRangeColumns,
      );
      if (null === value) {
        continue;
      }

      const periodLabel = true === includePeriodLabel
        ? getOutlookPeriodLabel(lines, lineIndex, sectionHeading)
        : undefined;
      if (true === includePeriodLabel && undefined === periodLabel) {
        continue;
      }

      // The row's own caption wins where it has one: a line naming GAAP keeps the reported
      // label even inside a non-GAAP section, which is how a table guiding on both measures
      // stays intelligible. Revenue is never relabelled — the sentence that declares the
      // basis names revenue as the GAAP item.
      const isAdjustedBySectionBasis = "eps" === definition.key &&
        (true === nonGaapMeasures || /\bnon-gaap\b/i.test(valueLine)) &&
        false === hasStandaloneGaapTerm(line);
      const coreIdentity = getCoreOutlookIdentity(definition, line);
      const metric: EarningsOutlookMetric = {
        key: isAdjustedBySectionBasis
          ? adjustedEpsDefinition.key
          : coreIdentity?.key ?? definition.key,
        label: isAdjustedBySectionBasis
          ? adjustedEpsDefinition.label
          : coreIdentity?.label ?? definition.label,
        value,
      };
      Object.defineProperty(metric, "sourceSnippet", {
        configurable: false,
        enumerable: false,
        value: undefined === sectionHeading ? line : `${sectionHeading} ${line}`,
        writable: false,
      });
      if (undefined !== periodLabel) {
        metric.periodLabel = periodLabel;
      }
      const candidateScore = getOutlookMetricCandidateScore(valueLine);
      // Once a mixed-period section can retain one candidate per period, an actual result
      // from one period can no longer hide behind stronger guidance for another. Require
      // each retained period to be forward-looking on its own.
      if (true === includePeriodLabel && true === isHistoricalOutlookMetricLine(valueLine)) {
        continue;
      }

      const candidate = {
        // Score what the value was read from: a caption joined to its cells is a table row,
        // whereas the caption alone looks like prose.
        score: candidateScore,
        metric,
      };
      const candidatePeriod = periodLabel ?? "";
      const bestCandidate = bestCandidateByPeriod.get(candidatePeriod);
      if (undefined === bestCandidate || candidate.score > bestCandidate.score) {
        bestCandidateByPeriod.set(candidatePeriod, candidate);
      }
    }
  }

  return [...bestCandidateByPeriod.values()].map(candidate => candidate.metric);
}

function getOutlookMetricValueLine(
  lines: string[],
  lineIndex: number,
  revisedColumns: boolean,
  guidanceFirstColumns: boolean,
  guidanceRangeColumns: boolean,
): string {
  const line = lines[lineIndex] ?? "";
  const nextLine = lines[lineIndex + 1] ?? "";
  const needsTableValueContinuation = (true === revisedColumns ||
      true === guidanceFirstColumns ||
      true === guidanceRangeColumns) &&
    false === /[$€£¥]|\d+\.\d+|\d+\s*%/.test(line) &&
    /[$€£¥]|\d+\.\d+|\d+\s*%/.test(nextLine);
  const needsWrappedRangeContinuation = /\b(?:between|range)\b/i.test(line) &&
    /(?:\band|\bto|[-–—])\s*$/.test(line.trim()) &&
    /^\s*(?:[$€£¥]|\(?-?\d)/.test(nextLine);
  const needsTranslatedRangeContinuation = /\bbetween\b/i.test(line) &&
    /^\s*\((?:US\s*\$|C\s*\$|€|£|¥|USD|CAD|EUR|GBP|JPY|CHF)\s*\d/i.test(nextLine) &&
    /\band\b/i.test(nextLine);
  const needsNarrativeValueContinuation =
    /\b(?:expects?|expected|continues?\s+to\s+expect)\b/i.test(line) &&
    false === /[$€£¥]|\d+\.\d+|\d+\s*%/.test(line) &&
    /^\s*(?:in\s+the\s+range\s+of\s+|between\s+|approximately\s+)?(?:[$€£¥]|\(?-?\d+(?:\.\d+)?\s*%)/i.test(nextLine);
  return true === needsTableValueContinuation ||
      true === needsWrappedRangeContinuation ||
      true === needsTranslatedRangeContinuation ||
      true === needsNarrativeValueContinuation
    ? `${line} ${nextLine}`
    : line;
}

function getCoreOutlookIdentity(
  definition: OutlookMetricDefinition,
  line: string,
): {key: string; label: string;} | undefined {
  if (false === /\bcore\b/i.test(line)) {
    return undefined;
  }

  const labelByKey = new Map<string, string>([
    ["revenue", "Core revenue"],
    ["gross_margin", "Core gross margin"],
    ["operating_margin", "Core operating margin"],
  ]);
  const label = labelByKey.get(definition.key);
  return undefined === label
    ? undefined
    : {key: `core_${definition.key}`, label};
}

function getOutlookPeriodLabel(
  lines: string[],
  lineIndex: number,
  sectionHeading?: string,
): string | undefined {
  const line = lines[lineIndex] ?? "";
  const directPeriodLabel = getLineOutlookPeriodLabel(line);
  const historicalComparisonIndex = line.search(
    /\b(?:on\s+top\s+of|(?:as\s+)?compared\s+(?:to|with)|versus|vs\.?)\b/i,
  );
  const hasForecastPeriodBeforeComparison = 0 < historicalComparisonIndex &&
    hasOutlookPeriodReference(line.slice(0, historicalComparisonIndex));
  if (undefined !== directPeriodLabel &&
      (-1 === historicalComparisonIndex || true === hasForecastPeriodBeforeComparison)) {
    return directPeriodLabel;
  }

  // Some releases introduce a short group of bullets with a standalone period caption.
  // Only inherit from that caption form: looking back through ordinary metric rows leaks
  // one row's period onto the next otherwise-unlabelled row.
  const hasParallelGaapNonGaapHeader = hasParallelGaapNonGaapColumnHeader(lines);
  const hasSplitCurrentOutlookHeader = lines.some(contextLine =>
    /\bcurrent\s+FY\s*20\d{2}\s+(?:outlook|guidance)\b/i.test(contextLine));
  const periodLookback = true === hasParallelGaapNonGaapHeader ||
      true === hasSplitCurrentOutlookHeader
    ? 16
    : 8;
  for (let index = lineIndex - 1; index >= 0 && index >= lineIndex - periodLookback; index--) {
    const contextLine = lines[index] ?? "";
    const inheritedPeriodLabel = getLineOutlookPeriodLabel(contextLine);
    const isCompactGuidancePeriodHeader = contextLine.length <= 140 &&
      (/\bguidance\s+metrics\b/i.test(contextLine) ||
        /\b(?:current\s+FY\s*20\d{2}|(?:first|second|third|fourth)\s+quarter\s+fiscal\s+20\d{2})\s+(?:outlook|guidance)\b/i
          .test(contextLine)) &&
      false === /[$€£¥]|\d+(?:\.\d+)?\s*%/.test(contextLine);
    const isLongRangeProseCaption = true === isLongRangeOutlookPeriodCaption(contextLine);
    if (false === hasParallelGaapNonGaapHeader &&
        4 < lineIndex - index &&
        false === isCompactGuidancePeriodHeader &&
        false === isOutlookHeading(contextLine) &&
        false === isBulletOutlookPeriodHeading(contextLine) &&
        (false === isLongRangeProseCaption || 6 < lineIndex - index)) {
      continue;
    }
    if (undefined === inheritedPeriodLabel ||
        (false === isStandaloneOutlookPeriodCaption(contextLine) &&
          false === isCompactGuidancePeriodHeader &&
          false === /\bconsolidated\s+metric\b/i.test(contextLine))) {
      continue;
    }

    return inheritedPeriodLabel;
  }

  if (undefined !== directPeriodLabel) {
    const sectionPeriodLabel = getLineOutlookPeriodLabel(sectionHeading ?? "");
    if (0 < historicalComparisonIndex &&
        false === hasForecastPeriodBeforeComparison &&
        undefined !== sectionPeriodLabel) {
      return sectionPeriodLabel;
    }

    return directPeriodLabel;
  }

  // A period-specific "Financial Outlook" heading governs the first bullet group even when
  // a later full-year caption makes the section mixed. Keep this fallback narrow: a generic
  // period heading can sit above historical and target prose whose rows do not inherit it.
  return /^\s*(?:q[1-4]|(?:first|second|third|fourth)[\s–—-]+quarter)\b.*\bfinancial\s+outlook\b/i
    .test(sectionHeading ?? "") ||
      (/^\s*fy\s*\d{2}\b.*\b(?:outlook|guidance)\b/i.test(sectionHeading ?? "") ||
        (true === hasSplitCurrentOutlookHeader &&
          /^\s*fiscal\s+20\d{2}\b.*\b(?:outlook|guidance)\b/i.test(sectionHeading ?? "")) ||
        /^\s*fiscal(?:\s+year)?\s+20\d{2}\b.*\bending\b.*\boutlook\b/i
          .test(sectionHeading ?? ""))
    ? getLineOutlookPeriodLabel(sectionHeading ?? "")
    : undefined;
}

function hasOutlookPeriodReference(text: string): boolean {
  return /\b(?:q[1-4](?:\s*(?:FY\s*)?(?:20)?\d{2})?|[1-4]q(?:20)?\d{2}|(?:first|second|third|fourth)[\s–—-]+quarter|(?:full[\s–—-]+year|fiscal(?:\s+year)?|fy)\s*(?:of\s+)?(?:20\d{2}|\d{2}))\b/i
    .test(text);
}

function isStandaloneOutlookPeriodCaption(line: string): boolean {
  if (/[$€£¥]|\d+(?:\.\d+)?\s*%/.test(line)) {
    return false;
  }

  return true === isBulletOutlookPeriodHeading(line) ||
    /^\s*\|\s*(?:third[\s–—-]+quarter|fiscal\s+year\s+20\d{2})\s*\|/i.test(line) ||
    true === isLongRangeOutlookPeriodCaption(line) ||
    /^\s*for\s+(?:fiscal\s+year\s+20\d{2}|the\s+(?:first|second|third|fourth)[\s–—-]+quarter\s+of\s+fiscal\s+20\d{2})\b[^:]{0,100}\bthe\s+company\s+(?:now\s+)?expects\s*:\s*$/i.test(line) ||
    /^\s*for\s+the\s+(?:(?:first|second|third|fourth)\s+quarter|full[\s–—-]+year)\b[^:]{0,40}\b(?:we|the\s+company)\s+expect\s*:\s*$/i.test(line) ||
    /^\s*.{0,50}\bis\s+providing\s+guidance\s+for\s+(?:its\s+)?(?:first|second|third|fourth)\s+quarter\b[^$€£¥%]*:?\s*$/i.test(line) ||
    /^\s*.{0,60}\bis\s+providing\s+guidance\s+for\s+(?:its\s+)?fiscal\s+(?:first|second|third|fourth)\s+quarter\b[^$€£¥%]*:?\s*$/i.test(line) ||
    /^\s*.{0,50}\bis\s+providing\s+guidance\s+for\s+(?:its\s+)?(?:full\s+)?fiscal\s+year\s+20\d{2}\b[^$€£¥%]*:?\s*$/i.test(line) ||
    /^\s*.{0,70}\bis\s+providing\s+(?:updated\s+)?guidance\s+for\s+(?:its\s+)?fiscal\s+year\s+ending\b[^$€£¥%]*:?\s*$/i.test(line) ||
    true === isParallelOutlookPeriodHeader(line) ||
    /^\s*(?:q[1-4](?:\s+(?:fy\s*)?(?:20)?\d{2})?|(?:first|second|third|fourth)[\s–—-]+quarter(?:\s+(?:of\s+)?(?:fiscal\s+year\s+)?20\d{2})?|(?:full[\s–—-]+year|fiscal(?:\s+year)?|fy)\s*(?:20\d{2}|\d{2}))(?:\s+(?:financial\s+)?(?:outlook|guidance))?(?:\s*[|:])*\s*$/i.test(line) ||
    /^\s*full[\s–—-]+year\s+fy\s*\d{2}\s*$/i.test(line) ||
    true === isOutlookHeading(line);
}

function isBulletOutlookPeriodHeading(line: string): boolean {
  return /^\s*[•▪◦](?!\s)(?:q[1-4]|(?:first|second|third|fourth)[\s–—-]+quarter|full(?:[\s–—-]+year)?\s+fiscal)\b.*\b(?:outlook|guidance)\s*:?\s*$/i
    .test(line);
}

function isLongRangeOutlookPeriodCaption(line: string): boolean {
  return /^\s*for\s+(?:the\s+(?:first|second|third|fourth)[\s–—-]+quarter\s+of\s+fiscal(?:\s+year)?\s+20\d{2}|fiscal(?:\s+year)?\s+20\d{2})\b[^$€£¥%]{0,100}:?\s*$/i.test(line);
}

function isParallelOutlookPeriodHeader(line: string): boolean {
  if (false === /^\s*\|/.test(line)) {
    return false;
  }

  const firstCell = line.split("|", 3)[1]?.trim() ?? "";
  return /^(?:FY\s*\d{2,4}|Q[1-4]\s*(?:FY\s*)?\d{2,4})$/i.test(firstCell);
}

function getLineOutlookPeriodLabel(line: string): string | undefined {
  const fiscalQuarterMatch = /\bfiscal(?:\s+year)?\s+(?:20\d{2}|\d{2})\s+(first|second|third|fourth)[\s–—-]+quarter\b/i.exec(line);
  if (undefined !== fiscalQuarterMatch?.[1]) {
    const quarterByName = new Map([
      ["first", "Q1"],
      ["second", "Q2"],
      ["third", "Q3"],
      ["fourth", "Q4"],
    ]);
    return quarterByName.get(fiscalQuarterMatch[1].toLowerCase());
  }

  const periodCandidates: {index: number; label: string;}[] = [];
  const forwardMarkerIndex = line.search(/\b(?:outlook|guidance|expects?|forecast|projected|increasing|raises?|targeting)\b/i);
  // Beauty and retail filers commonly write fiscal quarters in the inverted compact form
  // "1Q27". Recognise it before a historical FY26 comparison later in the same sentence.
  const invertedQuarterMatch = /\b([1-4])q(?:\s*)?(?:20)?\d{2}\b/i.exec(line);
  if (undefined !== invertedQuarterMatch?.[1]) {
    periodCandidates.push({
      index: invertedQuarterMatch.index,
      label: `Q${invertedQuarterMatch[1]}`,
    });
  }

  for (const directQuarterMatch of line.matchAll(/\bq([1-4])(?:\s*(?:FY\s*)?(?:20)?\d{2})?\b/gi)) {
    if (undefined === directQuarterMatch[1]) {
      continue;
    }
    periodCandidates.push({
      index: directQuarterMatch.index,
      label: `Q${directQuarterMatch[1]}`,
    });
  }

  for (const writtenQuarterMatch of line.matchAll(/\b(first|second|third|fourth)[\s–—-]+quarter\b/gi)) {
    if (undefined === writtenQuarterMatch[1]) {
      continue;
    }
    const quarterByName = new Map([
      ["first", "Q1"],
      ["second", "Q2"],
      ["third", "Q3"],
      ["fourth", "Q4"],
    ]);
    const quarterLabel = quarterByName.get(writtenQuarterMatch[1].toLowerCase());
    if (undefined !== quarterLabel) {
      periodCandidates.push({
        index: writtenQuarterMatch.index,
        label: quarterLabel,
      });
    }
  }

  const fullYearMatch = /\b(?:full[\s–—-]+year|fiscal(?:\s+year)?|fy)\s*(?:of\s+)?(20\d{2}|\d{2})\b/i.exec(line);
  if (undefined !== fullYearMatch?.[1]) {
    periodCandidates.push({
      index: fullYearMatch.index,
      label: `FY${2 === fullYearMatch[1].length ? `20${fullYearMatch[1]}` : fullYearMatch[1]}`,
    });
  }

  const fiscalYearEndingMatch = /\bfiscal(?:\s+year)?\s+ending\s+[A-Z][a-z]+\s+\d{1,2},\s+(20\d{2})\b/i.exec(line);
  if (undefined !== fiscalYearEndingMatch?.[1]) {
    periodCandidates.push({
      index: fiscalYearEndingMatch.index,
      label: `FY${fiscalYearEndingMatch[1]}`,
    });
  }

  const invertedFiscalYearMatch = /\b(20\d{2})\s+fiscal\s+year\b/i.exec(line);
  if (undefined !== invertedFiscalYearMatch?.[1]) {
    periodCandidates.push({
      index: invertedFiscalYearMatch.index,
      label: `FY${invertedFiscalYearMatch[1]}`,
    });
  }

  const compactFullYearMatch = /\bfull[\s–—-]+year\s+fy\s*(\d{2})\b/i.exec(line);
  if (undefined !== compactFullYearMatch?.[1]) {
    periodCandidates.push({
      index: compactFullYearMatch.index,
      label: `FY20${compactFullYearMatch[1]}`,
    });
  }

  const yearGuidanceMatch = /\b(20\d{2})\s+guidance\b/i.exec(line);
  if (undefined !== yearGuidanceMatch?.[1]) {
    periodCandidates.push({
      index: yearGuidanceMatch.index,
      label: `FY${yearGuidanceMatch[1]}`,
    });
  }

  const trailingForecastYearMatch = /\b(?:expects?|targeting|forecast|projected)\b[\s\S]{0,180}?\bin\s+(20\d{2})\b/i.exec(line);
  if (undefined !== trailingForecastYearMatch?.[1]) {
    periodCandidates.push({
      index: trailingForecastYearMatch.index,
      label: `FY${trailingForecastYearMatch[1]}`,
    });
  }

  const forwardCandidates = 0 <= forwardMarkerIndex
    ? periodCandidates.filter(candidate => candidate.index >= forwardMarkerIndex)
    : [];
  return (0 < forwardCandidates.length ? forwardCandidates : periodCandidates)
    .sort((first, second) => first.index - second.index)[0]?.label;
}

function withNullablePercentGrowthDirection(value: string | null, source: string): string | null {
  return null === value ? null : withPercentGrowthDirection(value, source);
}

function getOutlookMetricCandidateScore(line: string): number {
  let score = 0;

  // A guidance table states the figures; the paragraph introducing it only describes them,
  // and any amount it happens to mention belongs to that description rather than to the
  // metric ("...guidance, reflecting the continued strong revenue performance in Q2").
  //
  // One pipe is enough: a two-column guidance table is a caption and a value cell, so
  // requiring two left its rows scoring below the surrounding prose — which is how a range
  // the filing itself disclaims as "not intended to be guidance" was posted as the guidance.
  if (1 <= (line.match(/\|/g)?.length ?? 0)) {
    score += 30;
  } else if (200 < line.length) {
    score -= 20;
  }

  if (/\b(?:expects?|expected|guidance|outlook|forecast|projected|targets?|targeting|anticipates?|anticipated|reaffirms?|reiterates?|maintains?|raises?|raised)\b/i.test(line)) {
    score += 20;
  }

  if (/\b(?:full[-\s]+year|fiscal|fy\s?\d{2}|20\d{2}|next\s+quarter|second\s+quarter|third\s+quarter|fourth\s+quarter|q[1-4])\b/i.test(line)) {
    score += 5;
  }

  if (/\b(?:reported|generated|was|were|amounted|totaled|for\s+the\s+(?:first|second|third|fourth)\s+quarter|for\s+q[1-4])\b/i.test(line)) {
    score -= 10;
  }

  return score;
}

function isHistoricalOutlookMetricLine(line: string): boolean {
  if (/\bguidance\s+is\s+based\s+on\s+the\s+following\b.{0,120}\bfigures?\b/i.test(line)) {
    return true;
  }

  return /\b(?:reported|generated|was|were|amounted|totaled)\b/i.test(line) &&
    false === /\b(?:expects?|expected|guidance|outlook|forecast|projected|targets?|targeting|anticipates?|anticipated|reaffirms?|reiterates?|maintains?|raises?|raised)\b/i.test(line);
}

function isNoisyOutlookLine(line: string, guidanceRangeColumns = false): boolean {
  // An explanatory footnote states the size of adjustments excluded from guidance. Its
  // per-share amounts are not themselves the guided measure.
  if (/^\s*(?:this\s+)?(?:outlook|guidance)\b.{0,160}\b(?:excludes?|includes?)\b.{0,160}\b(?:charges?|benefits?|expenses?|items?|tax)\b/i.test(line)) {
    return true;
  }

  // This historical management quote sits inside the outlook section, but its inventory
  // reduction percentage is not the gross-margin guidance mentioned earlier in the quote.
  if (/^\s*[“"]/.test(line) &&
      /\bsaid\b.{0,120}\bchief\s+financial\s+officer\b/i.test(line) &&
      /\binventory\s+is\s+down\b/i.test(line)) {
    return true;
  }

  const pipeCount = line.match(/\|/g)?.length ?? 0;
  // SEC inline-XBRL tables often render a two-column row with empty spacer cells:
  // "Adjusted EBITDA | | $181M to $191M | |". Count populated numeric cells rather
  // than separators so that row remains guidance, while a dense historical comparison
  // with several numeric columns is still excluded.
  const populatedNumericCells = line
    .split("|")
    .filter(cell => /\d/.test(cell))
    .length;
  const isSparseTwoColumnRow = 4 === pipeCount && 1 === populatedNumericCells;
  const isPlusMinusGuidanceRow = 4 <= pipeCount &&
    2 === populatedNumericCells &&
    /\+\s*\/\s*-|±|plus\s+or\s+minus/i.test(line);
  const isLowHighGuidanceRow = true === guidanceRangeColumns && 2 === populatedNumericCells;
  return (pipeCount >= 4 &&
      false === isSparseTwoColumnRow &&
      false === isPlusMinusGuidanceRow &&
      false === isLowHighGuidanceRow) ||
    /\bpost[-\s]?20\d{2}\b.*\bcompound\s+annual\s+growth\s+rate\b/i.test(line);
}

function extractOutlookValue(
  line: string,
  pattern: RegExp,
  metricKey: string,
  valueType: OutlookValueType,
  documentCurrencyCode: string,
  revisedColumns = false,
  sectionMoneyUnit?: string,
  guidanceFirstColumns = false,
  guidanceRangeColumns = false,
): string | null {
  pattern.lastIndex = 0;
  const patternMatch = pattern.exec(line);
  for (const rawValueText of getOutlookValueSegments(
    line,
    patternMatch,
    revisedColumns,
    guidanceFirstColumns,
    guidanceRangeColumns,
  )) {
    const valueText = normalizeOutlookValueText(rawValueText);
    if ("" === valueText) {
      continue;
    }

    // A per-share range is the figure being guided to, so it wins over a growth rate quoted
    // in the same breath ("Non-GAAP EPS of $0.84 to $0.88, representing growth of 28% to
    // 35%"). Guidance given only as growth still falls through to the growth reading.
    const value = ("tax_rate" === metricKey
      ? getBasisSpecificTaxRateValue(line, valueText)
      : null) ??
      getPlusMinusOutlookValue(valueText, valueType, documentCurrencyCode, sectionMoneyUnit) ??
      ("eps" === valueType
        ? getOutlookRangeValue(valueText, valueType, documentCurrencyCode, sectionMoneyUnit)
        : null) ??
      ("text" === valueType
        ? getExplicitCurrencyMoneyRangeValue(valueText, documentCurrencyCode)
        : null) ??
      getGrowthOutlookValue(valueText) ??
      ("text" === valueType &&
        (/\b(?:increase|decrease)\b/i.test(valueText) ||
          (true === revisedColumns && /\bgrowth\b/i.test(line)) ||
          ("revenue" === metricKey &&
            /\b(?:net\s+sales|total\s+sales)\b/i.test(line) &&
            /\b(?:growth|increase|decrease|up|down)\b/i.test(rawValueText)))
        ? withNullablePercentGrowthDirection(getPercentRangeOutlookValue(valueText), line)
        : null) ??
      getOutlookRangeValue(valueText, valueType, documentCurrencyCode, sectionMoneyUnit) ??
      ("eps" === valueType ? getEpsPercentOutlookValue(valueText) : null) ??
      ("text" === valueType ? getSingleOutlookValue(valueText, "money", documentCurrencyCode) : null) ??
      ("text" === valueType ? getNumericGrowthOutlookValue(valueText) : null) ??
      getSingleOutlookValue(valueText, valueType, documentCurrencyCode, sectionMoneyUnit);
    if (null !== value) {
      const isLossCaption = /\bloss\b/i.test(patternMatch?.[0] ?? "") &&
        false === /\b(?:income|earnings|profit)\b/i.test(patternMatch?.[0] ?? "");
      return applyOutlookLossSign(value, valueText, valueType, isLossCaption);
    }
  }

  return null;
}

function getPlusMinusOutlookValue(
  value: string,
  valueType: OutlookValueType,
  documentCurrencyCode: string,
  sectionMoneyUnit?: string,
): string | null {
  const flattenedValue = value.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ");
  if ("percent" === valueType) {
    const percentMatch = flattenedValue.match(
      /(\(?-?\d+(?:\.\d+)?\s*%\)?)\s*(?:\+\s*\/\s*-|±|plus\s+or\s+minus)\s*(\(?-?\d+(?:\.\d+)?\s*%\)?)/i,
    );
    const midpoint = parseNumber(percentMatch?.[1]);
    const variance = parseNumber(percentMatch?.[2]);
    return null !== midpoint && null !== variance
      ? `${formatPercent(midpoint - Math.abs(variance))} to ${formatPercent(midpoint + Math.abs(variance))}`
      : null;
  }

  const percentVarianceMatch = moneyPercentPlusMinusPattern.exec(flattenedValue);
  const percentMidpointToken = percentVarianceMatch?.[1];
  const percentVarianceToken = percentVarianceMatch?.[2];
  if (("money" === valueType || "text" === valueType) &&
      undefined !== percentMidpointToken &&
      undefined !== percentVarianceToken) {
    const inferredUnit = getMoneyUnit(percentMidpointToken) ?? sectionMoneyUnit;
    const inferredCurrencyCode = getCurrencyCodeFromText(percentMidpointToken, documentCurrencyCode) ??
      documentCurrencyCode;
    const midpoint = parseMoneyWithOptionalUnit(
      percentMidpointToken,
      inferredUnit,
      inferredCurrencyCode,
    );
    const variancePercent = Number.parseFloat(percentVarianceToken);
    if (null !== midpoint && Number.isFinite(variancePercent)) {
      const variance = Math.abs(midpoint.value * variancePercent / 100);
      return `${formatMoneyCompact(midpoint.value - variance, midpoint.currencyCode)} to ${formatMoneyCompact(midpoint.value + variance, midpoint.currencyCode)}`;
    }
  }

  const plusMinusMatch = moneyPlusMinusPattern.exec(flattenedValue);
  const midpointToken = plusMinusMatch?.[1];
  const varianceToken = plusMinusMatch?.[2];
  if (undefined === midpointToken || undefined === varianceToken) {
    return null;
  }

  if ("eps" === valueType) {
    const midpoint = parseNumber(midpointToken);
    const variance = parseNumber(varianceToken);
    return null !== midpoint && null !== variance
      ? `${formatEps(midpoint - Math.abs(variance), documentCurrencyCode)} to ${formatEps(midpoint + Math.abs(variance), documentCurrencyCode)}`
      : null;
  }

  if (false === ("money" === valueType || "text" === valueType)) {
    return null;
  }

  const inferredUnit = getMoneyUnit(varianceToken) ??
    getMoneyUnit(midpointToken) ??
    sectionMoneyUnit;
  if (undefined === inferredUnit &&
      false === hasMoneyValueCue(midpointToken) &&
      false === hasMoneyValueCue(varianceToken)) {
    return null;
  }

  const inferredCurrencyCode = getCurrencyCodeFromText(varianceToken, documentCurrencyCode) ??
    getCurrencyCodeFromText(midpointToken, documentCurrencyCode) ??
    documentCurrencyCode;
  const midpoint = parseMoneyWithOptionalUnit(midpointToken, inferredUnit, inferredCurrencyCode);
  const variance = parseMoneyWithOptionalUnit(varianceToken, inferredUnit, inferredCurrencyCode);
  return null !== midpoint && null !== variance
    ? `${formatMoneyCompact(midpoint.value - Math.abs(variance.value), midpoint.currencyCode)} to ${formatMoneyCompact(midpoint.value + Math.abs(variance.value), midpoint.currencyCode)}`
    : null;
}

function applyOutlookLossSign(
  value: string,
  source: string,
  valueType: OutlookValueType,
  isLossCaption = false,
): string {
  if (false === ("money" === valueType || "eps" === valueType) ||
      (false === isLossCaption && false === /^\s*(?:a\s+)?loss\b/i.test(source))) {
    return value;
  }

  return value
    .split(" to ")
    .map(part => part.startsWith("-") ? part : `-${part}`)
    .join(" to ");
}

function getOutlookValueSegments(
  line: string,
  patternMatch: RegExpExecArray | null,
  revisedColumns: boolean,
  guidanceFirstColumns: boolean,
  guidanceRangeColumns: boolean,
): string[] {
  if (null === patternMatch) {
    return [line];
  }

  // Each row of a revised-guidance table holds the prior figure and then the updated one.
  // Reading from the last cell backwards takes the figure that now applies.
  if (true === revisedColumns) {
    const cells = line.slice(patternMatch.index + patternMatch[0].length).split("|");
    const populatedCells = cells.filter(cell => /\d/.test(cell)).reverse();
    if (0 < populatedCells.length) {
      return populatedCells;
    }
  }

  if (true === guidanceRangeColumns) {
    const populatedCells = line
      .slice(patternMatch.index + patternMatch[0].length)
      .split("|")
      .filter(cell => /\d/.test(cell));
    if (2 <= populatedCells.length) {
      return [`${populatedCells[0]} to ${populatedCells[1]}`];
    }
  }

  if (true === guidanceFirstColumns) {
    const cells = line.slice(patternMatch.index + patternMatch[0].length).split("|");
    const firstPopulatedCellIndex = cells.findIndex(cell => "" !== cell.trim());
    const firstPopulatedCell = cells[firstPopulatedCellIndex];
    if (undefined !== firstPopulatedCell &&
        /\b(?:up|down|flat|leverage|basis\s+points?)\b/i.test(firstPopulatedCell)) {
      return [firstPopulatedCell];
    }

    const guidanceCell = cells.find(cell =>
      /[$€£¥]|\b(?:USD|CAD|EUR|GBP|JPY|CHF)\b|\d+\.\d+|\d+\s*%/i.test(cell));
    if (undefined !== guidanceCell) {
      return [guidanceCell];
    }
  }

  const rawValueText = line.slice(patternMatch.index + patternMatch[0].length);
  const nextMetricPattern = /\b(?:adjusted\s+(?:continuing\s+)?eps|gaap\s+(?:continuing\s+)?eps|diluted\s+eps|eps|(?:(?:adjusted|non-gaap|gaap)\s+)?(?:earnings|net\s+income)\s+per\s+(?:common\s+)?(?:diluted\s+)?share|revenues?|net\s+sales|sales|gross(?:\s+profit)?\s+margin|operating\s+margin|operating\s+income|operating\s+expenses?|opex|tax\s+rate|capex|capital\s+expenditures?|free\s+cash\s+flow|dcf\s+per\s+share|distributable\s+cash\s+flow\s+per\s+share|adjusted\s+ebitda\s+margin|adjusted\s+ebitda|ebitda)\b/gi;
  const currentCaptionPattern = new RegExp(
    patternMatch[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );
  const followingMetricMatches = [...rawValueText.matchAll(nextMetricPattern)];
  // A sentence can contrast an actual year with the forecast by repeating the caption:
  // "capital expenditures for 2025 were $283.7 million, and our capital expenditures for
  // 2026 are expected to be $400 million." Read the forward-looking occurrence first;
  // otherwise the first, historical amount wins before the repeated caption is reached.
  const currentCaptionQualifier = getOutlookCaptionQualifier(
    line.slice(0, patternMatch.index),
  );
  const forwardLookingRepeatedCaptionSegments = followingMetricMatches
    .filter(candidateMatch =>
      true === currentCaptionPattern.test(candidateMatch[0]) &&
      /\b20\d{2}\b.{0,80}\b(?:was|were|totaled|amounted)\b/i.test(
        rawValueText.slice(0, candidateMatch.index),
      ) &&
      currentCaptionQualifier === getOutlookCaptionQualifier(
        rawValueText.slice(0, candidateMatch.index),
      ))
    .map(candidateMatch => {
      const candidateStart = (candidateMatch.index ?? 0) + candidateMatch[0].length;
      const nextCaption = followingMetricMatches.find(followingMatch =>
        (followingMatch.index ?? 0) > (candidateMatch.index ?? 0));
      return rawValueText.slice(candidateStart, nextCaption?.index ?? rawValueText.length);
    })
    .filter(candidateText =>
      /\b(?:expects?|expected|forecast|projected|guidance|outlook)\b/i.test(candidateText));
  const nextMetricMatch = followingMetricMatches
    .find(candidateMatch => {
      if (false === currentCaptionPattern.test(candidateMatch[0])) {
        return true;
      }

      // Guidance prose often states growth first and then translates it into an absolute
      // range: "this implies absolute net sales of CHF ...". The repeated caption still
      // belongs to the same metric, so it is not a boundary between outlook items.
      const precedingText = rawValueText.slice(0, candidateMatch.index);
      return false === /\b(?:implies?|indicates?)\s+(?:an?\s+)?absolute\s*$/i.test(precedingText);
    });
  const endIndex = nextMetricMatch?.index ?? rawValueText.length;
  const previousValueText = getPreviousOutlookValueSegment(line, patternMatch.index);
  return [
    ...forwardLookingRepeatedCaptionSegments,
    rawValueText.slice(0, endIndex),
    previousValueText,
  ];
}

function getOutlookCaptionQualifier(text: string): string {
  return text.match(/\b(gaap|adjusted|non-gaap)\s*$/i)?.[1]?.toLowerCase() ?? "";
}

function getPreviousOutlookValueSegment(line: string, metricStartIndex: number): string {
  const previousText = line.slice(0, metricStartIndex);
  const separatorIndex = Math.max(
    previousText.lastIndexOf(";"),
    previousText.lastIndexOf("|"),
  );
  return previousText.slice(Math.max(separatorIndex + 1, previousText.length - 180));
}

function normalizeOutlookValueText(value: string): string {
  return value
    // Updated narrative guidance states the applicable point first and puts the superseded
    // range in a parenthetical "previously ..." clause. Remove that comparison before
    // range parsing so the stale endpoints cannot replace the updated figure.
    .replace(/\(\s*previously\b[^)]*\)/gi, " ")
    // The first sentence carries the guided EPS. Later implementation notes repeat smaller
    // FX and share-count headwinds, which are explanatory amounts rather than the outlook.
    .replace(/\b(?:GAAP|Non-GAAP)\s+EPS\s+guidance\s+includes\b[\s\S]*$/i, " ")
    // A table can wrap one accounting parenthesis around a complete range,
    // "($29.0 - 32.0)". Both endpoints are losses, so make each sign explicit
    // before the normal range parser sees them.
    .replace(
      /\(\s*((?:(?:C\s*\$|[$€£¥])\s*)?\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:to|through|-|–|—)\s*((?:(?:C\s*\$|[$€£¥])\s*)?\d+(?:,\d{3})*(?:\.\d+)?)\s*\)/gi,
      "($1) to ($2)",
    )
    .replace(/^[\s:|,-]+/, "")
    .replace(/\b(?:is|are|was|were|to\s+be|of|at|approximately|about|around|roughly|expected|expects|expect|guidance|outlook|projected|forecast|in\s+the\s+range\s+of|between)\b/gi, " ")
    .replace(/\bto\s+(?:grow|increase|range)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getGrowthOutlookValue(value: string): string | null {
  const growthMatch = value.match(/\b(low|mid|high)\s+(single|double)[-\s]+digit(?:s)?(?:\s+(?:growth|increase|decline|decrease))?\b/i);
  if (undefined !== growthMatch?.[1] && undefined !== growthMatch[2]) {
    return `${growthMatch[1].toLowerCase()} ${growthMatch[2].toLowerCase()}-digit ${getGrowthDirection(value)}`;
  }

  const doubleDigitMatch = value.match(/\bdouble[-\s]+digit(?:s)?(?:\s+(?:growth|increase|decline|decrease))?\b/i);
  if (doubleDigitMatch) {
    return `double-digit ${getGrowthDirection(value)}`;
  }

  return null;
}

function getGrowthDirection(value: string): "growth" | "decline" {
  return /\bdecline|decrease|down\b/i.test(value) ? "decline" : "growth";
}

function getNumericGrowthOutlookValue(value: string): string | null {
  const percentMatch = /(-?\d+(?:\.\d+)?)\s*(?:%|percent)\b/i.exec(value);
  if (undefined === percentMatch?.[1]) {
    return null;
  }

  return `${formatPercent(Number.parseFloat(percentMatch[1]))} ${getGrowthDirection(value)}`;
}

function getBasisSpecificTaxRateValue(line: string, value: string): string | null {
  if (false === /\brespectively\b/i.test(value)) {
    return null;
  }

  const percentages = [...value.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)]
    .map(percentMatch => Number.parseFloat(percentMatch[1] ?? ""))
    .filter(Number.isFinite);
  if (2 > percentages.length) {
    return null;
  }

  // A plain Tax rate label means the GAAP assumption. When the sentence provides GAAP and
  // non-GAAP assumptions "respectively", map the values by their stated basis instead of
  // turning two distinct measures into a range.
  if (/\bGAAP\s+and\s+non-GAAP\b[^.]{0,180}\btax\s+rate\b/i.test(line)) {
    return formatPercent(percentages[0] ?? 0);
  }

  if (/\bnon-GAAP\s+and\s+GAAP\b[^.]{0,180}\btax\s+rate\b/i.test(line)) {
    return formatPercent(percentages[1] ?? 0);
  }

  return null;
}

function getEpsMoneyRangeValue(value: string, documentCurrencyCode: string): string | null {
  for (const moneyRangeMatch of value.matchAll(moneyRangePattern)) {
    const firstValue = parseNumber(moneyRangeMatch[1]);
    const secondValue = parseNumber(moneyRangeMatch[2]);
    if (null !== firstValue && null !== secondValue) {
      return `${formatEps(firstValue, documentCurrencyCode)} to ${formatEps(secondValue, documentCurrencyCode)}`;
    }
  }

  return null;
}

function getOutlookRangeValue(
  value: string,
  valueType: OutlookValueType,
  documentCurrencyCode: string,
  sectionMoneyUnit?: string,
): string | null {
  // A per-share range is read before a percentage one, so guidance that states the figure
  // and its growth together ("$0.84 to $0.88, representing growth of 28% to 35%") reports
  // the figure. Guidance given only as growth still falls through to the percentage below.
  if ("eps" === valueType && null === getEpsMoneyRangeValue(value, documentCurrencyCode)) {
    const percentRangeValue = getPercentRangeOutlookValue(value);
    if (null !== percentRangeValue) {
      return withPercentGrowthDirection(percentRangeValue, value);
    }
  }

  if ("percent" === valueType) {
    if (/\brespectively\b/i.test(value)) {
      return null;
    }

    const percentRangeMatch = value.match(/(\(?-?\d+(?:\.\d+)?\s*%\)?)\s*(?:to|through|-|–|and)\s*(\(?-?\d+(?:\.\d+)?\s*%\)?)/i);
    const firstPercentValue = parseNumber(percentRangeMatch?.[1]);
    const secondPercentValue = parseNumber(percentRangeMatch?.[2]);
    return null !== firstPercentValue && null !== secondPercentValue
      ? `${formatPercent(firstPercentValue)} to ${formatPercent(secondPercentValue)}`
      : null;
  }

  if ("money" === valueType || "text" === valueType) {
    const translatedRange = getExplicitCurrencyMoneyRangeValue(value, documentCurrencyCode);
    if (null !== translatedRange) {
      return translatedRange;
    }
  }

  for (const moneyRangeMatch of value.matchAll(moneyRangePattern)) {
    const firstRangeValue = moneyRangeMatch[1];
    const secondRangeValue = moneyRangeMatch[2];
    if (undefined === firstRangeValue || undefined === secondRangeValue) {
      continue;
    }

    if ("eps" === valueType) {
      const firstValue = parseNumber(firstRangeValue);
      const secondValue = parseNumber(secondRangeValue);
      if (null !== firstValue && null !== secondValue) {
        return `${formatEps(firstValue, documentCurrencyCode)} to ${formatEps(secondValue, documentCurrencyCode)}`;
      }
      continue;
    }

    if (false === hasMoneyValueCue(firstRangeValue) && false === hasMoneyValueCue(secondRangeValue)) {
      continue;
    }

    const inferredUnit = getMoneyUnit(secondRangeValue) ??
      getMoneyUnit(firstRangeValue) ??
      sectionMoneyUnit;
    const inferredCurrencyCode = getCurrencyCodeFromText(secondRangeValue, documentCurrencyCode) ??
      getCurrencyCodeFromText(firstRangeValue, documentCurrencyCode) ??
      getCurrencyCodeFromText(value, documentCurrencyCode) ??
      documentCurrencyCode;
    const firstMoneyValue = parseMoneyWithOptionalUnit(firstRangeValue, inferredUnit, inferredCurrencyCode);
    const secondMoneyValue = parseMoneyWithOptionalUnit(secondRangeValue, inferredUnit, inferredCurrencyCode);
    if (null !== firstMoneyValue && null !== secondMoneyValue) {
      return `${formatMoneyCompact(firstMoneyValue.value, firstMoneyValue.currencyCode)} to ${formatMoneyCompact(secondMoneyValue.value, secondMoneyValue.currencyCode)}`;
    }
  }

  return null;
}

function getExplicitCurrencyMoneyRangeValue(
  value: string,
  documentCurrencyCode: string,
): string | null {
  const markerByCurrency = new Map<string, string>([
    ["USD", String.raw`(?:US\s*\$|USD)`],
    ["CAD", String.raw`(?:C\s*\$|CAD)`],
    ["EUR", String.raw`(?:€|EUR)`],
    ["GBP", String.raw`(?:£|GBP)`],
    ["JPY", String.raw`(?:¥|JPY)`],
    ["CHF", "CHF"],
  ]);
  const marker = markerByCurrency.get(documentCurrencyCode);
  if (undefined === marker) {
    return null;
  }

  const translatedValuePattern = new RegExp(
    `${marker}\\s*(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(trillions?|billions?|millions?|thousands?|tn|bn|mm|[tbmk])?\\b`,
    "gi",
  );
  const translatedValues = [...value.matchAll(translatedValuePattern)];
  const firstMatch = translatedValues[0];
  const secondMatch = translatedValues[1];
  if (undefined === firstMatch?.[1] ||
      undefined === secondMatch?.[1] ||
      undefined === firstMatch.index ||
      undefined === secondMatch.index) {
    return null;
  }

  const betweenTranslations = value.slice(
    firstMatch.index + firstMatch[0].length,
    secondMatch.index,
  );
  if (false === /\b(?:and|to|through)\b|[-–—]/i.test(betweenTranslations)) {
    return null;
  }

  const firstValue = parseMoneyWithOptionalUnit(
    `${firstMatch[1]} ${firstMatch[2] ?? secondMatch[2] ?? ""}`,
    undefined,
    documentCurrencyCode,
  );
  const secondValue = parseMoneyWithOptionalUnit(
    `${secondMatch[1]} ${secondMatch[2] ?? firstMatch[2] ?? ""}`,
    undefined,
    documentCurrencyCode,
  );
  return null !== firstValue && null !== secondValue
    ? `${formatMoneyCompact(firstValue.value, firstValue.currencyCode)} to ${formatMoneyCompact(secondValue.value, secondValue.currencyCode)}`
    : null;
}

function getSingleOutlookValue(
  value: string,
  valueType: OutlookValueType,
  documentCurrencyCode: string,
  sectionMoneyUnit?: string,
): string | null {
  if ("percent" === valueType) {
    const percentMatch = value.match(/\(?-?\d+(?:\.\d+)?\s*%\)?/);
    const percentValue = parseNumber(percentMatch?.[0]);
    if (null === percentValue || null === percentMatch) {
      return null;
    }

    return percentMatch[0].trim().startsWith("(")
      ? formatPercent(percentValue)
      : percentMatch[0].replace(/\s+/g, "");
  }

  if ("eps" === valueType) {
    const epsValue = findNumericValue(value, {maxAbsValue: 100, skipPercentages: true});
    return null === epsValue ? null : formatEps(epsValue, documentCurrencyCode);
  }

  if ("money" === valueType) {
    const inferredCurrencyCode = getCurrencyCodeFromText(value, documentCurrencyCode) ?? documentCurrencyCode;
    for (const moneyMatch of value.matchAll(singleMoneyPattern)) {
      const token = moneyMatch[0];
      if (false === hasMoneyValueCue(token)) {
        continue;
      }

      const moneyValue = parseMoneyWithOptionalUnit(token, sectionMoneyUnit, inferredCurrencyCode);
      if (null !== moneyValue) {
        return formatMoneyCompact(moneyValue.value, moneyValue.currencyCode);
      }
    }
  }

  return null;
}

function getEpsPercentOutlookValue(value: string): string | null {
  const percentMatch = value.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (undefined === percentMatch?.[1]) {
    return null;
  }

  return withPercentGrowthDirection(formatPercent(Number.parseFloat(percentMatch[1])), value);
}

function getPercentRangeOutlookValue(value: string): string | null {
  const percentRangeMatch = value.match(/(\(?-?\d+(?:\.\d+)?\s*%\)?)\s*(?:to|through|-|–|and)\s*(\(?-?\d+(?:\.\d+)?\s*%\)?)/i);
  const firstPercentValue = parseNumber(percentRangeMatch?.[1]);
  const secondPercentValue = parseNumber(percentRangeMatch?.[2]);
  return null !== firstPercentValue && null !== secondPercentValue
    ? `${formatPercent(firstPercentValue)} to ${formatPercent(secondPercentValue)}`
    : null;
}

function withPercentGrowthDirection(value: string, source: string): string {
  if (/\b(?:decline|decrease|down|lower)\b/i.test(source)) {
    return `${value} decline`;
  }

  if (/\b(?:growth|grow|increase|up|higher)\b/i.test(source)) {
    return `${value} growth`;
  }

  return value;
}

function findNumericValue(
  text: string,
  options: {maxAbsValue?: number; skipPercentages?: boolean;} = {},
): number | null {
  const numberMatches = text.matchAll(/\(?-?(?:[$€£¥]\s*|\b(?:USD|EUR|GBP|JPY|CHF)\s+)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?/gi);
  for (const numberMatch of numberMatches) {
    const token = numberMatch[0];
    const endIndex = numberMatch.index + token.length;
    const beforeToken = text.slice(Math.max(0, numberMatch.index - 4), numberMatch.index);
    if (/\b(?:Q|FY)\s*$/i.test(beforeToken)) {
      continue;
    }

    if (true === options.skipPercentages && "%" === text.slice(endIndex, endIndex + 1)) {
      continue;
    }

    // "53rd week" and similar calendar ordinals are not per-share figures. They occur in
    // outlook prose next to EPS growth language and otherwise look like plausible bare EPS.
    if (/^\s*(?:st|nd|rd|th)\b/i.test(text.slice(endIndex, endIndex + 5))) {
      continue;
    }

    const value = parseNumber(token);
    if (null === value) {
      continue;
    }

    if ("number" === typeof options.maxAbsValue && Math.abs(value) > options.maxAbsValue) {
      continue;
    }

    return value;
  }

  return null;
}

function parseNumber(value: unknown): number | null {
  if ("number" === typeof value) {
    return Number.isFinite(value) ? value : null;
  }

  if ("string" !== typeof value) {
    return null;
  }

  const normalizedValue = value.trim()
    // A scale outside accounting parentheses carries the same sign as the value inside.
    // Normalize it before the general parenthetical conversion below.
    .replace(
      new RegExp(String.raw`^\(([^)]+)\)\s*(${moneyUnitPatternSource})$`, "i"),
      "-$1 $2",
    )
    .replace(/^\((.*)\)$/, "-$1")
    .replace(/US\s*\$/gi, "")
    .replace(/C\s*\$/g, "")
    .replace(/[€£¥$]/g, "")
    .replace(/\b(?:usd|cad|eur|gbp|jpy|chf)\b/gi, "")
    .replaceAll(",", "")
    .replaceAll("%", "")
    .trim()
    .toLowerCase();

  if ("" === normalizedValue || "--" === normalizedValue || "n/a" === normalizedValue) {
    return null;
  }

  const parsedValue = Number.parseFloat(normalizedValue);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function parseMoneyWithOptionalUnit(
  value: string,
  inferredUnit?: string,
  inferredCurrencyCode = "USD",
): ParsedMoneyValue | null {
  const parsedValue = parseNumber(value);
  if (null === parsedValue) {
    return null;
  }

  const unit = getMoneyUnit(value) ?? inferredUnit;
  const currencyCode = getCurrencyCodeFromText(value, inferredCurrencyCode) ?? inferredCurrencyCode;
  let moneyValue = parsedValue;
  if (!unit) {
    return {
      currencyCode,
      value: moneyValue,
    };
  }

  if ("trillion" === unit || "trillions" === unit || "tn" === unit || "t" === unit) {
    moneyValue = parsedValue * 1_000_000_000_000;
  } else if ("billion" === unit || "billions" === unit || "bn" === unit || "b" === unit) {
    moneyValue = parsedValue * 1_000_000_000;
  } else if ("thousand" === unit || "thousands" === unit || "k" === unit) {
    moneyValue = parsedValue * 1_000;
  } else {
    moneyValue = parsedValue * 1_000_000;
  }

  return {
    currencyCode,
    value: moneyValue,
  };
}

function hasMoneyValueCue(value: string): boolean {
  return /[$€£¥]|\b(?:USD|CAD|EUR|GBP|JPY|CHF)\b/i.test(value) || undefined !== getMoneyUnit(value);
}

function getMoneyUnit(value: string): string | undefined {
  return value.match(/(trillions?|billions?|millions?|thousands?|tn|bn|mm|[tbmk])\b/i)?.[1]?.toLowerCase();
}

function getCurrencyCodeFromText(
  text: string,
  dollarCurrencyCode = "USD",
): string | undefined {
  if (/(?:^|[^A-Za-z])C\s*\$/.test(text) || /\bCAD\b|\bCanadian dollars?\b/i.test(text)) {
    return "CAD";
  }

  if (text.includes("€") || /\bEUR\b/i.test(text)) {
    return "EUR";
  }

  if (text.includes("£") || /\bGBP\b/i.test(text)) {
    return "GBP";
  }

  if (text.includes("¥") || /\bJPY\b/i.test(text)) {
    return "JPY";
  }

  if (/\bCHF\b/i.test(text)) {
    return "CHF";
  }

  if (/US\s*\$|\bUSD\b|\bU\.S\. dollars?\b/i.test(text)) {
    return "USD";
  }

  if (text.includes("$")) {
    return dollarCurrencyCode;
  }

  return undefined;
}

function formatEps(value: number, currencyCode: string): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}${getCurrencySymbol(currencyCode)}${Math.abs(value).toFixed(2).replace(/\.?0+$/, "")}`;
}

function formatMoneyCompact(value: number, currencyCode: string): string {
  const symbol = getCurrencySymbol(currencyCode);
  const absoluteValue = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absoluteValue >= 1_000_000_000_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000_000_000_000)}T`;
  }

  if (absoluteValue >= 1_000_000_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000_000_000)}B`;
  }

  if (absoluteValue >= 1_000_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000_000)}M`;
  }

  if (absoluteValue >= 1_000) {
    return `${sign}${symbol}${formatDecimal(absoluteValue / 1_000)}K`;
  }

  return `${sign}${symbol}${formatDecimal(absoluteValue)}`;
}

function getCurrencySymbol(currencyCode: string): string {
  if ("CAD" === currencyCode) {
    return "C$";
  }

  if ("EUR" === currencyCode) {
    return "€";
  }

  if ("GBP" === currencyCode) {
    return "£";
  }

  if ("JPY" === currencyCode) {
    return "¥";
  }

  if ("CHF" === currencyCode) {
    return "CHF ";
  }

  return "$";
}

function formatDecimal(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function formatPercent(value: number): string {
  return `${formatDecimal(value)}%`;
}
