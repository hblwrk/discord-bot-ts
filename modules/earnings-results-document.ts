import moment from "moment-timezone";
import {isDefinitionalLine, stripReferenceMarkers} from "./earnings-results-format-selection.ts";
import {findNumericValues, getCurrencyCodeFromText} from "./earnings-results-money.ts";
import {type EarningsResultMetric} from "./earnings-results-metrics.ts";
import {type EarningsOutlookMetric} from "./earnings-results-outlook.ts";
import {
  hasDeclaredIsoCode,
  hasNewTaiwanDollarSymbol,
} from "./earnings-results-terms.ts";

export type ParsedEarningsDocument = {
  // The weighted-average diluted share count as printed, without applying a scale. Filings
  // scale shares independently of money in the same table ("in millions, except share
  // amounts which are reflected in thousands"), so the reader compares magnitudes rather
  // than trusting a unit. Not a posted metric — it exists to check that a reported EPS and
  // net income belong to the same period.
  dilutedShareMantissa?: number | undefined;
  headline?: string | undefined;
  metrics: EarningsResultMetric[];
  outlook: EarningsOutlookMetric[];
  quarterLabel?: string | undefined;
};

export function htmlToText(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    // Numeric superscripts in SEC exhibits are footnote references. Removing only their
    // tags leaves the marker inside the adjacent value ("US$<sup>1</sup>51.1" becomes
    // "US$ 1 51.1"), where it can be selected as a one-dollar result.
    .replace(/<sup\b[^>]*>\s*\(?\d{1,2}\)?\s*<\/sup\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    // SEC exhibits sometimes use zero-width characters as otherwise-empty table cells.
    // Left intact, a row between a metric caption and its values is not recognised as a
    // value-only continuation, so the entire per-share row is dropped.
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexValue: string) => String.fromCodePoint(Number.parseInt(hexValue, 16)))
    .replace(/&#([0-9]+);/g, (_match, numericValue: string) => String.fromCodePoint(Number.parseInt(numericValue, 10)))
    .replace(/&amp;/gi, "&");
}

export function getMeaningfulLines(text: string): string[] {
  return text
    .split("\n")
    .map(line => stripReferenceMarkers(line)
      // Dotted leaders align a caption with its value cell ("Revenue ....... $ 7,814").
      // Left in place, the final dot reads as a sentence boundary and the row is cut off
      // before any of its figures.
      .replace(/\.{2,}|…+/g, " ")
      .replace(/\s*\|\s*/g, " | ")
      .replace(/\s+/g, " ")
      .trim())
    .filter(line => line.length >= 3);
}

export function getDocumentHeadline(lines: string[]): string | undefined {
  return lines.find(line => /earnings|results|reports|announces/i.test(line) && line.length <= 180);
}

export function getDocumentCurrencyCode(lines: string[]): string | undefined {
  const headerLines = lines.slice(0, 60);
  const currencyDeclaration = headerLines
    .find(line => /\b(?:Canadian|New Taiwan|U\.S\.)\s+dollars?\b/i.test(line) ||
      hasDeclaredIsoCode(line, ["CAD", "TWD", "NTD", "USD", "EUR", "GBP", "JPY", "CHF"]) ||
      hasNewTaiwanDollarSymbol(line));
  if (undefined !== currencyDeclaration) {
    return getDominantCurrencyCode(currencyDeclaration) ??
      getCurrencyCodeFromText(currencyDeclaration);
  }

  // A non-dollar reporting currency is often declared only as a column scale ("(€M)",
  // "(in € millions)"). It still governs statement rows that carry no symbol of their
  // own, which would otherwise be rendered as dollars.
  const scaleSymbolDeclaration = headerLines.find(line =>
    /\(\s*[€£¥]\s*(?:M|B|K|millions?|billions?|thousands?)\b/i.test(line) ||
    /\bin\s+[€£¥]\s*(?:millions?|billions?|thousands?)\b/i.test(line));
  return undefined === scaleSymbolDeclaration
    ? undefined
    : getCurrencyCodeFromText(scaleSymbolDeclaration);
}

// An inline-XBRL context header lists every unit the filing references
// ("iso4217:USD ... iso4217:EUR ... iso4217:USD"), so the reporting currency is the one
// named most often rather than whichever is checked first.
function getDominantCurrencyCode(text: string): string | undefined {
  const declaredCodes = [...text.matchAll(/\biso4217:([A-Z]{3})\b/g)]
    .map(codeMatch => codeMatch[1] ?? "");
  if (2 > declaredCodes.length) {
    return undefined;
  }

  const countByCode = new Map<string, number>();
  for (const code of declaredCodes) {
    countByCode.set(code, (countByCode.get(code) ?? 0) + 1);
  }

  let dominantCode: string | undefined;
  let dominantCount = 0;
  for (const [code, count] of countByCode) {
    if (count > dominantCount) {
      dominantCode = code;
      dominantCount = count;
    }
  }

  return dominantCode;
}

export function getQuarterLabel(text: string): string | undefined {
  const fiscalQuarterMatch = text.match(/\b(Q[1-4])\s+(?:fiscal\s+year|FY|FYE)\s*(20\d{2}|\d{2})\b/i);
  if (undefined !== fiscalQuarterMatch?.[1] && undefined !== fiscalQuarterMatch[2]) {
    return `${fiscalQuarterMatch[1].toUpperCase()} ${normalizeFiscalYear(fiscalQuarterMatch[2])}`;
  }

  const ordinalQuarterMatch = text.match(/\b([1-4])\s*(?:st|nd|rd|th)\s+quarter\s+(20\d{2})\b/i);
  if (undefined !== ordinalQuarterMatch?.[1] && undefined !== ordinalQuarterMatch[2]) {
    return `Q${ordinalQuarterMatch[1]} ${ordinalQuarterMatch[2]}`;
  }

  // A shareholder letter names the period as "third quarter results for fiscal 2026":
  // written quarter, a caption word, then a bare "fiscal". Only a short caption is allowed
  // through, so the match cannot reach across prose into a prior-year comparative such as
  // "for the third quarter to $25.2 billion from $23.7 billion in Q3 fiscal 2025".
  const writtenFiscalQuarterMatch = text.match(/\b(first|second|third|fourth)[\s–—-]+quarter(?:\s+and\s+full)?(?:\s+(?:results?|segment\s+\w+(?:\s+and\s+\w+)?))?\s+(?:for\s+)?(?:fiscal(?:\s+year)?|FY)\s*(20\d{2}|\d{2})\b/i);
  if (undefined !== writtenFiscalQuarterMatch?.[1] && undefined !== writtenFiscalQuarterMatch[2]) {
    const quarter = getQuarterFromName(writtenFiscalQuarterMatch[1]);
    if (quarter) {
      return `${quarter} ${normalizeFiscalYear(writtenFiscalQuarterMatch[2])}`;
    }
  }

  const namedPeriodEndedQuarter = getNamedQuarterLabelFromPeriodEnded(text);
  if (undefined !== namedPeriodEndedQuarter) {
    return namedPeriodEndedQuarter;
  }

  const quarterAndFullYearHighlightsLabel = getQuarterAndFullYearHighlightsLabel(text);
  if (undefined !== quarterAndFullYearHighlightsLabel) {
    return quarterAndFullYearHighlightsLabel;
  }

  // The period the statements cover is stated as the period they ended, and it outranks a
  // written quarter elsewhere in the document: a release for the quarter ended June 30 also
  // says "For the third quarter of 2026, we expect", and that guidance period must not
  // become the reporting period. A fiscal filer whose quarter number differs from the
  // calendar one is already resolved by the fiscal patterns above.
  const periodEndedQuarter = getQuarterLabelFromPeriodEnded(text);
  if (undefined !== periodEndedQuarter) {
    return periodEndedQuarter;
  }

  const writtenQuarterMatch = text.match(/\b(first|second|third|fourth)[\s–—-]+quarter\s+(?:of\s+)?(20\d{2})\b/i);
  if (undefined !== writtenQuarterMatch?.[1] && undefined !== writtenQuarterMatch[2]) {
    const quarter = getQuarterFromName(writtenQuarterMatch[1]);
    if (quarter) {
      return `${quarter} ${writtenQuarterMatch[2]}`;
    }
  }

  const directQuarterMatch = text.match(/\b(Q[1-4])\s+(20\d{2})\b/i);
  if (undefined !== directQuarterMatch?.[1] && undefined !== directQuarterMatch[2]) {
    return `${directQuarterMatch[1].toUpperCase()} ${directQuarterMatch[2]}`;
  }

  return undefined;
}

// A fiscal Q4 release can put the quarter number in its title and the year only in the
// following period heading: "Fourth Quarter and Full-Year Results" followed by
// "Highlights - Three Months Ended June 30, 2026". The calendar month cannot identify a
// fiscal quarter, so join those two nearby declarations instead of mapping June to Q2.
function getQuarterAndFullYearHighlightsLabel(text: string): string | undefined {
  const quarterAndYearMatch = text.match(
    /\b(first|second|third|fourth)[\s–—-]+quarter\s+and\s+full[\s–—-]+year\s+results\b[\s\S]{0,500}?\b(?:highlights?\s*[-:]\s*)?(?:three\s+months|fiscal\s+year)\s+ended\s+[A-Z][a-z]+\s+\d{1,2},\s+(20\d{2})\b/i,
  );
  if (undefined === quarterAndYearMatch?.[1] || undefined === quarterAndYearMatch[2]) {
    return undefined;
  }

  const quarter = getQuarterFromName(quarterAndYearMatch[1]);
  return quarter ? `${quarter} ${quarterAndYearMatch[2]}` : undefined;
}

function getNamedQuarterLabelFromPeriodEnded(text: string): string | undefined {
  const namedPeriodEndedMatch = text.match(
    /\b(first|second|third|fourth)[\s–—-]+quarter\s+ended\s+[A-Z][a-z]+\s+\d{1,2},\s+(20\d{2})\b/i,
  );
  if (undefined === namedPeriodEndedMatch?.[1] || undefined === namedPeriodEndedMatch[2]) {
    return undefined;
  }

  const quarter = getQuarterFromName(namedPeriodEndedMatch[1]);
  return quarter ? `${quarter} ${namedPeriodEndedMatch[2]}` : undefined;
}

function normalizeFiscalYear(value: string): string {
  return 2 === value.length ? `20${value}` : value;
}

function getQuarterLabelFromPeriodEnded(text: string): string | undefined {
  const periodEndedMatch = text.match(
    /\b(?:three[-\s]+months?(?:\s+period)?|quarter)\s+ended\s+([A-Z][a-z]+)\s+\d{1,2},\s+(20\d{2})\b/,
  );
  if (undefined === periodEndedMatch?.[1] || undefined === periodEndedMatch[2]) {
    return undefined;
  }

  const month = moment(periodEndedMatch[1], "MMMM", true);
  if (false === month.isValid()) {
    return undefined;
  }

  return `Q${Math.floor(month.month() / 3) + 1} ${periodEndedMatch[2]}`;
}

function getQuarterFromName(name: string): string | undefined {
  const quarterByName = new Map<string, string>([
    ["first", "Q1"],
    ["second", "Q2"],
    ["third", "Q3"],
    ["fourth", "Q4"],
  ]);
  return quarterByName.get(name.toLowerCase());
}

// The share row sits under a "weighted-average shares" caption, with the diluted count
// below the basic one. Any period's count serves the purpose: a company's share count moves
// by a few percent between quarters, while the errors this guards against — a prior-year
// column, a misplaced decimal — are off by far more.
export function getDilutedShareMantissa(lines: string[]): number | undefined {
  for (const [lineIndex, line] of lines.entries()) {
    // The non-GAAP section defines its per-share measure in words — "non-GAAP net loss
    // divided by the weighted average shares used to compute net loss per share" — which
    // carries the caption without any count, so the reader took a figure out of the prose
    // that followed. A count read from the wrong place is worse than none: the consistency
    // check then contradicts a correct filing.
    if (true === isDefinitionalLine(line)) {
      continue;
    }

    // The caption has to be about shares. "dollar-weighted average contract duration" is
    // boilerplate about contracts, and matching it reads an unrelated figure as a count.
    //
    // "Average Shares Outstanding Assuming Dilution" is the same row without the word
    // "weighted" — how Merck captions it. Requiring "weighted" left such a filing with no
    // share count at all, and a filing with no count is exempt from the per-share consistency
    // check rather than failing it, so the caption went unnoticed.
    const captionMatch = /weighted[-\s]average\s+(?:number\s+of\s+)?(?:[a-z]+\s+){0,3}shares\b|\baverage\s+shares\s+outstanding\b|shares\s+used\s+in\s+(?:the\s+)?(?:comput|calculat)/i
      .exec(line);
    if (null === captionMatch) {
      continue;
    }

    // Read forward from the caption only. A guidance bullet states the per-share figure
    // before the count it rests on ("per share of approximately $0.87 to $0.92 on
    // weighted-average diluted shares outstanding of approximately 185 million"), and
    // reading the whole line would take the per-share figure as the count.
    const blockText = [
      line.slice(captionMatch.index + captionMatch[0].length),
      ...lines.slice(lineIndex + 1, lineIndex + 4),
    ].join(" ");
    const dilutedMatch = /\bdiluted\b([\s\S]*)$/i.exec(blockText);
    const counts = findNumericValues(dilutedMatch?.[1] ?? blockText, {minUncuedAbsValue: 10})
      .filter(count => count >= 100);
    if (0 < counts.length) {
      return counts[0];
    }
  }

  return undefined;
}
