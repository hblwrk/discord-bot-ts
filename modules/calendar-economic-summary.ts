import moment from "moment-timezone";
import {callAiProviderJson, type AiProviderDependencies} from "./ai-provider.ts";
import {type CalendarEvent} from "./calendar.ts";
import {getWithRetry} from "./http-retry.ts";

type CalendarOfficialSource = {
  name: string;
  url: string;
};

export type CalendarOfficialSummary = CalendarOfficialSource & {
  summaryMarkdown: string;
};

export type CalendarOfficialSummaryDependencies = AiProviderDependencies & {
  callAiProviderJsonFn?: typeof callAiProviderJson;
  getWithRetryFn?: typeof getWithRetry;
};

const maxOfficialSourceTextLength = 12_000;
const maxSummaryLength = 900;
const calendarOfficialSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summaryMarkdown: {
      type: "string",
      description: "A concise Discord Markdown summary of the main topics from the official source text.",
    },
  },
  required: ["summaryMarkdown"],
} satisfies Record<string, unknown>;

export async function getCalendarOfficialSummary(
  calendarEvents: CalendarEvent[],
  dependencies: CalendarOfficialSummaryDependencies,
): Promise<CalendarOfficialSummary | undefined> {
  const source = getOfficialSource(calendarEvents);
  if (undefined === source) {
    return undefined;
  }

  const sourceText = await getOfficialSourceText(source, dependencies);
  if (undefined === sourceText) {
    return undefined;
  }

  const callAiProviderJsonFn = dependencies.callAiProviderJsonFn ?? callAiProviderJson;
  const jsonText = await callAiProviderJsonFn(
    getCalendarOfficialSummaryPrompt(calendarEvents, source, sourceText),
    calendarOfficialSummarySchema,
    dependencies,
    "calendar official source summary",
    undefined,
    {
      timeoutMs: 30_000,
    },
  ).catch(error => {
    dependencies.logger.log(
      "warn",
      `AI calendar official source summary failed: ${error}`,
    );
    return null;
  });

  if (null === jsonText) {
    return undefined;
  }

  const parsedJson = parseJson(jsonText);
  if (false === isRecord(parsedJson)) {
    dependencies.logger.log(
      "warn",
      "AI calendar official source summary returned invalid JSON.",
    );
    return undefined;
  }

  const summaryMarkdown = parsedJson["summaryMarkdown"];
  if ("string" !== typeof summaryMarkdown) {
    dependencies.logger.log(
      "warn",
      "AI calendar official source summary response did not contain summaryMarkdown.",
    );
    return undefined;
  }

  const normalizedSummary = normalizeSummaryMarkdown(summaryMarkdown);
  if ("" === normalizedSummary) {
    return undefined;
  }

  return {
    ...source,
    summaryMarkdown: truncateSummary(normalizedSummary),
  };
}

function getOfficialSource(calendarEvents: CalendarEvent[]): CalendarOfficialSource | undefined {
  const eventNames = calendarEvents
    .map(calendarEvent => calendarEvent.name)
    .join(" ")
    .toLowerCase();
  const primaryEvent = calendarEvents[0];

  if (/\b(?:fomc statement|federal open market committee \(fomc\) statement|fed interest rate decision|federal reserve system \(fed\) interest rate decision)\b/i.test(eventNames)) {
    return {
      name: "Federal Reserve",
      url: getFederalReserveStatementUrl(primaryEvent),
    };
  }

  if (/\b(?:consumer price index|cpi)\b/i.test(eventNames)) {
    return {
      name: "U.S. Bureau of Labor Statistics",
      url: "https://www.bls.gov/news.release/cpi.nr0.htm",
    };
  }

  if (/\b(?:producer price index|ppi)\b/i.test(eventNames)) {
    return {
      name: "U.S. Bureau of Labor Statistics",
      url: "https://www.bls.gov/news.release/ppi.nr0.htm",
    };
  }

  if (/\bnonfarm payrolls\b/i.test(eventNames)) {
    return {
      name: "U.S. Bureau of Labor Statistics",
      url: "https://www.bls.gov/news.release/empsit.nr0.htm",
    };
  }

  if (/\b(?:gross domestic product|gdp q\/q)\b/i.test(eventNames)) {
    return {
      name: "U.S. Bureau of Economic Analysis",
      url: "https://www.bea.gov/data/gdp/gross-domestic-product",
    };
  }

  return undefined;
}

function getFederalReserveStatementUrl(calendarEvent: CalendarEvent | undefined): string {
  const eventDate = calendarEvent?.date ?? "";
  const parsedDate = moment(eventDate, "YYYY-MM-DD", true);
  const dateStamp = true === parsedDate.isValid()
    ? parsedDate.format("YYYYMMDD")
    : moment().format("YYYYMMDD");

  return `https://www.federalreserve.gov/newsevents/pressreleases/monetary${dateStamp}a.htm`;
}

async function getOfficialSourceText(
  source: CalendarOfficialSource,
  dependencies: CalendarOfficialSummaryDependencies,
): Promise<string | undefined> {
  const getWithRetryFn = dependencies.getWithRetryFn ?? getWithRetry;
  const response = await getWithRetryFn<string>(
    source.url,
    {
      responseType: "text",
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    },
    {
      maxAttempts: 2,
      timeoutMs: 10_000,
    },
  ).catch(error => {
    dependencies.logger.log(
      "warn",
      `Loading official calendar source failed (${source.name}): ${error}`,
    );
    return null;
  });

  if (null === response) {
    return undefined;
  }

  const sourceText = normalizeOfficialSourceText(response.data);
  if ("" === sourceText) {
    dependencies.logger.log(
      "warn",
      `Official calendar source did not contain usable text (${source.name}).`,
    );
    return undefined;
  }

  return sourceText.slice(0, maxOfficialSourceTextLength);
}

function normalizeOfficialSourceText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, "\"")
    .replace(/&ldquo;/g, "\"")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "-");
}

function getCalendarOfficialSummaryPrompt(
  calendarEvents: CalendarEvent[],
  source: CalendarOfficialSource,
  sourceText: string,
): string {
  const eventNames = calendarEvents
    .map(calendarEvent => calendarEvent.name)
    .filter(eventName => "" !== eventName.trim())
    .join(", ");

  return [
    "Summarize this official economic release for a Discord trading alert.",
    "Return only JSON matching the schema. Do not include markdown outside the JSON string.",
    `Event(s): ${eventNames}`,
    `Official source: ${source.name}`,
    "Write summaryMarkdown as 2 short sentences maximum.",
    "Focus on the main policy or macro topics that are likely market-relevant.",
    "Use only the official source text below. Do not infer, forecast, or invent numbers.",
    "Do not include links, code blocks, tables, emojis, or disclaimers.",
    "",
    "Official source text:",
    sourceText,
  ].join("\n");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && false === Array.isArray(value);
}

function normalizeSummaryMarkdown(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(line => "" !== line && false === /^```/.test(line))
    .join("\n")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function truncateSummary(summaryMarkdown: string): string {
  if (summaryMarkdown.length <= maxSummaryLength) {
    return summaryMarkdown;
  }

  return `${summaryMarkdown.slice(0, maxSummaryLength - 3).trimEnd()}...`;
}
