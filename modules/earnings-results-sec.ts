import {type getWithRetry} from "./http-retry.ts";
import {
  decodeHtmlEntities,
  getNormalizedString,
  htmlToText,
  normalizeCik,
  normalizeTickerSymbol,
} from "./earnings-results-format.ts";

type Logger = {
  log: (level: string, message: unknown) => void;
};

type SecRequestDependencies = {
  getWithRetryFn: typeof getWithRetry;
  logger: Logger;
};

type SecCompanyTickerRow = {
  cik_str?: number | string;
  ticker?: string;
  title?: string;
};

type SecCompanyTickerResponse = Record<string, SecCompanyTickerRow>;

export type SecCompany = {
  cik: string;
  ticker: string;
  title: string;
};

export type SecCurrentFiling = {
  accessionNumber: string;
  cik: string;
  filingUrl: string;
  form: string;
  items: string[];
  title: string;
  updated: string;
};

type SecArchiveDocument = {
  name?: string;
  type?: string;
};

type SecArchiveIndexResponse = {
  directory?: {
    item?: SecArchiveDocument[] | SecArchiveDocument;
  };
};

type SecTickerMapCache = {
  loadedAtMs: number;
  tickerToCompany: Map<string, SecCompany>;
};

const secTickerMapTtlMs = 24 * 60 * 60_000;
const secCompanyTickersEndpoint = "https://www.sec.gov/files/company_tickers.json";
const secCurrentFilingsEndpoint = "https://www.sec.gov/cgi-bin/browse-edgar";
const secRequestHeaders = {
  "User-Agent": "hblwrk-discord-bot/1.0 github.com/hblwrk/discord-bot-ts",
  "Accept": "application/json, text/plain, */*",
};

let secTickerMapCache: SecTickerMapCache | undefined;

export function clearSecEarningsResultCaches() {
  secTickerMapCache = undefined;
}

export async function loadSecTickerMap(dependencies: SecRequestDependencies): Promise<Map<string, SecCompany>> {
  const loadedAtMs = Date.now();
  if (secTickerMapCache &&
      loadedAtMs - secTickerMapCache.loadedAtMs < secTickerMapTtlMs) {
    return secTickerMapCache.tickerToCompany;
  }

  const response = await dependencies.getWithRetryFn<SecCompanyTickerResponse>(
    secCompanyTickersEndpoint,
    {
      headers: secRequestHeaders,
    },
  );
  const tickerToCompany = new Map<string, SecCompany>();
  const rows = "object" === typeof response.data && null !== response.data
    ? Object.values(response.data)
    : [];

  for (const row of rows) {
    const ticker = getNormalizedString(row.ticker);
    const title = getNormalizedString(row.title);
    const cik = normalizeCik(row.cik_str);
    if (null === ticker || null === title || null === cik) {
      continue;
    }

    tickerToCompany.set(normalizeTickerSymbol(ticker), {
      cik,
      ticker,
      title,
    });
  }

  secTickerMapCache = {
    loadedAtMs,
    tickerToCompany,
  };
  return tickerToCompany;
}

export async function loadSecCurrentFilings(
  dependencies: SecRequestDependencies,
  limit: number,
): Promise<SecCurrentFiling[]> {
  const filingTypes = ["8-K", "6-K"];
  const settledResponses = await Promise.allSettled(filingTypes.map(async filingType => {
    const query = new URLSearchParams({
      action: "getcurrent",
      count: String(limit),
      owner: "include",
      output: "atom",
      type: filingType,
    });
    const response = await dependencies.getWithRetryFn<string>(
      `${secCurrentFilingsEndpoint}?${query.toString()}`,
      {
        headers: secRequestHeaders,
        responseType: "text",
      },
    );
    return parseSecCurrentFilingsAtom(String(response.data), filingType);
  }));

  const filings: SecCurrentFiling[] = [];
  for (const settledResponse of settledResponses) {
    if ("fulfilled" === settledResponse.status) {
      filings.push(...settledResponse.value);
    } else {
      dependencies.logger.log(
        "error",
        `Loading SEC current filings failed: ${settledResponse.reason}`,
      );
    }
  }

  return dedupeSecCurrentFilings(filings);
}

export function parseSecCurrentFilingsAtom(
  atom: string,
  fallbackForm = "",
): SecCurrentFiling[] {
  const filings: SecCurrentFiling[] = [];
  const entryMatches = atom.matchAll(/<entry\b[\s\S]*?<\/entry>/gi);

  for (const entryMatch of entryMatches) {
    const entry = entryMatch[0];
    const filingUrl = getXmlLinkHref(entry);
    const accessionNumber = getAccessionNumber(entry, filingUrl);
    const cik = getCik(entry, filingUrl);
    const form = getSecFilingForm(entry, fallbackForm);
    if (null === accessionNumber || null === cik || "" === form) {
      continue;
    }

    filings.push({
      accessionNumber,
      cik,
      filingUrl,
      form,
      items: getSecFilingItems(entry),
      title: getXmlTagText(entry, "title") ?? "",
      updated: getXmlTagText(entry, "updated") ?? "",
    });
  }

  return filings;
}

export function isLikelyEarningsFiling(filing: SecCurrentFiling): boolean {
  const normalizedForm = filing.form.toUpperCase();
  if ("6-K" === normalizedForm) {
    return true;
  }

  if ("8-K" !== normalizedForm) {
    return false;
  }

  if (0 === filing.items.length) {
    return true;
  }

  return filing.items.some(item => "2.02" === item || "9.01" === item);
}

export async function loadSecFilingDetails(
  filing: SecCurrentFiling,
  dependencies: SecRequestDependencies,
): Promise<{documentUrl: string; html: string;}> {
  const archiveBaseUrl = getSecArchiveBaseUrl(filing);
  const indexUrl = `${archiveBaseUrl}/index.json`;
  const indexResponse = await dependencies.getWithRetryFn<SecArchiveIndexResponse>(
    indexUrl,
    {
      headers: secRequestHeaders,
    },
  );
  const documents = normalizeSecArchiveDocuments(indexResponse.data?.directory?.item);
  const selectedDocument = selectEarningsReleaseDocument(documents);
  if (!selectedDocument?.name) {
    return {
      documentUrl: filing.filingUrl,
      html: "",
    };
  }

  const documentUrl = `${archiveBaseUrl}/${selectedDocument.name}`;
  const documentResponse = await dependencies.getWithRetryFn<string>(
    documentUrl,
    {
      headers: secRequestHeaders,
      responseType: "text",
    },
  );
  return {
    documentUrl,
    html: String(documentResponse.data),
  };
}

function dedupeSecCurrentFilings(filings: SecCurrentFiling[]): SecCurrentFiling[] {
  const dedupedFilings: SecCurrentFiling[] = [];
  const seenAccessions = new Set<string>();

  for (const filing of filings) {
    if (true === seenAccessions.has(filing.accessionNumber)) {
      continue;
    }

    seenAccessions.add(filing.accessionNumber);
    dedupedFilings.push(filing);
  }

  return dedupedFilings;
}

function normalizeSecArchiveDocuments(value: SecArchiveDocument[] | SecArchiveDocument | undefined): SecArchiveDocument[] {
  if (Array.isArray(value)) {
    return value;
  }

  if ("object" === typeof value && null !== value) {
    return [value];
  }

  return [];
}

function selectEarningsReleaseDocument(documents: SecArchiveDocument[]): SecArchiveDocument | undefined {
  const contentDocuments = documents.filter(document => {
    const name = document.name?.toLowerCase() ?? "";
    return "" !== name &&
      false === name.endsWith(".xml") &&
      false === name.endsWith(".xsd") &&
      false === name.endsWith(".json");
  });

  return contentDocuments.find(document => {
    const name = document.name?.toLowerCase() ?? "";
    const type = document.type?.toLowerCase() ?? "";
    return type.startsWith("ex-99") ||
      name.includes("ex99") ||
      name.includes("ex-99") ||
      name.includes("earnings") ||
      name.includes("release");
  }) ?? contentDocuments.find(document => {
    const type = document.type?.toLowerCase() ?? "";
    return "8-k" === type || "6-k" === type;
  }) ?? contentDocuments[0];
}

function getSecArchiveBaseUrl(filing: SecCurrentFiling): string {
  return `https://www.sec.gov/Archives/edgar/data/${getCikArchiveSegment(filing.cik)}/${filing.accessionNumber.replaceAll("-", "")}`;
}

function getCikArchiveSegment(cik: string): string {
  const parsedCik = Number.parseInt(cik, 10);
  if (Number.isFinite(parsedCik)) {
    return String(parsedCik);
  }

  return cik.replace(/^0+/, "");
}

function getXmlTagText(xml: string, tagName: string): string | null {
  const tagMatch = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  if (!tagMatch) {
    return null;
  }

  const tagContent = tagMatch[1];
  return undefined === tagContent
    ? null
    : decodeHtmlEntities(tagContent.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function getXmlLinkHref(xml: string): string {
  const linkMatch = xml.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  return undefined !== linkMatch?.[1] ? decodeHtmlEntities(linkMatch[1]) : "";
}

function getAccessionNumber(entry: string, filingUrl: string): string | null {
  const accessionPatterns = [
    /accession-number=([0-9-]+)/i,
    /accessionNumber=([0-9-]+)/i,
    /\/Archives\/edgar\/data\/\d+\/(\d{18})\//i,
    /([0-9]{10}-[0-9]{2}-[0-9]{6})/i,
  ];

  for (const pattern of accessionPatterns) {
    const match = `${entry} ${filingUrl}`.match(pattern);
    if (!match) {
      continue;
    }

    if (undefined !== match[1]) {
      return normalizeAccessionNumber(match[1]);
    }
  }

  return null;
}

function normalizeAccessionNumber(value: string): string {
  const normalizedValue = value.trim();
  if (/^\d{18}$/.test(normalizedValue)) {
    return `${normalizedValue.slice(0, 10)}-${normalizedValue.slice(10, 12)}-${normalizedValue.slice(12)}`;
  }

  return normalizedValue;
}

function getCik(entry: string, filingUrl: string): string | null {
  const cikPatterns = [
    /\bCIK\b[^0-9]{0,40}([0-9]{1,10})/i,
    /\/Archives\/edgar\/data\/(\d+)\//i,
  ];

  for (const pattern of cikPatterns) {
    const match = `${entry} ${filingUrl}`.match(pattern);
    const cik = normalizeCik(match?.[1]);
    if (null !== cik) {
      return cik;
    }
  }

  return null;
}

function getSecFilingForm(entry: string, fallbackForm: string): string {
  const categoryMatch = entry.match(/<category\b[^>]*\bterm=["']([^"']+)["']/i);
  const categoryForm = getNormalizedString(categoryMatch?.[1]);
  if (null !== categoryForm) {
    return categoryForm.toUpperCase();
  }

  const title = getXmlTagText(entry, "title") ?? "";
  const titleFormMatch = title.match(/\b(8-K|6-K)\b/i);
  if (undefined !== titleFormMatch?.[1]) {
    return titleFormMatch[1].toUpperCase();
  }

  return fallbackForm.toUpperCase();
}

function getSecFilingItems(entry: string): string[] {
  const text = htmlToText(entry);
  const itemMatch = text.match(/\bItems?\s*:\s*([0-9.,\s]+)/i);
  if (!itemMatch) {
    return [];
  }

  const itemList = itemMatch[1];
  if (undefined === itemList) {
    return [];
  }

  return itemList
    .split(",")
    .map(item => item.trim())
    .filter(item => /^\d+\.\d{2}$/.test(item));
}
