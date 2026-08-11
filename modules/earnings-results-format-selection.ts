type MetricValueType = "eps" | "money" | "number";

// The "adjusted" skip exists so an adjusted figure is never posted as the GAAP one. When
// the GAAP statement is complete before the word appears — "GAAP earnings per share of
// $0.03. Generated $92 million of adjusted EBITDA" — the line still reports GAAP EPS, and
// discarding it loses the only place the figure is stated.
//
// "Non-GAAP" bounds the GAAP statement the same way, and a filer that states both measures in
// one clause uses that word rather than "adjusted": "GAAP diluted net loss per share $0.16;
// non-GAAP diluted net loss per share $0.05". Reading only "adjusted" here discarded the line
// and with it the reported figure, leaving the adjusted one posted alone.
export function hasGaapNarrativeBeforeAdjustment(line: string, patterns: RegExp[]): boolean {
  const adjustedIndex = line.search(/\badjusted\b|\bnon-gaap\b/i);
  if (-1 === adjustedIndex) {
    return false;
  }

  const gaapText = line.slice(0, adjustedIndex);
  return patterns.some(pattern => {
    pattern.lastIndex = 0;
    const patternMatch = pattern.exec(gaapText);
    if (null === patternMatch) {
      return false;
    }

    return undefined !== patternMatch.groups?.["metricValue"] ||
      /[$€£¥]\s*\(?-?\d+\.\d{2}\b/.test(gaapText.slice(patternMatch.index));
  });
}

export function getMetricCandidateScore({
  lines,
  lineIndex,
  metricKey,
  metricLine,
  pattern,
  quarterLabel,
  valueType,
}: {
  lines: string[];
  lineIndex: number;
  metricKey: string;
  metricLine: string;
  pattern: RegExp;
  quarterLabel: string | undefined;
  valueType: MetricValueType;
}): number {
  pattern.lastIndex = 0;
  const patternMatch = pattern.exec(metricLine);
  let score = undefined === patternMatch?.groups?.["metricValue"] ? 0 : 80;
  const nearbyContext = lines
    .slice(Math.max(0, lineIndex - 2), lineIndex + 1)
    .join(" ");

  if (undefined !== quarterLabel) {
    score += getCurrentQuarterTextScore(metricLine, quarterLabel);
    score += Math.floor(getCurrentQuarterTextScore(nearbyContext, quarterLabel) / 2);
  }

  // A combined statement names both periods in one header ("Three Months Ended | Six Months
  // Ended"); its quarter columns come first and are chosen by column index, so it must not
  // be treated as a year-to-date line.
  // "six-month 2026 earnings were $6.1 billion, or $5.00 per share" states the half-year as an
  // adjective, so the period words have to be matched with the hyphen as well as the space.
  if (/\b(?:YTD|year[-\s]to[-\s]date|six[-\s]months?|nine[-\s]months?|full\s+year|annual)\b/i.test(metricLine) &&
      "quarter" !== getPeriodEndedScope(metricLine)) {
    score -= 60;
  }

  if (/\b(?:increase|decrease|improve|improvement|decline|worsen|change)(?:d)?\s+(?:by|of)\b/i.test(metricLine) ||
      /\b(?:rose|fell|grew|up|down)\s+by\b/i.test(metricLine)) {
    score -= 140;
  }

  // The consolidated statements are the authoritative source, so a table row is
  // preferred over narrative prose restating a figure. Prose mentions of a metric
  // are frequently scoped to a segment, a single product, a prior-year comparative
  // or guidance, none of which is the headline consolidated number.
  if (2 <= (metricLine.match(/\|/g)?.length ?? 0)) {
    score += 25;
  }

  // Whichever period header governs this row/section decides whether its leading
  // column is the quarter or a full-year/YTD figure. A Q4 release prints both, so
  // without this the annual column and the annual narrative bullet are picked.
  const periodScope = getPeriodScope(lines, lineIndex, metricLine);
  if ("quarter" === periodScope) {
    score += 40;
  } else if ("annual" === periodScope) {
    score -= 80;
  }

  // A row under a guidance heading states guidance even where its caption does not say so,
  // so a table of forward ranges is not read as the reported quarter.
  if (true === isUnderGuidanceHeading(lines, lineIndex)) {
    score -= 120;
  }

  if (true === hasForeignPeriodAttribution(metricLine, quarterLabel)) {
    score -= 150;
  }

  // "X and Y in the first and second quarter, respectively" maps values to periods
  // positionally, so the leading value is not the reported quarter.
  if (/\brespectively\b/i.test(metricLine)) {
    score -= 100;
  }

  if (null !== patternMatch && true === isComparisonClause(metricLine, patternMatch.index)) {
    score -= 150;
  }

  // A company may publish its standard adjusted EPS and then an additional figure that
  // removes a one-off item from that adjusted result. The plain "Adj EPS" label refers to
  // the company-reported non-GAAP measure; an "excluding ..." variant needs a distinct
  // label, so prefer the unqualified candidate when the filing provides both.
  if ("adjusted_eps" === metricKey &&
      null !== patternMatch &&
      true === hasExcludingQualifierAroundMetric(
        metricLine,
        patternMatch.index,
        patternMatch.index + patternMatch[0].length,
      )) {
    score -= 130;
  }

  if (("eps" === valueType || "money" === valueType) && /[$€£¥]/.test(metricLine)) {
    score += 10;
  }

  if ("eps" === valueType) {
    // Diluted is the headline per-share measure. Statements print the basic row first,
    // so without this preference the basic figure wins on document order.
    if (/\bdiluted\b/i.test(metricLine)) {
      score += 30;
    } else if (/\bbasic\b/i.test(metricLine)) {
      score -= 40;
    }

    // A foreign private issuer reports per-ordinary-share earnings in minor units and
    // per-ADS in dollars; the ADS figure is the one comparable to a US-listed EPS.
    if (/\bper\s+ADS\b/i.test(metricLine)) {
      score += 60;
    } else if (/\(\s*cents(?:\s+per\s+share)?\s*\)/i.test(metricLine)) {
      score -= 60;
    }
  }

  if ("eps" === valueType && /\bper\s+(?:common\s+)?(?:diluted\s+)?share\b/i.test(metricLine)) {
    score += 10;
  }

  return score;
}

export function hasStandaloneFullYearPeriod(text: string): boolean {
  if (/\bfull[\s–—-]+year\b/i.test(text)) {
    return true;
  }

  const fiscalPeriodPattern = /\b(?:fiscal(?:\s+year)?|fy)\s*(?:of\s+)?(?:20\d{2}|\d{2})\b/gi;
  for (const periodMatch of text.matchAll(fiscalPeriodPattern)) {
    const precedingText = text.slice(Math.max(0, periodMatch.index - 40), periodMatch.index);
    // "first quarter of fiscal year 2027" names one quarter, not a simultaneous
    // full-year outlook. Only an independently stated fiscal period is annual.
    if (false === /\b(?:q[1-4]|(?:first|second|third|fourth)[\s–—-]+quarter)(?:\s+of)?\s*$/i
      .test(precedingText)) {
      return true;
    }
  }

  return false;
}

function hasExcludingQualifierAroundMetric(
  line: string,
  metricStartIndex: number,
  metricEndIndex: number,
): boolean {
  const clauseStartIndex = Math.max(
    line.lastIndexOf(". ", metricStartIndex),
    line.lastIndexOf(";", metricStartIndex),
    line.lastIndexOf("|", metricStartIndex),
  );
  if (/\bexcluding\b/i.test(line.slice(clauseStartIndex + 1, metricStartIndex))) {
    return true;
  }

  const afterMetric = line.slice(metricEndIndex);
  const firstValueIndex = afterMetric.search(/\(?-?(?:[$€£¥]\s*)?\d/);
  return /\bexcluding\b/i.test(afterMetric.slice(
    0,
    -1 === firstValueIndex ? Math.min(120, afterMetric.length) : firstValueIndex,
  ));
}

export function getPositionedQuarterValues(
  lines: string[],
  lineIndex: number,
  quarterLabel: string | undefined,
): string[] {
  if (undefined === quarterLabel ||
      false === isPositionedValueLine(lines[lineIndex - 1] ?? "") ||
      false === isPositionedValueLine(lines[lineIndex + 1] ?? "") ||
      false === hasPositionedPeriodHeaders(lines, lineIndex, quarterLabel)) {
    return [];
  }

  const precedingValues: string[] = [];
  for (let index = lineIndex - 1; index >= 0 && index >= lineIndex - 8; index--) {
    const line = lines[index];
    if (undefined === line || false === isPositionedValueLine(line)) {
      break;
    }

    precedingValues.unshift(line);
  }

  const numericValues = precedingValues.filter(line => /\d/.test(line));
  return 2 <= numericValues.length ? numericValues : [];
}

export function isEmbeddedAlphaNumericValue(
  text: string,
  startIndex: number,
  endIndex: number,
): boolean {
  const characterBefore = text.slice(Math.max(0, startIndex - 1), startIndex);
  const token = text.slice(startIndex, endIndex);
  if (/[A-Za-z]/.test(characterBefore) && false === /^[$€£¥]/.test(token)) {
    return true;
  }

  const textAfter = text.slice(endIndex, endIndex + 12);
  return /^[A-Za-z]/.test(textAfter) && false === /^(?:cents?|[kmbt])\b/i.test(textAfter);
}

// Superscript footnote markers survive HTML-to-text conversion glued to their label
// ("Reported(4) Diluted EPS", "Earnings per share (Note 7)"). Left in place they parse
// as parenthesised negatives, so "(4)" becomes -$4.00.
export function stripReferenceMarkers(line: string): string {
  const withoutParenthesisedMarkers = line
    .replace(/\(\s*Note\s+\d{1,2}\s*\)/gi, " ")
    // A caption can carry more than one marker ("Earnings per Share(3)(4)").
    .replace(/([A-Za-z])(?: ?\(\d{1,2}\))+/g, "$1");

  // A bare superscript trailing a label ("Profit per common share - diluted 2") is a
  // footnote too. Only strip it where the line carries no value cell of its own, so a
  // real figure is never mistaken for a marker.
  return /[|$€£¥]/.test(withoutParenthesisedMarkers)
    ? withoutParenthesisedMarkers
    : withoutParenthesisedMarkers.replace(/([A-Za-z]) \d{1,2}\s*$/, "$1");
}

// Boilerplate that defines a non-GAAP measure states no figures for the period; any
// number it contains is a footnote marker or a cross-reference.
export function isDefinitionalLine(line: string): boolean {
  return /\b(?:is|are)\s+defined\s+as\b/i.test(line) ||
    /\bshould\s+not\s+be\s+(?:viewed|considered)\b/i.test(line) ||
    /^\s*\(\d{1,2}\)\s*[A-Z]/.test(line);
}

// Statement columns are not ordered consistently across filers: most lead with the
// reported period, but some print the prior year first ("2025 | 2026"). The year header
// governing the row is the only reliable way to know which cell to read.
export function getCurrentPeriodColumnIndex(
  lines: string[],
  lineIndex: number,
  quarterLabel: string | undefined,
): number {
  const reportedYear = /\bQ[1-4]\s+(20\d{2})\b/.exec(quarterLabel ?? "")?.[1];
  if (undefined === reportedYear) {
    return 0;
  }

  // An income statement puts twenty or more rows between its year header and the per-share
  // rows at the bottom, so a short lookback misses the header entirely and the row is read
  // as though the reported period came first. The nearest header still wins, which keeps a
  // row below one table from picking up the header of another.
  for (let index = lineIndex - 1, examined = 0; index >= 0 && examined < 40; index--, examined++) {
    const line = lines[index];
    if (undefined === line) {
      continue;
    }

    // A header naming its columns by period end ("June 30, 2026 | March 31, 2026 |
    // December 31, 2025") does not map onto a year run — and where such a table also carries
    // a year-to-date pair, those bare years look like a run that starts at the wrong column.
    // The row's own header decides the layout either way, so stop here rather than adopting
    // the columns of an unrelated table further up.
    if (true === isPeriodHeaderLine(line)) {
      return 0;
    }

    const headerYears = getColumnHeaderYears(line);
    if (0 === headerYears.length) {
      continue;
    }

    // Combined tables repeat the year across the quarter and year-to-date groups; the
    // quarter group is printed first, so its occurrence is the one to read.
    const columnIndex = headerYears.indexOf(reportedYear);
    return -1 === columnIndex ? 0 : columnIndex;
  }

  return 0;
}

// A column header ends in a run of year cells ("... Three Months Ended March 31 2025
// 2026", "$ million | 2026 | 2025 | 2026 | 2025"). Requiring the years to be separated
// by nothing but cell punctuation keeps prose such as "between 2025 and 2026" out.
// A column header names a period per column, either as a bare year or as a period-end date.
function isPeriodHeaderLine(line: string): boolean {
  const dateColumns = line.match(
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s*(?:20\d{2})?/gi,
  );
  return 2 <= (dateColumns?.length ?? 0);
}

function getColumnHeaderYears(line: string): string[] {
  const yearMatches = [...line.matchAll(/\b20\d{2}\b/g)];
  if (2 > yearMatches.length) {
    return [];
  }

  let runStartIndex = yearMatches.length - 1;
  while (runStartIndex > 0) {
    const previousMatch = yearMatches[runStartIndex - 1];
    const currentMatch = yearMatches[runStartIndex];
    if (undefined === previousMatch || undefined === currentMatch) {
      break;
    }

    const gapText = line.slice(previousMatch.index + previousMatch[0].length, currentMatch.index);
    if (false === /^[\s|$€£¥(),.:;%*\-–—/]*$/.test(gapText)) {
      break;
    }

    runStartIndex--;
  }

  const runYears = yearMatches.slice(runStartIndex).map(yearMatch => yearMatch[0]);
  return 2 <= runYears.length ? runYears : [];
}

type PeriodScope = "annual" | "quarter" | undefined;

const periodScopeLineLimit = 130;

function getPeriodScope(
  lines: string[],
  lineIndex: number,
  metricLine: string,
): PeriodScope {
  // A row inside an explicit "months ended" table carries its own scope, even when a
  // section heading further up says otherwise.
  const ownScope = getPeriodEndedScope(metricLine);
  if (undefined !== ownScope) {
    return ownScope;
  }

  for (let index = lineIndex - 1, examined = 0; index >= 0 && examined < 40; index--, examined++) {
    const line = lines[index];
    if (undefined === line || line.length > periodScopeLineLimit) {
      continue;
    }

    const scope = getLineScope(line);
    if (undefined !== scope) {
      // A combined header may be split one cell per line ("Three Months Ended June 30,"
      // then "Six Months Ended June 30,"), leaving the year-to-date cell nearest the row.
      // The quarter group is still printed first, so the block as a whole is quarter-scoped.
      return "annual" === scope && true === hasQuarterScopeInHeaderBlock(lines, index)
        ? "quarter"
        : scope;
    }
  }

  return undefined;
}

// Only the header block directly above counts. A line carrying figures ends the block, so a
// quarter heading further up a narrative section cannot rescue a full-year one below it.
function hasQuarterScopeInHeaderBlock(lines: string[], scopeLineIndex: number): boolean {
  for (let index = scopeLineIndex - 1; index >= 0 && index >= scopeLineIndex - 3; index--) {
    const line = lines[index];
    if (undefined === line ||
        line.length > periodScopeLineLimit ||
        true === hasFigureCell(line)) {
      return false;
    }

    if ("quarter" === getLineScope(line)) {
      return true;
    }
  }

  return false;
}

function hasFigureCell(line: string): boolean {
  return /[$€£¥]/.test(line) ||
    /\d[\d,]*\.\d/.test(line) ||
    /\b\d{1,3}(?:,\d{3})+\b/.test(line);
}

function getPeriodEndedScope(line: string): PeriodScope {
  if (/\b(?:three|3)\s+months?\s+ended\b/i.test(line) || /\bquarters?\s+ended\b/i.test(line)) {
    return "quarter";
  }

  if (/\b(?:twelve|12|six|6|nine|9)\s+months?\s+ended\b/i.test(line) ||
      /\byear\s+ended\b/i.test(line)) {
    return "annual";
  }

  return undefined;
}

// A heading naming both scopes ("Three Months Ended | Twelve Months Ended",
// "Fourth-Quarter Fiscal Year 2026") introduces quarter columns first, so it counts
// as quarter scope.
function getLineScope(line: string): PeriodScope {
  const periodEndedScope = getPeriodEndedScope(line);
  if ("quarter" === periodEndedScope) {
    return "quarter";
  }

  if (/\b(?:first|second|third|fourth)[\s–—-]+quarter\b/i.test(line) || /\bQ[1-4]\b/.test(line)) {
    return "quarter";
  }

  if (undefined !== periodEndedScope ||
      /\bfiscal\s+year\b/i.test(line) ||
      /\bfull[-\s]year\b/i.test(line) ||
      /\byear[-\s]to[-\s]date\b/i.test(line) ||
      /\bYTD\b/i.test(line)) {
    return "annual";
  }

  return undefined;
}

// A figure introduced by "compared to" is the comparison, not the reported period. Normally
// the caption comes first and the whole line reads as current — "Revenue was $10.2 billion,
// compared with $9.1 billion" — but a hard line break inside a paragraph can leave the
// comparison clause standing alone as its own line, carrying the reported period's date with
// it: "...period ended June 30, 2026, compared to net income of $7.2 million". So the clause
// is recognised from the caption's position, and only where the caption follows the comparison
// marker directly. A caption further along the line ("compared with $9.1 billion, and adjusted
// EPS was $1.42") still states the reported period.
function isComparisonClause(line: string, captionIndex: number): boolean {
  return /\b(?:compared\s+(?:to|with)|versus|vs\.?)\s+(?:a\s+|the\s+)?$/i
    .test(line.slice(0, captionIndex));
}

// A row under a guidance heading is guidance whatever its caption says, so the heading is
// searched for upwards from the row, stopping at whatever heading ends that section.
function isUnderGuidanceHeading(lines: string[], lineIndex: number): boolean {
  for (let index = lineIndex - 1, examined = 0; index >= 0 && examined < 14; index--, examined++) {
    const line = lines[index];
    if (undefined === line || line.length > 130) {
      continue;
    }

    const heading = line.replace(/^[\s•–—-]+/, "").replace(/[\s|:]+$/, "");
    if (/\b(?:outlook|guidance)\b/i.test(heading) && 90 > heading.length) {
      return true;
    }

    // A results or statement heading ends the guidance section above it.
    if (/\b(?:results|statements?\s+of\s+operations|balance\s+sheets?|highlights)\b/i.test(heading) &&
        90 > heading.length) {
      return false;
    }
  }

  return false;
}

function hasForeignPeriodAttribution(
  metricLine: string,
  quarterLabel: string | undefined,
): boolean {
  const quarterYear = /\bQ[1-4]\s+(20\d{2})\b/.exec(quarterLabel ?? "")?.[1];
  if (undefined === quarterYear) {
    return false;
  }

  const attributionPattern =
    /\b(?:for|in)\s+(?:the\s+)?(?:first|second|third|fourth)[\s–—-]+quarter\s+(?:of\s+)?(20\d{2})\b/gi;
  for (const attributionMatch of metricLine.matchAll(attributionPattern)) {
    if (attributionMatch[1] !== quarterYear) {
      return true;
    }
  }

  return false;
}

function getCurrentQuarterTextScore(text: string, quarterLabel: string): number {
  const quarterMatch = /^(Q[1-4])\s+(20\d{2})$/.exec(quarterLabel);
  if (undefined === quarterMatch?.[1] || undefined === quarterMatch[2]) {
    return 0;
  }

  const quarterNumber = quarterMatch[1].slice(1);
  const quarterName = ["", "first", "second", "third", "fourth"][Number.parseInt(quarterNumber, 10)] ?? "";
  const hasQuarter = new RegExp(`\\b(?:Q${quarterNumber}|${quarterName})[\\s–—-]+quarter\\b`, "i").test(text) ||
    new RegExp(`\\bQ${quarterNumber}\\b`, "i").test(text);
  if (false === hasQuarter) {
    return 0;
  }

  return new RegExp(`\\b${quarterMatch[2]}\\b`).test(text) ? 50 : 25;
}

function hasPositionedPeriodHeaders(
  lines: string[],
  lineIndex: number,
  quarterLabel: string,
): boolean {
  const quarterMatch = /^Q([1-4])\s+(20\d{2})$/.exec(quarterLabel);
  if (undefined === quarterMatch?.[1] || undefined === quarterMatch[2]) {
    return false;
  }

  const yearSuffix = quarterMatch[2].slice(-2);
  const context = lines.slice(Math.max(0, lineIndex - 240), lineIndex).join(" ");
  return new RegExp(`\\b(?:Q${quarterMatch[1]}|${quarterMatch[1]}Q)\\s*${yearSuffix}\\b`, "i").test(context) &&
    /\bYTD\b/i.test(context) &&
    /\bchange\b/i.test(context);
}

function isPositionedValueLine(line: string): boolean {
  return /^[\s|$€£¥(),.+\-\d%—–]+$/.test(line);
}
