type MetricValueType = "eps" | "money" | "number";

export function hasGaapNarrativeBeforeAdjustment(line: string, patterns: RegExp[]): boolean {
  const adjustedIndex = line.search(/\badjusted\b/i);
  const gaapText = -1 === adjustedIndex ? line : line.slice(0, adjustedIndex);
  return patterns.some(pattern => {
    pattern.lastIndex = 0;
    return undefined !== pattern.exec(gaapText)?.groups?.["metricValue"];
  });
}

export function getMetricCandidateScore({
  lines,
  lineIndex,
  metricLine,
  pattern,
  quarterLabel,
  valueType,
}: {
  lines: string[];
  lineIndex: number;
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

  if (/\b(?:YTD|year[-\s]to[-\s]date|six\s+months|nine\s+months|full\s+year|annual)\b/i.test(metricLine)) {
    score -= 60;
  }

  if (/\b(?:increase|decrease|improvement|decline|change)(?:d)?\s+(?:by|of)\b/i.test(metricLine) ||
      /\b(?:rose|fell|grew|up|down)\s+by\b/i.test(metricLine)) {
    score -= 140;
  }

  const pipeCount = metricLine.match(/\|/g)?.length ?? 0;
  score -= Math.min(30, pipeCount * 2);
  if (("eps" === valueType || "money" === valueType) && /[$€£¥]/.test(metricLine)) {
    score += 10;
  }

  if ("eps" === valueType && /\bper\s+(?:common\s+)?(?:diluted\s+)?share\b/i.test(metricLine)) {
    score += 10;
  }

  return score;
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
