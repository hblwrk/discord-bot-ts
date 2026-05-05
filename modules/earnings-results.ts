import moment from "moment-timezone";
import {bluechipMinMarketCap, clearEarningsScheduleCache, type EarningsEvent, getEarningsResult} from "./earnings.ts";
import {
  formatUsdCompact,
  getEarningsResultMessage,
  getMessageMetrics,
  normalizeTickerSymbol,
  parseEarningsDocument,
  parseNumber,
  type NasdaqSurprise,
} from "./earnings-results-format.ts";
import {loadSecXbrlMetrics, mergeXbrlAndHtmlMetrics} from "./earnings-results-xbrl.ts";
import {
  clearSecEarningsResultCaches,
  isLikelyEarningsFiling,
  loadSecCurrentFilings,
  loadSecFilingDetails,
  loadSecTickerMap,
  type SecCompany,
  type SecCurrentFiling,
} from "./earnings-results-sec.ts";
import {getWithRetry} from "./http-retry.ts";
import {getLogger} from "./logging.ts";

type Logger = {
  log: (level: string, message: unknown) => void;
};

type SendableChannel = {
  send: (payload: unknown) => Promise<unknown> | unknown;
};

type FetchableMessageManager = {
  fetch: (options: {limit: number}) => Promise<unknown> | unknown;
};

type FetchedMessageCollection = {
  values: () => Iterable<unknown>;
};

type EarningsResultClient = {
  channels?: {
    cache?: {
      get?: (channelID: string) => unknown;
    };
    fetch?: (channelID: string) => Promise<unknown> | unknown;
  };
};

type TimerHandle = ReturnType<typeof setTimeout>;

type EarningsResultWatcherOptions = {
  announcementThreadID?: string | undefined;
  clearTimeoutFn?: typeof clearTimeout;
  getEarningsResultFn?: typeof getEarningsResult;
  getWithRetryFn?: typeof getWithRetry;
  inactivePollIntervalMs?: number;
  logger?: Logger;
  maxAnnouncementsPerScan?: number;
  now?: () => moment.Moment;
  pollIntervalMs?: number;
  secCurrentFilingsLimit?: number;
  setTimeoutFn?: typeof setTimeout;
};

type EarningsResultDependencies = Required<Pick<
  EarningsResultWatcherOptions,
  "getEarningsResultFn" | "getWithRetryFn" | "logger" | "now"
>>;

type EarningsWatchEntry = {
  cik: string;
  companyName: string;
  event: EarningsEvent;
  normalizedTicker: string;
};

type EarningsWatchCache = {
  dateStamp: string;
  loadedAtMs: number;
  watches: EarningsWatchEntry[];
};

type NasdaqSurpriseRow = {
  consensusForecast?: string | number;
  consensusRevenue?: string | number;
  dateReported?: string;
  eps?: string | number;
  percentageSurprise?: string | number;
  revenueActual?: string | number;
  revenueEstimate?: string | number;
  revenueForecast?: string | number;
};

type NasdaqSurpriseResponse = {
  data?: {
    earningsSurpriseTable?: {
      rows?: NasdaqSurpriseRow[];
    };
    rows?: NasdaqSurpriseRow[];
  };
};

type EarningsResultAnnouncement = {
  accessionNumber: string;
  cik: string;
  companyName: string;
  filing: SecCurrentFiling;
  filingUrl: string;
  message: string;
  ticker: string;
};

export type EarningsResultScanResult = {
  active: boolean;
  announcements: EarningsResultAnnouncement[];
  watchedCompanies: number;
};

export type EarningsResultWatcher = {
  runOnce: () => Promise<EarningsResultScanResult>;
  stop: () => void;
};

const logger = getLogger();
const usEasternTimezone = "US/Eastern";
const dateStampFormat = "YYYY-MM-DD";
const defaultPollIntervalMs = 60_000;
const defaultInactivePollIntervalMs = 15 * 60_000;
const defaultSecCurrentFilingsLimit = 100;
const defaultMaxAnnouncementsPerScan = 10;
const defaultRecentMessageFetchLimit = 100;
const earningsWatchTtlMs = 15 * 60_000;
const nasdaqEarningsSurpriseEndpoint = "https://api.nasdaq.com/api/company";
const noMentions = {
  parse: [],
};
const nasdaqRequestHeaders = {
  "User-Agent": "Mozilla/5.0",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://www.nasdaq.com/",
};

let earningsWatchCache: EarningsWatchCache | undefined;

export function clearEarningsResultCaches() {
  earningsWatchCache = undefined;
  clearEarningsScheduleCache();
  clearSecEarningsResultCaches();
}

export function startEarningsResultWatcher(
  client: EarningsResultClient,
  channelID: string,
  options: EarningsResultWatcherOptions = {},
): EarningsResultWatcher {
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const inactivePollIntervalMs = options.inactivePollIntervalMs ?? defaultInactivePollIntervalMs;
  const announcementThreadID = getOptionalChannelID(options.announcementThreadID);
  const seenAccessions = new Set<string>();
  const dependencies = getDependencies(options);
  let seenAccessionsSeeded = false;
  let stopped = false;
  let timerHandle: TimerHandle | undefined;

  const runOnce = async (): Promise<EarningsResultScanResult> => {
    if (false === seenAccessionsSeeded) {
      const seeded = await seedSeenAccessionsFromAnnouncementHistory(
        client,
        channelID,
        announcementThreadID,
        seenAccessions,
        dependencies.logger,
      );
      if (false === seeded) {
        return {
          active: true,
          announcements: [],
          watchedCompanies: 0,
        };
      }

      seenAccessionsSeeded = true;
    }

    const announcementOptions: {
      dependencies: EarningsResultDependencies;
      maxAnnouncementsPerScan?: number;
      secCurrentFilingsLimit?: number;
      seenAccessions: Set<string>;
    } = {
      dependencies,
      seenAccessions,
    };
    if (undefined !== options.maxAnnouncementsPerScan) {
      announcementOptions.maxAnnouncementsPerScan = options.maxAnnouncementsPerScan;
    }
    if (undefined !== options.secCurrentFilingsLimit) {
      announcementOptions.secCurrentFilingsLimit = options.secCurrentFilingsLimit;
    }

    const result = await getEarningsResultAnnouncements(announcementOptions);

    for (const announcement of result.announcements) {
      const sent = await sendEarningsResultAnnouncement(
        client,
        channelID,
        announcementThreadID,
        announcement.message,
        dependencies.logger,
      );
      if (true === sent) {
        seenAccessions.add(announcement.accessionNumber);
      }
    }

    return result;
  };

  const scheduleNextRun = (delayMs: number) => {
    if (true === stopped) {
      return;
    }

    timerHandle = setTimeoutFn(() => {
      void runAndSchedule();
    }, delayMs);
    timerHandle.unref();
  };

  const runAndSchedule = async () => {
    let nextDelayMs = inactivePollIntervalMs;
    try {
      const result = await runOnce();
      nextDelayMs = true === result.active ? pollIntervalMs : inactivePollIntervalMs;
    } catch (error: unknown) {
      dependencies.logger.log(
        "error",
        `Earnings result watcher failed: ${error}`,
      );
    } finally {
      scheduleNextRun(nextDelayMs);
    }
  };

  void runAndSchedule();

  return {
    runOnce,
    stop: () => {
      stopped = true;
      if (undefined !== timerHandle) {
        clearTimeoutFn(timerHandle);
      }
    },
  };
}

export async function getEarningsResultAnnouncements({
  dependencies = getDependencies(),
  maxAnnouncementsPerScan = defaultMaxAnnouncementsPerScan,
  secCurrentFilingsLimit = defaultSecCurrentFilingsLimit,
  seenAccessions = new Set<string>(),
}: {
  dependencies?: EarningsResultDependencies;
  maxAnnouncementsPerScan?: number;
  secCurrentFilingsLimit?: number;
  seenAccessions?: Set<string>;
} = {}): Promise<EarningsResultScanResult> {
  const now = dependencies.now().clone().tz(usEasternTimezone);
  const watches = await getTodaysEarningsWatches(dependencies, now);
  const activeWatches = watches.filter(watch => isWatchActive(watch.event, now));
  if (0 === activeWatches.length) {
    return {
      active: false,
      announcements: [],
      watchedCompanies: watches.length,
    };
  }

  const watchesByCik = groupWatchesByCik(activeWatches);
  const filings = await loadSecCurrentFilings(dependencies, secCurrentFilingsLimit);
  const announcements: EarningsResultAnnouncement[] = [];

  for (const filing of filings) {
    if (announcements.length >= maxAnnouncementsPerScan) {
      break;
    }

    if (true === seenAccessions.has(filing.accessionNumber)) {
      continue;
    }

    if (false === isFilingUpdatedToday(filing, now)) {
      continue;
    }

    const filingWatches = watchesByCik.get(filing.cik);
    const filingWatch = filingWatches?.[0];
    if (!filingWatch) {
      continue;
    }

    if (false === isLikelyEarningsFiling(filing)) {
      continue;
    }

    const announcement = await buildEarningsResultAnnouncement(
      filing,
      filingWatch,
      dependencies,
      now,
    );
    if (null !== announcement) {
      announcements.push(announcement);
    }
  }

  return {
    active: true,
    announcements,
    watchedCompanies: activeWatches.length,
  };
}

function getDependencies(options: EarningsResultWatcherOptions = {}): EarningsResultDependencies {
  return {
    getEarningsResultFn: options.getEarningsResultFn ?? getEarningsResult,
    getWithRetryFn: options.getWithRetryFn ?? getWithRetry,
    logger: options.logger ?? logger,
    now: options.now ?? (() => moment.tz(usEasternTimezone)),
  };
}

function isSendableChannel(channel: unknown): channel is SendableChannel {
  return isObjectLike(channel) &&
    "send" in channel &&
    "function" === typeof channel.send;
}

function isFetchableMessageManager(value: unknown): value is FetchableMessageManager {
  return isObjectLike(value) &&
    "fetch" in value &&
    "function" === typeof value.fetch;
}

function getOptionalChannelID(channelID: string | undefined): string | undefined {
  const normalizedChannelID = channelID?.trim();
  return normalizedChannelID ? normalizedChannelID : undefined;
}

async function fetchChannel(
  client: EarningsResultClient,
  channelID: string,
  loggerInstance: Logger,
): Promise<unknown> {
  const cachedChannel = client.channels?.cache?.get?.(channelID);
  if (undefined !== cachedChannel) {
    return cachedChannel;
  }

  const fetchChannelFn = client.channels?.fetch;
  if ("function" !== typeof fetchChannelFn) {
    return undefined;
  }

  return Promise.resolve(fetchChannelFn(channelID)).catch(error => {
    loggerInstance.log(
      "warn",
      `Could not fetch earnings result channel ${channelID}: ${error}`,
    );
    return undefined;
  });
}

async function seedSeenAccessionsFromAnnouncementHistory(
  client: EarningsResultClient,
  channelID: string,
  announcementThreadID: string | undefined,
  seenAccessions: Set<string>,
  loggerInstance: Logger,
): Promise<boolean> {
  const targetChannelID = announcementThreadID ?? channelID;
  const seededTarget = await seedSeenAccessionsFromChannelHistory(
    client,
    targetChannelID,
    seenAccessions,
    loggerInstance,
  );
  if (false === seededTarget) {
    return false;
  }

  if (undefined !== announcementThreadID && announcementThreadID !== channelID) {
    await seedSeenAccessionsFromChannelHistory(
      client,
      channelID,
      seenAccessions,
      loggerInstance,
      false,
    );
  }

  return true;
}

async function seedSeenAccessionsFromChannelHistory(
  client: EarningsResultClient,
  channelID: string,
  seenAccessions: Set<string>,
  loggerInstance: Logger,
  required = true,
): Promise<boolean> {
  const channel = await fetchChannel(client, channelID, loggerInstance);
  const messages = isObjectLike(channel) && "messages" in channel
    ? channel.messages
    : undefined;
  if (false === isFetchableMessageManager(messages)) {
    loggerInstance.log(
      "warn",
      true === required
        ? `Skipping earnings result scan: channel ${channelID} message history is not fetchable.`
        : `Could not seed earnings result announcements from optional channel ${channelID}: message history is not fetchable.`,
    );
    return false === required;
  }

  const fetchedMessages = await Promise.resolve(messages.fetch({
    limit: defaultRecentMessageFetchLimit,
  })).catch(error => {
    loggerInstance.log(
      "warn",
      `Could not seed earnings result announcements from channel history: ${error}`,
    );
    return null;
  });
  if (null === fetchedMessages) {
    return false === required;
  }

  for (const message of getFetchedMessageValues(fetchedMessages)) {
    const content = getMessageContent(message);
    if (null === content) {
      continue;
    }

    for (const accessionNumber of extractSecAccessionNumbers(content)) {
      seenAccessions.add(accessionNumber);
    }
  }

  return true;
}

function getFetchedMessageValues(fetchedMessages: unknown): unknown[] {
  if (true === isFetchedMessageCollection(fetchedMessages)) {
    return [...fetchedMessages.values()];
  }

  return [];
}

function isFetchedMessageCollection(value: unknown): value is FetchedMessageCollection {
  const values = isObjectLike(value) && "values" in value
    ? value.values
    : undefined;
  return "function" === typeof values;
}

function isObjectLike(value: unknown): value is object {
  return Object(value) === value;
}

function getMessageContent(message: unknown): string | null {
  if ("object" !== typeof message || null === message || false === "content" in message) {
    return null;
  }

  return "string" === typeof message.content ? message.content : null;
}

function extractSecAccessionNumbers(content: string): string[] {
  const accessions = new Set<string>();
  for (const match of content.matchAll(/\b\d{10}-\d{2}-\d{6}\b/g)) {
    accessions.add(match[0]);
  }

  for (const match of content.matchAll(/\/Archives\/edgar\/data\/\d+\/(\d{18})\//gi)) {
    const compactAccession = match[1];
    if (undefined === compactAccession) {
      continue;
    }

    accessions.add(formatCompactAccessionNumber(compactAccession));
  }

  return [...accessions];
}

function formatCompactAccessionNumber(value: string): string {
  return `${value.slice(0, 10)}-${value.slice(10, 12)}-${value.slice(12)}`;
}

async function sendEarningsResultAnnouncement(
  client: EarningsResultClient,
  channelID: string,
  announcementThreadID: string | undefined,
  message: string,
  loggerInstance: Logger,
): Promise<boolean> {
  const targetChannelID = announcementThreadID ?? channelID;
  const channel = await fetchChannel(client, targetChannelID, loggerInstance);
  if (false === isSendableChannel(channel)) {
    loggerInstance.log(
      "error",
      `Skipping earnings result announcement: channel ${targetChannelID} not found or not send-capable.`,
    );
    return false;
  }

  return Promise.resolve(channel.send({
    content: message,
    allowedMentions: noMentions,
  }))
    .then(() => true)
    .catch(error => {
      loggerInstance.log(
        "error",
        `Error sending earnings result announcement: ${error}`,
      );
      return false;
    });
}

async function getTodaysEarningsWatches(
  dependencies: EarningsResultDependencies,
  now: moment.Moment,
): Promise<EarningsWatchEntry[]> {
  const loadedAtMs = Date.now();
  const dateStamp = now.format(dateStampFormat);
  if (earningsWatchCache &&
      earningsWatchCache.dateStamp === dateStamp &&
      loadedAtMs - earningsWatchCache.loadedAtMs < earningsWatchTtlMs) {
    return earningsWatchCache.watches;
  }

  const [earningsResult, tickerToCompany] = await Promise.all([
    dependencies.getEarningsResultFn(0, dateStamp, {
      source: "earnings-results-watch",
    }),
    loadSecTickerMap(dependencies).catch(error => {
      dependencies.logger.log(
        "warn",
        `Skipping earnings result scan: SEC ticker map could not be loaded: ${error}`,
      );
      return null;
    }),
  ]);
  if (null === tickerToCompany) {
    earningsWatchCache = {
      dateStamp,
      loadedAtMs,
      watches: [],
    };
    return [];
  }

  if ("error" === earningsResult.status) {
    dependencies.logger.log(
      "warn",
      "Skipping earnings result scan: Nasdaq earnings schedule could not be loaded.",
    );
    earningsWatchCache = {
      dateStamp,
      loadedAtMs,
      watches: [],
    };
    return [];
  }

  const watches = buildEarningsWatches(earningsResult.events, tickerToCompany);
  earningsWatchCache = {
    dateStamp,
    loadedAtMs,
    watches,
  };
  return watches;
}

function buildEarningsWatches(
  earningsEvents: EarningsEvent[],
  tickerToCompany: Map<string, SecCompany>,
): EarningsWatchEntry[] {
  const seenCiks = new Set<string>();
  const watches: EarningsWatchEntry[] = [];

  for (const event of earningsEvents) {
    if (false === isEarningsResultAnnouncementScope(event)) {
      continue;
    }

    const normalizedTicker = normalizeTickerSymbol(event.ticker);
    const secCompany = tickerToCompany.get(normalizedTicker);
    if (!secCompany || true === seenCiks.has(secCompany.cik)) {
      continue;
    }

    seenCiks.add(secCompany.cik);
    watches.push({
      cik: secCompany.cik,
      companyName: event.companyName?.trim() || secCompany.title,
      event,
      normalizedTicker,
    });
  }

  return watches;
}

function isEarningsResultAnnouncementScope(event: EarningsEvent): boolean {
  return "number" === typeof event.marketCap &&
    true === Number.isFinite(event.marketCap) &&
    event.marketCap >= bluechipMinMarketCap;
}

function groupWatchesByCik(watches: EarningsWatchEntry[]): Map<string, EarningsWatchEntry[]> {
  const watchesByCik = new Map<string, EarningsWatchEntry[]>();
  for (const watch of watches) {
    const bucket = watchesByCik.get(watch.cik) ?? [];
    bucket.push(watch);
    watchesByCik.set(watch.cik, bucket);
  }

  return watchesByCik;
}

function isWatchActive(event: EarningsEvent, now: moment.Moment): boolean {
  const minuteOfDay = now.hours() * 60 + now.minutes();
  if ("before_open" === event.when) {
    return minuteOfDay >= 4 * 60 && minuteOfDay <= 11 * 60;
  }

  if ("after_close" === event.when) {
    return minuteOfDay >= 15 * 60 + 30 && minuteOfDay <= 23 * 60 + 30;
  }

  return minuteOfDay >= 4 * 60 && minuteOfDay <= 23 * 60 + 30;
}

function isFilingUpdatedToday(filing: SecCurrentFiling, now: moment.Moment): boolean {
  const updatedAt = moment.parseZone(filing.updated, moment.ISO_8601, true);
  if (false === updatedAt.isValid()) {
    return false;
  }

  return updatedAt.tz(usEasternTimezone).format(dateStampFormat) === now.format(dateStampFormat);
}

async function buildEarningsResultAnnouncement(
  filing: SecCurrentFiling,
  watch: EarningsWatchEntry,
  dependencies: EarningsResultDependencies,
  now: moment.Moment,
): Promise<EarningsResultAnnouncement | null> {
  const [filingDetails, xbrlMetrics] = await Promise.all([
    loadSecFilingDetails(filing, dependencies).catch(error => {
      dependencies.logger.log(
        "warn",
        `Skipping earnings result announcement for ${watch.event.ticker}: SEC filing details could not be loaded: ${error}`,
      );
      return null;
    }),
    loadSecXbrlMetrics(filing, dependencies).catch(error => {
      dependencies.logger.log(
        "debug",
        `SEC XBRL facts could not be loaded for ${watch.event.ticker}; falling back to HTML metrics: ${error}`,
      );
      return [];
    }),
  ]);
  const parsedDocument = parseEarningsDocument(filingDetails?.html ?? "");
  const sourceMetrics = mergeXbrlAndHtmlMetrics(xbrlMetrics, parsedDocument.metrics);
  const surprise = await loadNasdaqSurprise(watch.event.ticker, dependencies, now);
  const metrics = getMessageMetrics(sourceMetrics, surprise, watch.event);
  const filingUrl = filingDetails?.documentUrl || filing.filingUrl;

  if (0 === metrics.length && 0 === parsedDocument.outlook.length) {
    dependencies.logger.log(
      "warn",
      `Skipping earnings result announcement for ${watch.event.ticker}: no filing details could be parsed.`,
    );
    return null;
  }

  return {
    accessionNumber: filing.accessionNumber,
    cik: filing.cik,
    companyName: watch.companyName,
    filing,
    filingUrl,
    message: getEarningsResultMessage({
      companyName: watch.companyName,
      filing,
      filingUrl,
      metrics,
      parsedDocument,
      ticker: watch.event.ticker,
    }),
    ticker: watch.event.ticker,
  };
}

async function loadNasdaqSurprise(
  ticker: string,
  dependencies: EarningsResultDependencies,
  now: moment.Moment,
): Promise<NasdaqSurprise | null> {
  const response = await dependencies.getWithRetryFn<NasdaqSurpriseResponse>(
    `${nasdaqEarningsSurpriseEndpoint}/${encodeURIComponent(ticker)}/earnings-surprise`,
    {
      headers: nasdaqRequestHeaders,
    },
  ).catch(error => {
    dependencies.logger.log(
      "warn",
      `Loading Nasdaq earnings surprise failed for ${ticker}: ${error}`,
    );
    return null;
  });
  if (null === response) {
    return null;
  }

  const rows = response.data?.data?.earningsSurpriseTable?.rows ?? response.data?.data?.rows ?? [];
  const matchingRow = rows.find(row => isNasdaqSurpriseRowCurrent(row, now));
  if (!matchingRow) {
    return null;
  }

  return {
    actualEps: parseNumber(matchingRow.eps) ?? undefined,
    actualRevenue: parseNasdaqMoney(matchingRow.revenueActual) ?? undefined,
    consensusEps: parseNumber(matchingRow.consensusForecast) ?? undefined,
    consensusRevenue: parseNasdaqMoney(
      matchingRow.revenueEstimate ??
      matchingRow.revenueForecast ??
      matchingRow.consensusRevenue,
    ) ?? undefined,
    percentageSurprise: parseNumber(matchingRow.percentageSurprise) ?? undefined,
  };
}

function isNasdaqSurpriseRowCurrent(row: NasdaqSurpriseRow, now: moment.Moment): boolean {
  if ("string" !== typeof row.dateReported) {
    return false;
  }

  const reportedDate = moment.tz(row.dateReported, ["M/D/YYYY", "MM/DD/YYYY", dateStampFormat], true, usEasternTimezone);
  if (false === reportedDate.isValid()) {
    return false;
  }

  const daysSinceReport = now.clone().startOf("day").diff(reportedDate.startOf("day"), "days");
  return daysSinceReport >= 0 && daysSinceReport <= 4;
}

function parseNasdaqMoney(value: unknown): number | null {
  const parsedNumber = parseNumber(value);
  if (null === parsedNumber) {
    return null;
  }

  if ("string" !== typeof value) {
    return parsedNumber;
  }

  const normalizedValue = value.trim().toUpperCase();
  if (normalizedValue.endsWith("T")) {
    return parsedNumber * 1_000_000_000_000;
  }

  if (normalizedValue.endsWith("B")) {
    return parsedNumber * 1_000_000_000;
  }

  if (normalizedValue.endsWith("M")) {
    return parsedNumber * 1_000_000;
  }

  return parsedNumber;
}

export function getExampleEarningsResultOutput(): string {
  return [
    "**Apple Inc. (`AAPL`)** - Q1 2026 - [8-K](https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/a8-kex991q1202612272025.htm)",
    "📊 **Results**",
    "- **EPS:** `$2.84` vs est. `$2.67` (🟢 beat)",
    `- **Revenue:** \`${formatUsdCompact(143_800_000_000)}\` vs est. \`${formatUsdCompact(138_250_000_000)}\` (🟢 beat)`,
    `- **Net income:** \`${formatUsdCompact(42_097_000_000)}\``,
  ].join("\n");
}
