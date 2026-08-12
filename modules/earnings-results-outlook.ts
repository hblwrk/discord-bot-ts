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
};

const moneyUnitPatternSource = String.raw`(?:trillions?|billions?|millions?|thousands?|tn|bn|mm|[tbmk])\b`;
// Some releases close accounting parentheses before the scale word — "($400) million" —
// while others put the scale inside them — "($400 million)". Treat both forms as one
// token so the scale and negative sign survive range parsing.
const moneyTokenPatternSource = String.raw`(?<![\d.])\(?\s*(?:(?:C\s*\$|[$€£¥])\s*|(?:(?:USD|CAD|EUR|GBP|JPY|CHF)\s+))?-?\d+(?:,\d{3})*(?:\.\d+)?\s*\)?\s*(?:${moneyUnitPatternSource})?\)?`;
const moneyRangePattern = new RegExp(`(${moneyTokenPatternSource})\\s*(?:to|through|-|–|and)\\s*(${moneyTokenPatternSource})`, "gi");
const singleMoneyPattern = new RegExp(moneyTokenPatternSource, "gi");

// Held separately because a plainly captioned per-share row is relabelled to it when the
// section declares a non-GAAP basis, and the two must not drift apart.
const adjustedEpsDefinition: OutlookMetricDefinition = {
  key: "adjusted_eps",
  label: "Adj EPS",
  patterns: [
    /\badjusted\s+continuing(?:\s+operations?)?\s+(?:diluted\s+)?eps\b/i,
    /\badjusted\s+continuing(?:\s+operations?)?\s+earnings\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b/i,
    /\badjusted\s+(?:diluted\s+)?eps\b/i,
    /\badjusted\s+(?:diluted\s+)?(?:earnings|net\s+income)\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b/i,
    /\bnon-gaap\s+(?:diluted\s+)?(?:eps|(?:earnings|net\s+income)\s+per\s+(?:common\s+)?(?:diluted\s+)?share)\b/i,
  ],
  valueType: "eps",
};

const outlookMetricDefinitions: OutlookMetricDefinition[] = [
  {
    key: "revenue",
    label: "Revenue",
    patterns: [/\brevenues?\b/i, /\bnet\s+sales\b/i],
    valueType: "text",
  },
  adjustedEpsDefinition,
  {
    key: "eps",
    label: "EPS",
    patterns: [
      new RegExp(String.raw`${gaapTermSource}\s+(?:continuing(?:\s+operations?)?\s+)?(?:diluted\s+)?eps\b`, "i"),
      new RegExp(String.raw`${gaapTermSource}\s+(?:diluted\s+)?(?:earnings|net\s+income)\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b`, "i"),
      // Guidance for a non-GAAP per-share measure must not be posted under the GAAP label,
      // so an occurrence carrying that qualifier is passed over. One sentence often guides
      // on both measures ("Earnings per Share (EPS) is expected to be between $4.05 and
      // $4.25 ... Adjusted EPS is estimated in the range of $4.80 to $5.00"), so this
      // rejects the qualified occurrence rather than the whole line, which would discard
      // the GAAP figure alongside it.
      /(?<!\b(?:adjusted|non-gaap)\s)(?<!\b(?:adjusted|non-gaap)\s\w{1,14}\s)\b(?:continuing(?:\s+operations?)?\s+)?(?:diluted\s+)?eps\b/i,
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
    patterns: [/\boperating\s+margin\b/i],
    valueType: "percent",
  },
  {
    key: "operating_income",
    label: "Operating income",
    patterns: [/\boperating\s+income\b/i],
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
      // Every row of a revised-guidance table covers the same period, so the rows are not
      // asked to name it themselves — which they cannot, and which would discard them all.
      section.mixedPeriods && false === section.revisedColumns,
      section.heading,
      documentCurrencyCode,
      section.revisedColumns,
      section.moneyUnit,
      section.nonGaapMeasures,
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
  const sectionLines: string[] = [];
  let collecting = false;
  let heading: string | undefined;
  let mixedPeriods = false;

  for (const line of lines) {
    if (true === isOutlookHeading(line)) {
      collecting = true;
      heading = line;
      mixedPeriods = isMixedPeriodOutlookHeading(line);
      continue;
    }

    if (false === collecting) {
      continue;
    }

    if (true === isOutlookSectionEnd(line)) {
      break;
    }

    sectionLines.push(line);
    if (sectionLines.length >= 30) {
      break;
    }
  }

  return {
    heading,
    moneyUnit: getSectionMoneyUnit(sectionLines),
    lines: sectionLines,
    mixedPeriods: mixedPeriods || hasMixedOutlookPeriods(sectionLines),
    nonGaapMeasures: hasNonGaapGuidanceBasis(sectionLines),
    revisedColumns: sectionLines.some(line => hasRevisedColumnHeader(line)),
  };
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
  return /\bprior\b/i.test(line) &&
    /\bupdated\b/i.test(line) &&
    false === /\d/.test(line);
}

function hasMixedOutlookPeriods(lines: string[]): boolean {
  const sectionText = lines.join(" ");
  const hasQuarter = /\b(?:q[1-4]|first|second|third|fourth)[\s–—-]+quarter\b/i.test(sectionText) ||
    /\bq[1-4]\b/i.test(sectionText);
  return hasQuarter && hasStandaloneFullYearPeriod(sectionText);
}

function isOutlookHeading(line: string): boolean {
  if (line.length > 140 ||
      /\b(?:announces?|reports?|reported|results?)\b/i.test(line) ||
      /\bforward-looking\s+statements?\b/i.test(line)) {
    return false;
  }

  const normalizedLine = line
    .replace(/^[\s•–—-]+/, "")
    .replace(/[\s|–—-]+$/, "")
    .trim();

  return /^(?:business\s+|financial\s+)?(?:outlook|guidance)\b/i.test(normalizedLine) ||
    /^(?:the\s+)?company\s+(?:raises?|updates?|reaffirms?|provides?|issues?)\b.*\b(?:outlook|guidance)\b/i.test(normalizedLine) ||
    /^(?:(?:(?:fiscal(?:\s+year)?|fiscal\s+full[\s–—-]+year)\s+)?(?:20\d{2}|fy\s?\d{2}|q[1-4]\s+20\d{2}|quarter)|(?:first|second|third|fourth)[\s–—-]+quarter)\b.*\b(?:outlook|guidance)\b/i.test(normalizedLine);
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

  if (/\b(?:conference\s+call|about\s+|press\s+contact|investor\s+relations|condensed\s+consolidated|financial\s+statements?)\b/i.test(line)) {
    return true;
  }

  if (line.length <= 140 &&
      /^\s*(?:use\s+of\s+)?(?:non-gaap|reconciliation)\b/i.test(line) &&
      false === /\d|\|/.test(line)) {
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
): EarningsOutlookMetric[] {
  const bestCandidateByPeriod = new Map<string, OutlookMetricCandidate>();
  for (const [lineIndex, line] of lines.entries()) {
    if (false === revisedColumns && true === isNoisyOutlookLine(line)) {
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
      const valueLine = true === revisedColumns && false === /\d/.test(line)
        ? `${line} ${lines[lineIndex + 1] ?? ""}`
        : line;
      const value = extractOutlookValue(
        valueLine,
        pattern,
        definition.key,
        definition.valueType,
        documentCurrencyCode,
        revisedColumns,
        sectionMoneyUnit,
      );
      if (null === value) {
        continue;
      }

      const periodLabel = true === includePeriodLabel
        ? getOutlookPeriodLabel(lines, lineIndex)
        : undefined;
      if (true === includePeriodLabel && undefined === periodLabel) {
        continue;
      }

      // The row's own caption wins where it has one: a line naming GAAP keeps the reported
      // label even inside a non-GAAP section, which is how a table guiding on both measures
      // stays intelligible. Revenue is never relabelled — the sentence that declares the
      // basis names revenue as the GAAP item.
      const isAdjustedBySectionBasis = "eps" === definition.key &&
        true === nonGaapMeasures &&
        false === hasStandaloneGaapTerm(line);
      const metric: EarningsOutlookMetric = {
        key: isAdjustedBySectionBasis ? adjustedEpsDefinition.key : definition.key,
        label: isAdjustedBySectionBasis ? adjustedEpsDefinition.label : definition.label,
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

function getOutlookPeriodLabel(lines: string[], lineIndex: number): string | undefined {
  const directPeriodLabel = getLineOutlookPeriodLabel(lines[lineIndex] ?? "");
  if (undefined !== directPeriodLabel) {
    return directPeriodLabel;
  }

  // Some releases introduce a short group of bullets with a standalone period caption.
  // Only inherit from that caption form: looking back through ordinary metric rows leaks
  // one row's period onto the next otherwise-unlabelled row.
  for (let index = lineIndex - 1; index >= 0 && index >= lineIndex - 4; index--) {
    const contextLine = lines[index] ?? "";
    if (false === /^\s*for\s+the\s+(?:(?:first|second|third|fourth)\s+quarter|full[\s–—-]+year)\b[^:]{0,40}\b(?:we|the\s+company)\s+expect\s*:\s*$/i.test(contextLine)) {
      continue;
    }

    return getLineOutlookPeriodLabel(contextLine);
  }

  return undefined;
}

function getLineOutlookPeriodLabel(line: string): string | undefined {
  const periodCandidates: {index: number; label: string;}[] = [];
  const directQuarterMatch = /\bq([1-4])(?:\s+20\d{2})?\b/i.exec(line);
  if (undefined !== directQuarterMatch?.[1]) {
    periodCandidates.push({
      index: directQuarterMatch.index,
      label: `Q${directQuarterMatch[1]}`,
    });
  }

  const writtenQuarterMatch = /\b(first|second|third|fourth)[\s–—-]+quarter\b/i.exec(line);
  if (undefined !== writtenQuarterMatch?.[1]) {
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

  return periodCandidates.sort((first, second) => first.index - second.index)[0]?.label;
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
  return /\b(?:reported|generated|was|were|amounted|totaled)\b/i.test(line) &&
    false === /\b(?:expects?|expected|guidance|outlook|forecast|projected|targets?|targeting|anticipates?|anticipated|reaffirms?|reiterates?|maintains?|raises?|raised)\b/i.test(line);
}

function isNoisyOutlookLine(line: string): boolean {
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
  return (pipeCount >= 4 && false === isSparseTwoColumnRow) ||
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
): string | null {
  pattern.lastIndex = 0;
  const patternMatch = pattern.exec(line);
  for (const rawValueText of getOutlookValueSegments(line, patternMatch, revisedColumns)) {
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
      ("eps" === valueType
        ? getOutlookRangeValue(valueText, valueType, documentCurrencyCode, sectionMoneyUnit)
        : null) ??
      getGrowthOutlookValue(valueText) ??
      getOutlookRangeValue(valueText, valueType, documentCurrencyCode, sectionMoneyUnit) ??
      ("eps" === valueType ? getEpsPercentOutlookValue(valueText) : null) ??
      ("text" === valueType ? getSingleOutlookValue(valueText, "money", documentCurrencyCode) : null) ??
      ("text" === valueType ? getNumericGrowthOutlookValue(valueText) : null) ??
      getSingleOutlookValue(valueText, valueType, documentCurrencyCode, sectionMoneyUnit);
    if (null !== value) {
      return applyOutlookLossSign(value, valueText, valueType);
    }
  }

  return null;
}

function applyOutlookLossSign(
  value: string,
  source: string,
  valueType: OutlookValueType,
): string {
  if (false === ("money" === valueType || "eps" === valueType) ||
      false === /^\s*(?:a\s+)?loss\b/i.test(source)) {
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

  const rawValueText = line.slice(patternMatch.index + patternMatch[0].length);
  const nextMetricPattern = /\b(?:adjusted\s+(?:continuing\s+)?eps|gaap\s+(?:continuing\s+)?eps|diluted\s+eps|eps|(?:(?:adjusted|non-gaap|gaap)\s+)?(?:earnings|net\s+income)\s+per\s+(?:common\s+)?(?:diluted\s+)?share|revenues?|net\s+sales|sales|gross(?:\s+profit)?\s+margin|operating\s+margin|operating\s+income|operating\s+expenses?|opex|tax\s+rate|capex|capital\s+expenditures?|free\s+cash\s+flow|dcf\s+per\s+share|distributable\s+cash\s+flow\s+per\s+share|adjusted\s+ebitda\s+margin|adjusted\s+ebitda|ebitda)\b/gi;
  const currentCaptionPattern = new RegExp(
    patternMatch[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );
  const nextMetricMatch = [...rawValueText.matchAll(nextMetricPattern)]
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
    rawValueText.slice(0, endIndex),
    previousValueText,
  ];
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

    const percentRangeMatch = value.match(/(-?\d+(?:\.\d+)?)\s*%\s*(?:to|through|-|–|and)\s*(-?\d+(?:\.\d+)?)\s*%/i);
    return undefined !== percentRangeMatch?.[1] && undefined !== percentRangeMatch[2]
      ? `${formatPercent(Number.parseFloat(percentRangeMatch[1]))} to ${formatPercent(Number.parseFloat(percentRangeMatch[2]))}`
      : null;
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

function getSingleOutlookValue(
  value: string,
  valueType: OutlookValueType,
  documentCurrencyCode: string,
  sectionMoneyUnit?: string,
): string | null {
  if ("percent" === valueType) {
    const percentMatch = value.match(/-?\d+(?:\.\d+)?\s*%/);
    return percentMatch ? percentMatch[0].replace(/\s+/g, "") : null;
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
  const percentRangeMatch = value.match(/(-?\d+(?:\.\d+)?)\s*%\s*(?:to|through|-|–|and)\s*(-?\d+(?:\.\d+)?)\s*%/i);
  return undefined !== percentRangeMatch?.[1] && undefined !== percentRangeMatch[2]
    ? `${formatPercent(Number.parseFloat(percentRangeMatch[1]))} to ${formatPercent(Number.parseFloat(percentRangeMatch[2]))}`
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

  const normalizedValue = value
    // A scale outside accounting parentheses carries the same sign as the value inside.
    // Normalize it before the general parenthetical conversion below.
    .replace(
      new RegExp(String.raw`^\(([^)]+)\)\s*(${moneyUnitPatternSource})$`, "i"),
      "-$1 $2",
    )
    .replace(/^\((.*)\)$/, "-$1")
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
