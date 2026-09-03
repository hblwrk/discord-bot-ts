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
    // Inline-XBRL hidden facts are machine-readable duplicates, not visible filing text.
    // Leaving them in front of the exhibit can create a false results section before the
    // actual press release and make a footnote amount win candidate selection.
    .replace(/<ix:hidden\b[^>]*>[\s\S]*?<\/ix:hidden\s*>/gi, " ")
    // Numeric superscripts in SEC exhibits are footnote references. Removing only their
    // tags leaves the marker inside the adjacent value ("US$<sup>1</sup>51.1" becomes
    // "US$ 1 51.1"), where it can be selected as a one-dollar result.
    .replace(/<sup\b[^>]*>\s*\(?\d{1,2}\)?\s*<\/sup\s*>/gi, "")
    // Workiva represents superscripts as raised, small font elements rather than <sup>.
    // Remove those numeric references before stripping the presentational font tags.
    .replace(/<font\b[^>]*\btop:\s*-\d+(?:\.\d+)?pt[^>]*>\s*\(?\d{1,2}\)?\s*<\/font\s*>/gi, "")
    // Other Workiva filings use vertical-align for the same kind of footnote marker.
    .replace(/<font\b[^>]*\bvertical-align:\s*super\b[^>]*>\s*\(?\d{1,2}\)?\s*<\/font\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    // Workiva can change font styling in the middle of a word ("reporte</font><font>d").
    // Treating those presentational tags as whitespace corrupts the filing prose and any
    // grounded summary copied from it. The text itself already carries word separators.
    .replace(/<\/?font\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    // SEC financial statements commonly omit the zero before a decimal ("$.32" or
    // "(.32)"). The numeric reader expects a digit before the decimal point.
    .replace(/(?<![\dA-Za-z])\.(\d+)/g, "0.$1")
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
    // SEC exhibits sometimes double-escape typographic entities while leaving structural
    // entities intentionally literal. Decode the known typography one layer before the
    // regular entity pass, without turning "&amp;lt;" into markup.
    .replace(/&amp;(nbsp|quot|apos|rsquo|lsquo|rdquo|ldquo|ndash|mdash);/gi, "&$1;")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, "\"")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexValue: string) => decodeNumericHtmlEntity(hexValue, 16))
    .replace(/&#([0-9]+);/g, (_match, numericValue: string) => decodeNumericHtmlEntity(numericValue, 10))
    .replace(/&amp;/gi, "&");
}

// HTML numeric references in the C1 control range are decoded through Windows-1252,
// even when the document itself is ASCII. Older SEC exhibits rely on that rule and emit
// the euro sign as &#128;; converting it directly to Unicode U+0080 loses the currency.
const windows1252CodePointByNumericReference = new Map<number, number>([
  [0x80, 0x20AC], [0x82, 0x201A], [0x83, 0x0192], [0x84, 0x201E],
  [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02C6],
  [0x89, 0x2030], [0x8A, 0x0160], [0x8B, 0x2039], [0x8C, 0x0152],
  [0x8E, 0x017D], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201C],
  [0x94, 0x201D], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02DC], [0x99, 0x2122], [0x9A, 0x0161], [0x9B, 0x203A],
  [0x9C, 0x0153], [0x9E, 0x017E], [0x9F, 0x0178],
]);

function decodeNumericHtmlEntity(value: string, radix: number): string {
  const numericReference = Number.parseInt(value, radix);
  const codePoint = windows1252CodePointByNumericReference.get(numericReference) ?? numericReference;
  return String.fromCodePoint(codePoint);
}

export function getMeaningfulLines(text: string): string[] {
  return text
    .split("\n")
    .map(line => stripReferenceMarkers(line)
      // Dotted leaders align a caption with its value cell ("Revenue ....... $ 7,814").
      // Left in place, the final dot reads as a sentence boundary and the row is cut off
      // before any of its figures. Image-backed statements sometimes collapse every row
      // onto one long line; preserve those leaders as cell boundaries so each row's value
      // run can be distinguished from the next caption.
      .replace(/\.{2,}|…+/g, () =>
        line.length > 600 &&
          4 <= (line.match(/\.{2,}|…+/g)?.length ?? 0) &&
          /\b(?:USD|CAD|TWD|NTD|EUR|GBP|JPY|CHF)\s+millions\b.*\bNote\b/i.test(line)
          ? " | "
          : " ")
      .replace(/\s*\|\s*/g, " | ")
      .replace(/\s+/g, " ")
      .trim())
    // SEC table conversion can put every value in its own text node. Keep short numeric
    // cells ("55", "(1") even though equally short presentational fragments are noise;
    // otherwise a statement row whose values all have one or two digits loses every cell.
    .filter(line => line.length >= 3 ||
      (/^[$€£¥()\d.,-]+$/.test(line) && /\d/.test(line)));
}

export function getDocumentHeadline(lines: string[]): string | undefined {
  return lines.find(line => /earnings|results|reports|announces/i.test(line) && line.length <= 180);
}

export function getDocumentCurrencyCode(lines: string[]): string | undefined {
  const headerLines = lines.slice(0, 60);
  // Some Canadian bank releases put this governing declaration in their closing legal
  // notes, after all of the financial tables. The phrase is document-wide and explicit,
  // so it remains authoritative even outside the header window used for looser currency
  // mentions such as customer quotes, segment names, or transaction currencies.
  const allAmountsCurrencyDeclaration = lines
    .map(line => line.match(
      /\ball amounts are in\s+(U\.S\.\s+dollars?|Canadian\s+dollars?|New\s+Taiwan\s+dollars?|(?:USD|CAD|TWD|NTD|EUR|GBP|JPY|CHF))\b/i,
    )?.[1])
    .find((declaration): declaration is string => undefined !== declaration);
  if (undefined !== allAmountsCurrencyDeclaration) {
    return getCurrencyCodeFromText(allAmountsCurrencyDeclaration);
  }

  // A filing can define every currency symbol it uses before stating its reporting
  // currency ("all references to EUR ... are euros" followed by "we report our
  // consolidated financial results in U.S. dollars"). The reporting declaration is
  // authoritative; passing the glossary line to the generic currency reader otherwise
  // picks whichever non-dollar symbol it happens to check first.
  const reportingCurrencyDeclaration = headerLines
    .map(line => line.match(
      /\b(?:report|present)(?:ed|ing)?\s+(?:our\s+)?(?:consolidated\s+)?financial\s+(?:results|statements|information)\s+in\s+(U\.S\.\s+dollars?|Canadian\s+dollars?|New\s+Taiwan\s+dollars?|(?:USD|CAD|TWD|NTD|EUR|GBP|JPY|CHF))\b/i,
    )?.[1])
    .find((declaration): declaration is string => undefined !== declaration);
  if (undefined !== reportingCurrencyDeclaration) {
    return getCurrencyCodeFromText(reportingCurrencyDeclaration);
  }

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
  const leadingText = text.slice(0, 2_000);

  // Retail and technology filers often title a release "Reports Second Quarter 2026"
  // or "Second Quarter Fiscal 2027". Resolve that title before the calendar period-end
  // fallback or a later third-quarter outlook can relabel the actual results.
  const leadingWrittenQuarterMatch = leadingText.match(
    /\b(?:(?:reports?|announces?)\s+|(?:financial\s+)?results\s+for\s+(?:the\s+)?|announcement\s+of\s+the\s+)(first|second|third|fourth)[\s–—-]+quarter\s+(?:(?:of\s+)?fiscal(?:\s+year)?\s+)?(20\d{2}|\d{2})\b/i,
  ) ?? leadingText.match(
    /\breports?\s+(?:strong\s+)?(first|second|third|fourth)[\s–—-]+quarter\b.{0,80}\bresults\b[\s\S]{0,800}?\b\1[\s–—-]+quarter\s+of\s+fiscal\s+(20\d{2}|\d{2})\b/i,
  ) ?? leadingText.match(
    /\breports?\s+(?:fiscal(?:\s+year)?\s+)?(20\d{2}|\d{2})\s+(first|second|third|fourth)[\s–—-]+quarter\s+results\b/i,
  ) ?? leadingText.match(
    /\bfiscal(?:\s+year)?\s+(20\d{2}|\d{2})\s+(first|second|third|fourth)[\s–—-]+quarter\s+results\b/i,
  );
  if (undefined !== leadingWrittenQuarterMatch?.[1] && undefined !== leadingWrittenQuarterMatch[2]) {
    const invertedFiscalOrder = /^\d/.test(leadingWrittenQuarterMatch[1]);
    const quarterName = invertedFiscalOrder
      ? leadingWrittenQuarterMatch[2]
      : leadingWrittenQuarterMatch[1];
    const fiscalYear = invertedFiscalOrder
      ? leadingWrittenQuarterMatch[1]
      : leadingWrittenQuarterMatch[2];
    const quarter = getQuarterFromName(quarterName);
    if (quarter) {
      return `${quarter} ${normalizeFiscalYear(fiscalYear)}`;
    }
  }

  // A half-year release is not a quarterly result. Do not infer Q3 from the first guidance
  // sentence merely because no quarter appears in the H1 title.
  if (/\b(?:H1|first\s+half|six\s+months)\b.{0,120}\b(?:20\d{2}\s+)?(?:financial\s+)?results\b/i.test(leadingText) ||
      /\bresults\s+for\s+the\s+six\s+months\s+ended\b/i.test(leadingText)) {
    return undefined;
  }

  // A fiscal filer's release title commonly names the reported period as "Fiscal Third
  // Quarter 2026", while a later outlook uses the compact "Q4 Fiscal Year 2026" form.
  // Resolve the title form first so the guidance period cannot become the result label.
  const leadingFiscalQuarterMatch = leadingText.match(
    /\bfiscal\s+(first|second|third|fourth)[\s–—-]+quarter\s+(20\d{2}|\d{2})\b/i,
  );
  if (undefined !== leadingFiscalQuarterMatch?.[1] && undefined !== leadingFiscalQuarterMatch[2]) {
    const quarter = getQuarterFromName(leadingFiscalQuarterMatch[1]);
    if (quarter) {
      return `${quarter} ${normalizeFiscalYear(leadingFiscalQuarterMatch[2])}`;
    }
  }

  // A fiscal Q4 release can put the year after a combined title rather than directly
  // after the quarter: "Reports Fourth Quarter and Fiscal Year 2026 Financial Results".
  // Resolve that title before a later Q1 FY27 outlook can be mistaken for the result.
  const combinedFiscalResultsMatch = text.match(
    /\breports?\s+(first|second|third|fourth)[\s–—-]+quarter\s+and\s+(?:fiscal\s+year|full[\s–—-]+year)\s+(20\d{2}|\d{2})\b/i,
  );
  if (undefined !== combinedFiscalResultsMatch?.[1] && undefined !== combinedFiscalResultsMatch[2]) {
    const quarter = getQuarterFromName(combinedFiscalResultsMatch[1]);
    if (quarter) {
      return `${quarter} ${normalizeFiscalYear(combinedFiscalResultsMatch[2])}`;
    }
  }

  // A fiscal-year release can headline only the annual period, then identify its reported
  // quarter in the immediately following highlights. It is the Q4 release even though a
  // June period end would map to calendar Q2.
  const fiscalYearResultsMatch = text.match(
    /\breports?\s+fiscal\s+(20\d{2}|\d{2})\s+results\b[\s\S]{0,800}?\bfourth[\s–—-]+quarter\b/i,
  );
  if (undefined !== fiscalYearResultsMatch?.[1]) {
    return `Q4 ${normalizeFiscalYear(fiscalYearResultsMatch[1])}`;
  }

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
    const captionLineSuffix = line.slice(captionMatch.index + captionMatch[0].length);
    const blockText = [
      captionLineSuffix,
      ...lines.slice(lineIndex + 1, lineIndex + 4),
    ].join(" ");
    const dilutedMatch = /\bdiluted\b([\s\S]*)$/i.exec(blockText);
    const countText = dilutedMatch?.[1] ?? blockText;
    // A prose caption can state the count as "63.9 million". The generic reader requires
    // an unscaled mantissa of at least 100 to avoid percentages and per-share values, which
    // skips that valid count and then consumes a larger dollar figure from the next line.
    // An explicit share scale makes the smaller mantissa unambiguous.
    const captionSentence = captionLineSuffix.split(/[.!?]\s/, 1)[0] ?? "";
    const scaledCountMatch = /[$€£¥]/.test(captionSentence)
      ? null
      : /(\d+(?:,\d{3})*(?:\.\d+)?)\s+(?:billions?|millions?|thousands?)\b/i
        .exec(captionSentence);
    if (undefined !== scaledCountMatch?.[1]) {
      return Number.parseFloat(scaledCountMatch[1].replaceAll(",", ""));
    }

    // A narrative can mention why the weighted-average share count changed without
    // stating the count. Do not walk from that prose into the next financial figure.
    // Real row captions begin the line (or retain table separators after extraction).
    if (40 < captionMatch.index) {
      continue;
    }

    // A table whose scale is declared in its heading can legitimately print a sub-100
    // mantissa, such as 48.5 million shares. The row separators make that value
    // unambiguous even though the generic forward reader rejects small bare numbers.
    if (/\|/.test(captionLineSuffix)) {
      const rowCounts = findNumericValues(captionLineSuffix, {minUncuedAbsValue: 1})
        .filter(count => 0 < count);
      if (0 < rowCounts.length) {
        return rowCounts[0];
      }
    }

    const counts = findNumericValues(countText, {minUncuedAbsValue: 10})
      .filter(count => count >= 100);
    if (0 < counts.length) {
      return counts[0];
    }
  }

  return undefined;
}
