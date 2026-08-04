import moment from "moment-timezone";
import {getCurrencyCodeFromText} from "./earnings-results-money.ts";
import {type EarningsResultMetric} from "./earnings-results-metrics.ts";
import {type EarningsOutlookMetric} from "./earnings-results-outlook.ts";

export type ParsedEarningsDocument = {
  headline?: string | undefined;
  metrics: EarningsResultMetric[];
  outlook: EarningsOutlookMetric[];
  quarterLabel?: string | undefined;
};

export function htmlToText(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
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
    .map(line => line.replace(/\s*\|\s*/g, " | ").replace(/\s+/g, " ").trim())
    .filter(line => line.length >= 3);
}

export function getDocumentHeadline(lines: string[]): string | undefined {
  return lines.find(line => /earnings|results|reports|announces/i.test(line) && line.length <= 180);
}

export function getDocumentCurrencyCode(lines: string[]): string | undefined {
  const currencyDeclaration = lines
    .slice(0, 60)
    .find(line => /\b(?:Canadian|New Taiwan|U\.S\.)\s+dollars?\b|\b(?:CAD|TWD|NTD|USD|EUR|GBP|JPY)\b|NT\s*\$/i.test(line));
  return undefined === currencyDeclaration
    ? undefined
    : getCurrencyCodeFromText(currencyDeclaration);
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

  const writtenFiscalQuarterMatch = text.match(/\b(first|second|third|fourth)[\s–—-]+quarter(?:\s+and\s+full)?\s+(?:fiscal\s+year|FY)\s*(20\d{2}|\d{2})\b/i);
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

  const writtenQuarterMatch = text.match(/\b(first|second|third|fourth)[\s–—-]+quarter\s+(?:of\s+)?(20\d{2})\b/i);
  if (undefined !== writtenQuarterMatch?.[1] && undefined !== writtenQuarterMatch[2]) {
    const quarter = getQuarterFromName(writtenQuarterMatch[1]);
    if (quarter) {
      return `${quarter} ${writtenQuarterMatch[2]}`;
    }
  }

  const periodEndedQuarter = getQuarterLabelFromPeriodEnded(text);
  if (undefined !== periodEndedQuarter) {
    return periodEndedQuarter;
  }

  const directQuarterMatch = text.match(/\b(Q[1-4])\s+(20\d{2})\b/i);
  if (undefined !== directQuarterMatch?.[1] && undefined !== directQuarterMatch[2]) {
    return `${directQuarterMatch[1].toUpperCase()} ${directQuarterMatch[2]}`;
  }

  return undefined;
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
    /\b(?:three\s+months|quarter)\s+ended\s+([A-Z][a-z]+)\s+\d{1,2},\s+(20\d{2})\b/,
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
