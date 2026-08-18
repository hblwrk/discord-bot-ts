import {
  getPositionedQuarterValues,
  isDefinitionalLine,
} from "./earnings-results-format-selection.ts";
import {gaapTermSource, unitedStatesSource} from "./earnings-results-terms.ts";
import {getMoneyScaleFromContextText} from "./earnings-results-money.ts";

export type EarningsResultOutcome = "beat" | "inline" | "miss";

export type EarningsResultMetric = {
  currencyCode?: string | undefined;
  estimate?: string | undefined;
  key: string;
  label: string;
  numericValue?: number | undefined;
  outcome?: EarningsResultOutcome | undefined;
  sourceSnippet?: string | undefined;
  value: string;
};

export type MetricValueType = "eps" | "money" | "number";

export type MetricDefinition = {
  key: string;
  label: string;
  patterns: RegExp[];
  skipPattern?: RegExp;
  valueType: MetricValueType;
};

export type MetricLineSelection = {
  exclusive: boolean;
  lines: string[];
};

export const earningsMetricDefinitions: MetricDefinition[] = [
  {
    key: "affo_per_share",
    label: "AFFO/share",
    patterns: [
      /\baffo\s+(?:and\s+affo\s+)?per\s+(?:common\s+)?share\b/i,
      /\badjusted\s+funds?\s+from\s+operations?\s+per\s+(?:common\s+)?share\b/i,
    ],
    valueType: "eps",
  },
  {
    key: "adjusted_eps",
    label: "Adj EPS",
    patterns: [
      // A translated ADS value can follow the local-currency amount in parentheses.
      // Capture the US-dollar figure explicitly so the ordinary-share amount before it
      // cannot win merely because it appears first.
      /\bnon-gaap\s+(?:fully\s+)?(?:diluted\s+)?(?:earnings|net\s+income|net\s+loss|loss)\s+per\s+(?:diluted\s+)?ADS\b.{0,80}?\(\s*(?<metricValue>US\s*\$\s*\d+(?:\.\d+)?)\s*\)/i,
      // Some releases state non-GAAP net income and then introduce its per-share
      // equivalent with "or", without ever spelling out EPS as a caption.
      /\b(?:reported|for)\s+(?:the\s+)?(?:q[1-4]|first|second|third|fourth)[\s–—-]+quarter\b(?:(?![.!?]\s)[^!?\n]){0,360}?\bnon-gaap\s+(?:net\s+)?(?:income|earnings|loss)\b(?:(?![.!?]\s)[^!?\n]){0,180}?\bor\s+(?<metricValue>\(?-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?)\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b/i,
      // The period can be established by the surrounding results section rather than
      // repeated in the sentence: "Non-GAAP net income was $531 million, or $3.07 per
      // share." The aggregate amount before "or" must not be mistaken for EPS.
      /\bnon-gaap\s+(?:net\s+)?(?:income|earnings|loss)\b(?:(?![.!?]\s)[^!?\n]){0,180}?\bor\s+(?<metricValue>\(?-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?)\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b/i,
      /\badjusted\b(?:(?![.!?]\s)[^!?\n]){0,180}?(?<metricValue>-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+per\s+(?:common\s+)?(?:diluted\s+)?share(?:\s*[-–—]\s*diluted)?\b/i,
      /\bnon-gaap\s+(?:net\s+)?(?:income|earnings|loss)\s+for\s+(?:the\s+)?(?:q[1-4]|(?:first|second|third|fourth)[\s–—-]+quarter)\b(?:(?![.!?]\s)[^!?\n]){0,180}?(?<metricValue>-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+per\s+(?:common\s+)?(?:diluted\s+)?share(?:\s*[-–—]\s*diluted)?\b/i,
      /\badjusted\s+(?:\d{1,2}\s+)?(?:continuing(?:\s+operations?)?\s+)?(?:diluted\s+)?(?:earnings\s+per\s+(?:common\s+)?share|eps)\b/i,
      /\bnon-gaap\s+(?:fully\s+)?(?:diluted\s+)?eps\b/i,
      /\bnon-gaap\s+(?:diluted\s+)?(?:earnings\s+per\s+share|eps)\b/i,
      // "Non-GAAP diluted net income per share" / "Non-GAAP Diluted Loss Per Share" are
      // the reconciliation-table labels for the same measure. "Diluted" also appears on the
      // far side of "per" — "non-GAAP net income per diluted share" — and without that
      // spelling the measure's only remaining source in a release is a guidance range.
      /\bnon-gaap\s+(?:fully\s+)?(?:diluted\s+)?(?:earnings|net\s+income|net\s+loss|loss)(?:\s*\/?\s*\(loss(?:es)?\))?\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b/i,
      // Foreign private issuers commonly report both an ordinary-share figure in their
      // local currency and a US-dollar ADS figure. The ADS measure is the comparable
      // adjusted EPS for the US-listed security.
      /\bnon-gaap\s+(?:fully\s+)?(?:diluted\s+)?(?:earnings|net\s+income|net\s+loss|loss)\s+per\s+(?:diluted\s+)?ADS\b/i,
      // A reconciliation table can name the measure after the caption instead of before
      // it ("Earnings per share - Non-GAAP").
      /\b(?:earnings|net\s+income)\s+per\s+(?:common\s+)?share\s*[–—-]\s*non-gaap\b/i,
      /\badjusted\s+basic\s+and\s+diluted\s+earnings\s+per\s+(?:common\s+)?share\b/i,
      /\badjusted\s+profit\s+per\s+(?:common\s+)?share\b/i,
      // Some filers name the measure by what it leaves out — "diluted EPS excluding certain
      // items" — which their own footnote then defines as adjusted EPS.
      /\b(?:diluted\s+)?(?:eps|earnings\s+per\s+(?:common\s+)?share)\s+excluding\s+certain\s+items\b/i,
    ],
    // Guidance restates the same non-GAAP measure as a forward range, so without this
    // the low end of a full-year outlook is posted as the reported quarter.
    skipPattern: /\bguidance\b|\boutlook\b|\bforecast(?:s|ed|ing)?\b|\bexpects?\s+(?:non-gaap\s+)?(?:eps|adjusted)\b|\bto\s+be\s+(?:between|in\s+(?:(?:a|the)\s+)?range)\b/i,
    valueType: "eps",
  },
  {
    key: "gaap_eps",
    label: "EPS",
    patterns: [
      /\b(?:gaap\s+)?net\s+loss\b(?:(?![.!?]\s)[^!?\n]){0,180}?(?<metricValue>\(?-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?)\s+per\s+(?:fully\s+)?(?:common\s+)?diluted\s+share\b/i,
      /\bnet\s+(?:income|earnings)\s+attributable\s+to\s+(?:common\s+)?(?:stockholders|shareholders)\s+per\s+share\s*[–—-]\s*diluted\b/i,
      // This plain GAAP loss caption can share a sentence with non-GAAP earnings. Keep it
      // ahead of the generic earnings pattern so the later adjusted figure cannot win.
      /\bdiluted\s+loss\s+per\s+(?:common\s+|ordinary\s+)?share\b/i,
      /\b(?:diluted\s+)?(?:earnings|net\s+income)\s+per\s+(?:common\s+)?share\b/i,
      /\bnet\s+\(loss(?:es)?\)\s+income\s+per\s+(?:common\s+)?share\b/i,
      /\b(?:earnings|profit|net\s+income)(?:\s*\/)?\s*\(loss(?:es)?\)\s+per\s+(?:common\s+|ordinary\s+)?share\b/i,
      /\bprofit\s+(?:\(loss\)\s+)?per\s+(?:common\s+|ordinary\s+)?(?:share|ADS)\b/i,
      /\bnet\s+loss\s+per\s+(?:common\s+|ordinary\s+)?share\b/i,
      /(?<metricValue>\(?-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?)\s+loss\s+per\s+(?:common\s+|ordinary\s+)?share\b/i,
      /\b(?:basic\s+and\s+diluted\s+)?loss\s+per\s+(?:common\s+|ordinary\s+)?share\b/i,
      /\bdiluted\s+eps\b/i,
      new RegExp(String.raw`${gaapTermSource}\s+(?:diluted\s+)?eps\b`, "i"),
      /\b(?:reported\s+)?(?:net\s+)?earnings?\b(?:(?![.!?]\s)[^!?\n]){0,180}?(?<metricValue>-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+per\s+(?:common\s+)?(?:diluted\s+)?share(?:\s*[-–—]\s*diluted)?\b/i,
      /(?<metricValue>\(?-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?(?:\s*(?:cents?|¢))?)\s+per\s+(?:fully\s+)?(?:common\s+)?diluted\s+share\b/i,
      /\beps\b/i,
    ],
    skipPattern: /\badjusted\b|\bnon-gaap\b|\bexcluding\s+certain\s+items\b|\bguidance\b|\boutlook\b|\bforecast(?:s|ed|ing)?\b|\bexcept\s+(?:eps|per\s+share(?:\s+amounts?)?)\b/i,
    valueType: "eps",
  },
  {
    key: "revenue",
    label: "Revenue",
    patterns: [
      // Some narrative headlines put the value before the caption: "$234 million in Q2
      // revenue". Capturing it keeps a later comparison ("$34 million higher") from being
      // mistaken for the reported result.
      /(?<metricValue>\(?-?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:trillions?|billions?|millions?|thousands?|tn|bn|mm|[tbmk])?\)?)\s+in\s+(?:q[1-4]|the\s+(?:first|second|third|fourth)\s+quarter)\s+(?:total\s+)?revenues?\b/i,
      /\btotal\s+revenues?(?:\s+and\s+other\s+income)?\b/i,
      /\bnet\s+sales\b/i,
      /\brevenues?\b/i,
      /\bsales\b/i,
    ],
    skipPattern: new RegExp(String.raw`\bcosts?\s+of\b|\bdeferred\b|\bunearned\b|\bguidance\b|\boutlook\b|\bsystemwide\s+sales\b|\bsubscription\s+and\s+services?\s+revenues?\b|\blicensing\s+and\s+related\s+revenues?\b|\broyalty\s+revenues?\b|\bsales\s+of\s+equipment\b|\b(?:${unitedStatesSource}|U\.K\.|US|international|domestic|non-US|segment)\s+(?:commercial\s+|government\s+)?revenues?\b|\b(?:${unitedStatesSource}|US|international|worldwide|non-US)\s+(?:[A-Z][A-Za-z]+\s+){1,2}revenues?\b|\brevenues?\s+(?:in|outside)\s+the\s+${unitedStatesSource}|\bsince\s+(?:launch|inception)\b|\blife-to-date\b|\bcumulative\b|\bannuali[sz]ed\s+(?:revenue\s+)?run[-\s]*rate\b|\brevenue\s+run[-\s]*rate\b|\brevenue\s+\(expense\)|\bnon[-\s]insurance\s+warranty\s+revenue\b|\bnot\s+recognized\s+in\s+revenue\b|\bnon-cash\s+revenues?\b|\bsales\s+volumes?\b|\b(?:external\s+power|pipeline\s+gas|hydrocarbon|asset)\s+sales\b|\bproceeds\s+from\b|\bsales\s+of\s+pipeline\s+gas\b|\b(?:kbd|koebd|boepd|bpd|mboed|mmboe|bcfe|mmcf|mw|gw|kt)\b`, "i"),
    valueType: "money",
  },
  {
    key: "net_income",
    label: "Net income",
    patterns: [
      /\bnet\s+income(?!\s+per\s+(?:common\s+)?share)\b/i,
      /\bnet\s+earnings(?!\s+per\s+(?:common\s+)?share)\b/i,
      /\bnet\s+\(loss(?:es)?\)\s+income\b/i,
      /\bnet\s+income\s*\/\s*\(loss(?:es)?\)(?!\s+per\s+(?:common\s+)?share)/i,
      /\bnet\s+profit(?!\s+per\s+(?:common\s+)?share)\b/i,
      // Singular only: "net losses of a customer portfolio" is risk-factor prose, not the
      // income-statement row a loss-making filer labels "Net loss".
      /\bnet\s+loss(?!\s*(?:es\b|\s+per\s+(?:common\s+)?share))\b/i,
    ],
    // Skip income-statement subtotals, the noncontrolling-interest component and
    // reconciliation adjustment rows so the headline "net income/earnings attributable
    // to <company>" row wins rather than "net earnings before income tax", "net
    // earnings including NCI" or "increase to net loss / decrease to net income".
    skipPattern: /\badjusted\b|\bnon-gaap\b|\beps\b|\bbefore\s+(?:income\s+)?tax(?:es)?\b|\b(?:including|attributable\s+to)\s+noncontrolling\b|\b(?:increase|decrease)\s+to\s+net\b/i,
    valueType: "money",
  },
  {
    key: "refinery_throughput",
    label: "Refinery throughput",
    patterns: [
      /\brefinery\s+throughput\b/i,
    ],
    valueType: "number",
  },
  {
    key: "production",
    label: "Production",
    patterns: [
      /\bproduction\b/i,
    ],
    skipPattern: /\b(?:capacity|startup|on\s+plan|guidance|outlook|forecast)\b/i,
    valueType: "number",
  },
];

export function getQuarterSpecificMetricLines(lines: string[]): MetricLineSelection {
  const startIndex = lines.findIndex(line =>
    isQuarterSpecificSectionLine(line) || isMixedMonthQuarterResultsLine(line));
  if (-1 === startIndex) {
    return {
      exclusive: false,
      lines: [],
    };
  }

  const exclusive = isMixedMonthQuarterResultsLine(lines[startIndex] ?? "");
  const selectedLines: string[] = [];
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index];
    if (undefined === line) {
      continue;
    }

    if (index > startIndex &&
        (true === isQuarterSpecificSectionBoundary(line) ||
        (true === exclusive && true === isMixedMonthQuarterSectionBoundary(line)))) {
      break;
    }

    selectedLines.push(line);
    if (selectedLines.length >= 16) {
      break;
    }
  }

  return {
    exclusive,
    lines: [...getGoverningScaleDeclarations(lines, startIndex), ...selectedLines],
  };
}

// The unit declaration governing a section's figures ("$ in millions") usually sits above
// the section heading. Selecting the section alone hides it, and every money value in the
// window is then read at face value — a $16.6B quarter rendered as $16.61K.
function getGoverningScaleDeclarations(lines: string[], startIndex: number): string[] {
  for (let index = startIndex - 1; index >= 0 && index >= startIndex - 40; index--) {
    const line = lines[index];
    if (undefined !== line && null !== getMoneyScaleFromContextText(line)) {
      return [line];
    }
  }

  return [];
}

function isMixedMonthQuarterResultsLine(line: string): boolean {
  return /\bmonth\s+and\s+quarter\s+ended\b/i.test(line) ||
    /\bquarter\s+and\s+month\s+ended\b/i.test(line);
}

function isMixedMonthQuarterSectionBoundary(line: string): boolean {
  return /^\s*(?:the\s+)?(?:comprehensive|consolidated)\s+(?:comprehensive\s+)?(?:income\s+)?statements?\b/i.test(line) ||
    /^\s*for\s+the\s+(?:month|year-to-date)\b/i.test(line);
}

function isQuarterSpecificSectionLine(line: string): boolean {
  if (/\b(?:guidance|outlook|forecast)\b/i.test(line)) {
    return false;
  }

  return /^\s*(?:for\s+)?Q[1-4]\s+(?:(?:fiscal\s+year|FY|FYE)\s*)?(?:20\d{2}|\d{2})(?:\s+(?:financial\s+overview|results?(?:\s+summary)?|earnings))?\s*:?$/i.test(line) ||
    /^\s*(?:for\s+)?(?:the\s+)?(?:first|second|third|fourth)[\s–—-]+quarter(?:\s+(?:of\s+)?(?:(?:fiscal\s+year|FY)\s*)?(?:20\d{2}|\d{2}))?(?:\s+(?:financial\s+overview|results?(?:\s+summary)?|earnings))?\s*:?$/i.test(line) ||
    /^\s*highlights?\s*[-:]\s*three\s+months\s+ended\s+[A-Z][a-z]+\s+\d{1,2},\s+20\d{2}\s*:?$/i.test(line);
}

function isQuarterSpecificSectionBoundary(line: string): boolean {
  return /^\s*(?:outlook|guidance|financial\s+outlook|business\s+outlook|use\s+of\s+non-gaap|forward-looking|supplemental\s+financial\s+information)\b/i.test(line) ||
    /^\s*reporting\s+segments?\b/i.test(line) ||
    /^\s*(?:the\s+)?company\s+(?:raises?|updates?|reaffirms?|provides?|issues?)\b.*\b(?:guidance|outlook)\b/i.test(line) ||
    /^\s*highlights?\s*[-:]\s*(?:fiscal\s+year|twelve\s+months\s+ended)\b/i.test(line) ||
    /^\s*(?:fiscal\s+year|FY|FYE)\s*(?:20\d{2}|\d{2})\b/i.test(line) ||
    /^\s*for\s+fiscal\s+year\s+(?:20\d{2}|\d{2})\s*:?$/i.test(line);
}

export function isPerShareOnlyNetIncomeLine(line: string): boolean {
  const hasCombinedAggregateLabel =
    /\bnet\s+income\b.*\band\b.*\bnet\s+income\s+per\s+(?:common\s+|diluted\s+)?share\b/i.test(line);
  if (true === hasCombinedAggregateLabel) {
    return false;
  }

  // A headline can mention scaled revenue and then say "GAAP net income of
  // $1.19 per diluted share". The unrelated revenue scale must not make that
  // per-share statement look like an aggregate net-income figure.
  const hasPerShareNetIncome = /\bnet\s+(?:income|earnings)\b[^.!?]{0,80}\b(?:of\s+)?\(?-?[$€£¥]?\s*\d+(?:\.\d+)?\)?\s+per\s+(?:common\s+)?(?:diluted\s+)?share\b/i.test(line);
  const hasAggregateNetIncome = /\bnet\s+(?:income|earnings)\b[^.!?]{0,80}\(?-?[$€£¥]?\s*\d+(?:\.\d+)?\)?\s+(?:trillion|billion|million|thousand)s?\b/i.test(line);
  if (true === hasPerShareNetIncome && false === hasAggregateNetIncome) {
    return true;
  }

  return /\bper\s+(?:common\s+|diluted\s+)?share\b/i.test(line) &&
    false === /\b(?:trillion|billion|million|thousand)s?\b/i.test(line);
}

export function getMetricLineWithContinuation(
  lines: string[],
  lineIndex: number,
  definition: MetricDefinition,
  quarterLabel: string | undefined,
): string {
  const line = lines[lineIndex] ?? "";
  const precedingLine = lines[lineIndex - 1] ?? "";
  // Inline tables can wrap a qualifier into its own cell ("Adjusted" / "EPS was ...").
  // Reattach that orphaned qualifier so the current value is read from the first caption,
  // instead of the prior-year "adjusted EPS" comparison later on the line.
  const baseLine = precedingLine.length <= 60 &&
      /\b(?:adjusted|non-gaap|gaap)\s*$/i.test(precedingLine) &&
      /^\s*(?:diluted\s+)?(?:eps|earnings|net\s+(?:income|loss))\b/i.test(line)
    ? `${precedingLine} ${line}`
    : line;
  const periodScopedBaseLine = getCurrentQuarterNarrativeSegments(baseLine, quarterLabel);
  const positionedQuarterValues = getPositionedQuarterValues(
    lines,
    lineIndex,
    quarterLabel,
  );
  if (0 < positionedQuarterValues.length) {
    return [baseLine, ...positionedQuarterValues].join(" ");
  }

  const metricLines = [periodScopedBaseLine];
  const isSummaryHeading = isSummaryMetricHeading(periodScopedBaseLine, definition);
  // A per-share block spans a basic and a diluted row of several period columns, each
  // rendered as its own line; stopping too early truncates the diluted row and leaves
  // only the basic figure to read.
  const continuationLimit = "eps" === definition.valueType ? 12 : 6;
  for (let index = lineIndex + 1; index < lines.length && index <= lineIndex + continuationLimit; index++) {
    const nextLine = lines[index];
    if (undefined === nextLine) {
      break;
    }

    // A footnote below the row explains it rather than continuing it, and it often restates
    // the measure with a different figure ("(1) non-GAAP EPS included $3.03 of charges").
    // Joined to the row, that figure becomes the only currency-cued value in it.
    if (true === isDefinitionalLine(nextLine)) {
      break;
    }

    if (true === isValueOnlyLine(nextLine) ||
        true === isPerShareMetricDetailLine(periodScopedBaseLine, nextLine)) {
      metricLines.push(nextLine);
      continue;
    }

    if ("money" === definition.valueType &&
        true === isNarrativeMoneyScaleContinuationLine(metricLines.at(-1) ?? "", nextLine)) {
      metricLines.push(nextLine);
      continue;
    }

    if (false === isSummaryHeading || true === isSummaryMetricHeadingLine(nextLine)) {
      break;
    }

    if ("money" === definition.valueType && true === isNarrativeMoneyDetailLine(nextLine)) {
      metricLines.push(nextLine);
      break;
    }

    if ("eps" === definition.valueType) {
      if (true === isNarrativePerShareDetailLine(nextLine)) {
        metricLines.push(nextLine);
        break;
      }

      if (true === isNarrativeMoneyDetailLine(nextLine)) {
        continue;
      }
    }

    break;
  }

  return metricLines.join(" ");
}

function getCurrentQuarterNarrativeSegments(
  line: string,
  quarterLabel: string | undefined,
): string {
  if (2 <= (line.match(/\|/g)?.length ?? 0)) {
    return line;
  }

  const quarterMatch = /^Q([1-4])\s+(20\d{2})$/.exec(quarterLabel ?? "");
  if (undefined === quarterMatch?.[1] || undefined === quarterMatch[2]) {
    return line;
  }

  const quarterNames = ["", "first", "second", "third", "fourth"];
  const quarterName = quarterNames[Number.parseInt(quarterMatch[1], 10)] ?? "";
  const currentPeriodPattern = new RegExp(
    String.raw`\b(?:q${quarterMatch[1]}|${quarterName}[\s–—-]+quarter)\b[^.!?]{0,40}\b${quarterMatch[2]}\b`,
    "i",
  );
  const explicitPeriodPattern = /\b(?:q[1-4]|(?:first|second|third|fourth)[\s–—-]+quarter)\b[^.!?]{0,40}\b20\d{2}\b/i;
  const segments = line.split(/(?<=[.!?])\s+/);
  const hasForeignPeriodSegment = segments.some(segment =>
    explicitPeriodPattern.test(segment) && false === currentPeriodPattern.test(segment));
  if (false === hasForeignPeriodSegment) {
    return line;
  }

  const currentSegments = segments.filter(segment => currentPeriodPattern.test(segment));
  return 0 < currentSegments.length ? currentSegments.join(" ") : line;
}

function isSummaryMetricHeading(line: string, definition: MetricDefinition): boolean {
  return line.length <= 180 &&
    false === /[$€£¥]|\b\d+(?:[.,]\d+)?\b/.test(line) &&
    definition.patterns.some(pattern => pattern.test(line));
}

function isSummaryMetricHeadingLine(line: string): boolean {
  if (line.length > 180 || /[$€£¥]|\b\d+(?:[.,]\d+)?\b/.test(line)) {
    return false;
  }

  return earningsMetricDefinitions.some(definition =>
    definition.patterns.some(pattern => pattern.test(line))) ||
    /\b(?:adjusted\s+ebitda|operating\s+income)\b/i.test(line);
}

function isNarrativeMoneyDetailLine(line: string): boolean {
  return /^\s*(?:[•◦▪–—-]\s*)?(?:\(?\s*)?(?:[$€£¥]\s*)?-?\d/i.test(line) &&
    /[$€£¥]|\b(?:trillion|billion|million|thousand)s?\b|\b(?:tn|bn|mm|[tbmk])\b/i.test(line);
}

function isNarrativeMoneyScaleContinuationLine(previousLine: string, line: string): boolean {
  return /\d\s*$/i.test(previousLine) &&
    /^\s*(?:trillions?|billions?|millions?|thousands?|tn|bn|mm)\b/i.test(line);
}

function isNarrativePerShareDetailLine(line: string): boolean {
  return /^\s*(?:[•◦▪–—-]\s*)?(?:\(?\s*)?(?:[$€£¥]\s*)?-?\d/i.test(line) &&
    /\b(?:per\s+(?:common\s+)?share|eps|cents?)\b/i.test(line);
}

// Summary tables mark not-meaningful comparisons with "*", "--" or a bare "%", so those
// cells must not end the run of value cells belonging to the label above.
function isValueOnlyLine(line: string): boolean {
  return /^[\s|$€£¥(),.\-*\d%—–]+$/.test(line);
}

function isPerShareMetricDetailLine(baseLine: string, line: string): boolean {
  if (false === /\bper\s+(?:common\s+|ordinary\s+)?share\b/i.test(baseLine)) {
    return false;
  }

  // A label wrapped across table cells leaves its tail word ahead of the value columns
  // ("... per share attributable to owners of the" / "parent Basic 2.65 ... Diluted 2.61"),
  // so the per-share row is only reachable by joining the orphaned continuation.
  return /^\s*(?:basic|diluted)\b/i.test(line) ||
    /^\s*[A-Za-z]{1,12}\s+(?:basic|diluted)\b/i.test(line);
}

export function hasMixedMonthQuarterColumns(lines: string[], lineIndex: number): boolean {
  const context = lines
    .slice(Math.max(0, lineIndex - 8), lineIndex + 1)
    .join(" ");
  // Only a monthly-and-quarterly layout puts the reported quarter in the second column
  // group. Accepting any month name here caught an ordinary "Quarter Ended June 30 | Six
  // Months Ended June 30" table too, and skipped its quarter columns for the half-year ones.
  return /\bmonths?\s+and\s+quarter\b|\bquarter\s+and\s+months?\b/i.test(context) &&
    /\bchange\b/i.test(context);
}

export function isNearTableNoteColumn(lines: string[], lineIndex: number): boolean {
  for (let index = lineIndex; index >= 0 && index >= lineIndex - 5; index--) {
    const line = lines[index];
    if (undefined !== line && /\bnote\b/i.test(line)) {
      return true;
    }
  }

  return false;
}
