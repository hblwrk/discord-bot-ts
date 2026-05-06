import moment from "moment-timezone";
import {clearEarningsScheduleCache, type EarningsEvent, getEarningsResult} from "./earnings.ts";
import {
  clearEarningsWhispersWeeklyTickerCache,
  loadEarningsWhispersWeeklyTickers,
} from "./earnings-whispers.ts";
import {
  checkEarningsQualityWithAi,
  clearEarningsAiState,
  extractEarningsWithAi,
  getSuspiciousEarningsReasons,
  hasHighSeveritySuspicion,
  mergeAiMetrics,
  type SuspiciousEarningsReason,
} from "./earnings-results-ai.ts";
import {
  formatUsdCompact,
  getEarningsResultMessage,
  getMessageMetrics,
  htmlToText,
  normalizeTickerSymbol,
  parseEarningsDocument,
  parseNumber,
  type EarningsResultMetric,
  type ParsedEarningsDocument,
  type NasdaqSurprise,
} from "./earnings-results-format.ts";
import {
  getEarningsResultKey,
  seedSeenEarningsResultAnnouncementsFromHistory,
} from "./earnings-results-history.ts";
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
import {summarizeEarningsWithAi} from "./earnings-results-summary.ts";
import {getWithRetry, type postWithRetry} from "./http-retry.ts";
import {getLogger} from "./logging.ts";
import {type readSecret} from "./secrets.ts";

type Logger = {
  log: (level: string, message: unknown) => void;
};

type SendableChannel = {
  send: (payload: unknown) => Promise<unknown> | unknown;
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
  getPromotedEarningsTickersFn?: ((now: moment.Moment) => Promise<Set<string>>) | undefined;
  inactivePollIntervalMs?: number;
  logger?: Logger;
  maxAnnouncementsPerScan?: number;
  nowMs?: () => number;
  now?: () => moment.Moment;
  pollIntervalMs?: number;
  postWithRetryFn?: typeof postWithRetry;
  readSecretFn?: typeof readSecret;
  secCurrentFilingsLimit?: number;
  setTimeoutFn?: typeof setTimeout;
};

type EarningsResultDependencies = Required<Pick<
  EarningsResultWatcherOptions,
  "getEarningsResultFn" | "getWithRetryFn" | "logger" | "now"
>> & Pick<EarningsResultWatcherOptions, "getPromotedEarningsTickersFn" | "nowMs" | "postWithRetryFn" | "readSecretFn">;

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

type NoMetricsSkipState = {
  gaveUp: boolean;
  giveUpAfterMs: number;
  retryAfterMs: number;
};

type SecFilingDetails = {
  documentUrl: string;
  html: string;
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
const earningsResultMinMarketCap = 100_000_000_000;
const earningsWatchTtlMs = 15 * 60_000;
const noMetricsRetryDelayMs = 5 * 60_000;
const noMetricsGiveUpDelayMs = 15 * 60_000;
const qualityGateRetryDelayMs = 5 * 60_000;
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
  clearEarningsWhispersWeeklyTickerCache();
  clearSecEarningsResultCaches();
  clearEarningsAiState();
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
  const seenResultKeys = new Set<string>();
  const skippedNoMetricsAccessions = new Map<string, NoMetricsSkipState>();
  const skippedQualityGateAccessions = new Map<string, number>();
  const dependencies = getDependencies(options);
  let seenAccessionsSeeded = false;
  let stopped = false;
  let timerHandle: TimerHandle | undefined;

  const runOnce = async (): Promise<EarningsResultScanResult> => {
    if (false === seenAccessionsSeeded) {
      const seeded = await seedSeenEarningsResultAnnouncementsFromHistory({
        announcementThreadID,
        channelID,
        client,
        dateStamp: dependencies.now().clone().tz(usEasternTimezone).format(dateStampFormat),
        logger: dependencies.logger,
        seenAccessions,
        seenResultKeys,
      });
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
      seenResultKeys: Set<string>;
      skippedNoMetricsAccessions: Map<string, NoMetricsSkipState>;
      skippedQualityGateAccessions: Map<string, number>;
    } = {
      dependencies,
      seenAccessions,
      seenResultKeys,
      skippedNoMetricsAccessions,
      skippedQualityGateAccessions,
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
        seenResultKeys.add(getEarningsResultKey(announcement.ticker, nowDateStamp(dependencies)));
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
  seenResultKeys = new Set<string>(),
  skippedNoMetricsAccessions = new Map<string, NoMetricsSkipState>(),
  skippedQualityGateAccessions = new Map<string, number>(),
}: {
  dependencies?: EarningsResultDependencies;
  maxAnnouncementsPerScan?: number;
  secCurrentFilingsLimit?: number;
  seenAccessions?: Set<string>;
  seenResultKeys?: Set<string>;
  skippedNoMetricsAccessions?: Map<string, NoMetricsSkipState>;
  skippedQualityGateAccessions?: Map<string, number>;
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
  const announcedResultKeys = new Set(seenResultKeys);

  for (const filing of filings) {
    if (announcements.length >= maxAnnouncementsPerScan) {
      break;
    }

    if (true === seenAccessions.has(filing.accessionNumber)) {
      continue;
    }

    const qualityGateRetryAfterMs = skippedQualityGateAccessions.get(filing.accessionNumber);
    if (undefined !== qualityGateRetryAfterMs) {
      if (now.valueOf() < qualityGateRetryAfterMs) {
        continue;
      }

      skippedQualityGateAccessions.delete(filing.accessionNumber);
    }

    const noMetricsSkipState = skippedNoMetricsAccessions.get(filing.accessionNumber);
    if (undefined !== noMetricsSkipState) {
      if (true === noMetricsSkipState.gaveUp || now.valueOf() < noMetricsSkipState.retryAfterMs) {
        continue;
      }
    }

    if (false === isFilingUpdatedToday(filing, now)) {
      continue;
    }

    const filingWatches = watchesByCik.get(filing.cik);
    const filingWatch = filingWatches?.[0];
    if (!filingWatch) {
      continue;
    }

    const resultKey = getEarningsResultKey(filingWatch.event.ticker, now.format(dateStampFormat));
    if (true === announcedResultKeys.has(resultKey)) {
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
      skippedNoMetricsAccessions,
      skippedQualityGateAccessions,
    );
    if (null !== announcement) {
      announcements.push(announcement);
      announcedResultKeys.add(resultKey);
    }
  }

  return {
    active: true,
    announcements,
    watchedCompanies: activeWatches.length,
  };
}

function getDependencies(options: EarningsResultWatcherOptions = {}): EarningsResultDependencies {
  const dependencies: EarningsResultDependencies = {
    getEarningsResultFn: options.getEarningsResultFn ?? getEarningsResult,
    getWithRetryFn: options.getWithRetryFn ?? getWithRetry,
    logger: options.logger ?? logger,
    now: options.now ?? (() => moment.tz(usEasternTimezone)),
  };
  dependencies.getPromotedEarningsTickersFn = options.getPromotedEarningsTickersFn ??
    (now => loadEarningsWhispersWeeklyTickers({
      getWithRetryFn: dependencies.getWithRetryFn,
      logger: dependencies.logger,
      now,
    }));
  if (undefined !== options.nowMs) {
    dependencies.nowMs = options.nowMs;
  }
  if (undefined !== options.postWithRetryFn) {
    dependencies.postWithRetryFn = options.postWithRetryFn;
  }
  if (undefined !== options.readSecretFn) {
    dependencies.readSecretFn = options.readSecretFn;
  }

  return dependencies;
}

function isSendableChannel(channel: unknown): channel is SendableChannel {
  return isObjectLike(channel) &&
    "send" in channel &&
    "function" === typeof channel.send;
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

function isObjectLike(value: unknown): value is object {
  return Object(value) === value;
}

function nowDateStamp(dependencies: EarningsResultDependencies): string {
  return dependencies.now().clone().tz(usEasternTimezone).format(dateStampFormat);
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

  const [earningsResult, tickerToCompany, promotedTickers] = await Promise.all([
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
    dependencies.getPromotedEarningsTickersFn?.(now).catch(error => {
      dependencies.logger.log(
        "debug",
        {
          source: "earnings-results-watch",
          message: `Could not load promoted earnings tickers: ${error}`,
        },
      );
      return new Set<string>();
    }) ?? Promise.resolve(new Set<string>()),
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

  const watches = buildEarningsWatches(earningsResult.events, tickerToCompany, promotedTickers);
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
  promotedTickers: Set<string> = new Set(),
): EarningsWatchEntry[] {
  const seenCiks = new Set<string>();
  const watches: EarningsWatchEntry[] = [];

  for (const event of earningsEvents) {
    const normalizedTicker = normalizeTickerSymbol(event.ticker);
    if (false === isEarningsResultAnnouncementScope(event, normalizedTicker, promotedTickers)) {
      continue;
    }

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

function isEarningsResultAnnouncementScope(
  event: EarningsEvent,
  normalizedTicker: string,
  promotedTickers: Set<string>,
): boolean {
  if (true === promotedTickers.has(normalizedTicker)) {
    return true;
  }

  return "number" === typeof event.marketCap &&
    true === Number.isFinite(event.marketCap) &&
    event.marketCap >= earningsResultMinMarketCap;
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
  skippedNoMetricsAccessions: Map<string, NoMetricsSkipState>,
  skippedQualityGateAccessions: Map<string, number>,
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
  let parsedDocument = parseEarningsDocument(filingDetails?.html ?? "");
  let sourceMetrics = mergeXbrlAndHtmlMetrics(xbrlMetrics, parsedDocument.metrics);
  const surprise = await loadNasdaqSurprise(watch.event.ticker, dependencies, now);
  const initialMetrics = getMessageMetrics(sourceMetrics, surprise, watch.event);
  const initialSuspiciousReasons = [
    ...getSuspiciousEarningsReasons(initialMetrics, surprise, watch.event),
    ...getSuspiciousQuarterReasons(parsedDocument.quarterLabel, now),
  ];
  const aiExtraction = shouldRunAiExtraction({
    filing,
    filingDetails,
    parsedDocument,
    sourceMetrics,
    suspiciousReasons: initialSuspiciousReasons,
  })
    ? await extractEarningsWithAi({
      companyName: watch.companyName,
      filingForm: filing.form,
      filingUrl: filingDetails?.documentUrl || filing.filingUrl,
      html: filingDetails?.html ?? "",
      ticker: watch.event.ticker,
    }, dependencies)
    : null;
  if (null !== aiExtraction) {
    sourceMetrics = mergeAiMetrics(sourceMetrics, aiExtraction.metrics, initialSuspiciousReasons);
    if (undefined === parsedDocument.quarterLabel && undefined !== aiExtraction.quarterLabel) {
      parsedDocument = {
        ...parsedDocument,
        quarterLabel: aiExtraction.quarterLabel,
      };
    }
  }

  const metrics = getMessageMetrics(sourceMetrics, surprise, watch.event);
  const suspiciousReasons = [
    ...getSuspiciousEarningsReasons(metrics, surprise, watch.event),
    ...getSuspiciousQuarterReasons(parsedDocument.quarterLabel, now),
  ];
  const filingUrl = filingDetails?.documentUrl || filing.filingUrl;

  if (0 === metrics.length && 0 === parsedDocument.outlook.length) {
    updateNoMetricsSkipState(filing, watch, dependencies, now, skippedNoMetricsAccessions);
    return null;
  }

  skippedNoMetricsAccessions.delete(filing.accessionNumber);

  let message = getEarningsResultMessage({
    companyName: watch.companyName,
    filing,
    filingUrl,
    metrics,
    parsedDocument,
    ticker: watch.event.ticker,
  });
  if (true === hasHardMetricContradiction(suspiciousReasons)) {
    skippedQualityGateAccessions.set(filing.accessionNumber, now.valueOf() + qualityGateRetryDelayMs);
    dependencies.logger.log(
      "warn",
      `Skipping earnings result announcement for ${watch.event.ticker}: suspicious metrics were not verified.`,
    );
    return null;
  }

  const qualityGate = await checkEarningsQualityWithAi({
    companyName: watch.companyName,
    event: watch.event,
    filingForm: filing.form,
    filingUrl,
    html: filingDetails?.html ?? "",
    message,
    metrics,
    reasons: suspiciousReasons,
    surprise,
    ticker: watch.event.ticker,
  }, dependencies);
  if (true === shouldSuppressAnnouncement(qualityGate, suspiciousReasons)) {
    skippedQualityGateAccessions.set(filing.accessionNumber, now.valueOf() + qualityGateRetryDelayMs);
    dependencies.logger.log(
      "warn",
      `Skipping earnings result announcement for ${watch.event.ticker}: suspicious metrics were not verified.`,
    );
    return null;
  }

  const summary = await summarizeEarningsWithAi({
    companyName: watch.companyName,
    filingForm: filing.form,
    filingUrl,
    html: filingDetails?.html ?? "",
    metrics,
    ticker: watch.event.ticker,
  }, dependencies);
  if (null !== summary) {
    message = getEarningsResultMessage({
      companyName: watch.companyName,
      filing,
      filingUrl,
      metrics,
      parsedDocument,
      summary,
      ticker: watch.event.ticker,
    });
  }

  return {
    accessionNumber: filing.accessionNumber,
    cik: filing.cik,
    companyName: watch.companyName,
    filing,
    filingUrl,
    message,
    ticker: watch.event.ticker,
  };
}

function updateNoMetricsSkipState(
  filing: SecCurrentFiling,
  watch: EarningsWatchEntry,
  dependencies: EarningsResultDependencies,
  now: moment.Moment,
  skippedNoMetricsAccessions: Map<string, NoMetricsSkipState>,
) {
  const nowMs = now.valueOf();
  const existingState = skippedNoMetricsAccessions.get(filing.accessionNumber);
  if (undefined === existingState) {
    skippedNoMetricsAccessions.set(filing.accessionNumber, {
      gaveUp: false,
      giveUpAfterMs: nowMs + noMetricsGiveUpDelayMs,
      retryAfterMs: nowMs + noMetricsRetryDelayMs,
    });
    dependencies.logger.log(
      "warn",
      `Skipping earnings result announcement for ${watch.event.ticker}: no earnings metrics or outlook could be parsed; will retry for up to 15 minutes.`,
    );
    return;
  }

  if (nowMs >= existingState.giveUpAfterMs) {
    skippedNoMetricsAccessions.set(filing.accessionNumber, {
      ...existingState,
      gaveUp: true,
      retryAfterMs: Number.POSITIVE_INFINITY,
    });
    dependencies.logger.log(
      "warn",
      `Giving up earnings result announcement for ${watch.event.ticker}: no earnings metrics or outlook could be parsed after 15 minutes.`,
    );
    return;
  }

  skippedNoMetricsAccessions.set(filing.accessionNumber, {
    ...existingState,
    retryAfterMs: nowMs + noMetricsRetryDelayMs,
  });
}

function shouldRunAiExtraction({
  filing,
  filingDetails,
  parsedDocument,
  sourceMetrics,
  suspiciousReasons,
}: {
  filing: SecCurrentFiling;
  filingDetails: SecFilingDetails | null;
  parsedDocument: ParsedEarningsDocument;
  sourceMetrics: EarningsResultMetric[];
  suspiciousReasons: SuspiciousEarningsReason[];
}): boolean {
  const html = filingDetails?.html ?? "";
  if ("" === html.trim()) {
    return false;
  }

  if (0 < sourceMetrics.length) {
    return 0 < suspiciousReasons.length;
  }

  if (0 < parsedDocument.outlook.length) {
    return false;
  }

  return isLikelyUsefulAiExtractionDocument(filing, filingDetails);
}

function isLikelyUsefulAiExtractionDocument(
  filing: SecCurrentFiling,
  filingDetails: SecFilingDetails | null,
): boolean {
  if (null === filingDetails) {
    return false;
  }

  const documentName = getUrlFileName(filingDetails.documentUrl);
  if (true === isLikelyEarningsReleaseFileName(documentName)) {
    return true;
  }

  if ("8-K" === filing.form.toUpperCase()) {
    return false;
  }

  return hasEarningsReleaseTextEvidence(filingDetails.html);
}

function getUrlFileName(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return pathname.slice(pathname.lastIndexOf("/") + 1).toLowerCase();
  } catch {
    const normalizedUrl = url.toLowerCase();
    return normalizedUrl.slice(normalizedUrl.lastIndexOf("/") + 1);
  }
}

function isLikelyEarningsReleaseFileName(name: string): boolean {
  return /(?:^|[^a-z0-9])ex(?:hibit)?[-_\s]?99(?:[-_.\s]?1)?(?:[^a-z0-9]|$)/i.test(name) ||
    name.includes("ex99") ||
    name.includes("exhibit991") ||
    /\b(?:earnings|release|results)\b/i.test(name);
}

function hasEarningsReleaseTextEvidence(html: string): boolean {
  const text = normalizeAiPreflightText(html);
  if ("" === text) {
    return false;
  }

  const hasReleaseHeadline = /\b(?:reports?|announces?|released?|issues?)\b.{0,120}\b(?:quarter|fiscal|year|annual)\b.{0,120}\b(?:results?|earnings)\b/i.test(text) ||
    /\b(?:quarterly|annual)\s+(?:financial\s+)?results?\b/i.test(text);
  const hasMetricCue = /\b(?:revenue|sales|net\s+income|net\s+earnings|earnings\s+per\s+share|eps|adjusted\s+ebitda)\b/i.test(text);
  const hasQuantitativeCue = /(?:[$€£¥]\s?\(?\d|\b\d+(?:[,.]\d+)?\s?(?:million|billion|m|bn|%|cents|per\s+share)\b)/i.test(text);
  return hasReleaseHeadline && hasMetricCue && hasQuantitativeCue;
}

function normalizeAiPreflightText(html: string): string {
  return htmlToText(html)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60_000);
}

function shouldSuppressAnnouncement(
  qualityGate: {confidence: number; decision: "allow" | "suppress";} | null,
  suspiciousReasons: SuspiciousEarningsReason[],
): boolean {
  if (true === hasHardMetricContradiction(suspiciousReasons)) {
    return true;
  }

  if (null !== qualityGate) {
    return "suppress" === qualityGate.decision && qualityGate.confidence >= 0.75;
  }

  return hasHighSeveritySuspicion(suspiciousReasons);
}

function hasHardMetricContradiction(suspiciousReasons: SuspiciousEarningsReason[]): boolean {
  return suspiciousReasons.some(reason =>
    "high" === reason.severity &&
    "revenue" === reason.metricKey &&
    /\b(?:lower\s+than\s+net\s+income|not\s+positive\s+while\s+net\s+income)\b/i.test(reason.message));
}

function getSuspiciousQuarterReasons(
  quarterLabel: string | undefined,
  now: moment.Moment,
): SuspiciousEarningsReason[] {
  const reportedQuarter = parseQuarterLabel(quarterLabel);
  if (null === reportedQuarter) {
    return [];
  }

  const currentQuarterStart = now.clone().startOf("quarter");
  const previousQuarterStart = currentQuarterStart.clone().subtract(1, "quarter");
  const reportedQuarterStart = moment.tz(
    `${reportedQuarter.year}-${String((reportedQuarter.quarter - 1) * 3 + 1).padStart(2, "0")}-01`,
    dateStampFormat,
    usEasternTimezone,
  );
  if (false === reportedQuarterStart.isBefore(previousQuarterStart, "day")) {
    return [];
  }

  const daysIntoCurrentQuarter = now.clone().startOf("day").diff(currentQuarterStart, "days");
  return [{
    message: `Filing period ${quarterLabel} is older than the previous calendar quarter for this earnings date.`,
    severity: daysIntoCurrentQuarter >= 21 ? "high" : "medium",
  }];
}

function parseQuarterLabel(quarterLabel: string | undefined): {quarter: number; year: number;} | null {
  const quarterMatch = quarterLabel?.match(/^Q([1-4])\s+(20\d{2})$/i);
  if (undefined === quarterMatch?.[1] || undefined === quarterMatch[2]) {
    return null;
  }

  return {
    quarter: Number.parseInt(quarterMatch[1], 10),
    year: Number.parseInt(quarterMatch[2], 10),
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
  return getEarningsResultMessage({
    companyName: "Apple Inc.",
    filing: {
      form: "8-K",
      items: ["2.02", "9.01"],
    },
    filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/a8-kex991q1202612272025.htm",
    metrics: [{
      key: "gaap_eps",
      label: "EPS",
      value: "$2.84",
      estimate: "$2.67",
      outcome: "beat",
    }, {
      key: "revenue",
      label: "Revenue",
      value: formatUsdCompact(143_800_000_000),
      estimate: formatUsdCompact(138_250_000_000),
      outcome: "beat",
    }, {
      key: "net_income",
      label: "Net income",
      value: formatUsdCompact(42_097_000_000),
    }],
    parsedDocument: {
      metrics: [],
      outlook: [],
      quarterLabel: "Q1 2026",
    },
    summary: "Apple reported Q1 2026 results ahead of expectations, with EPS of `$2.84` and revenue of `$143.8B` both beating consensus. Revenue strength supported net income of `$42.1B` for the quarter. The company did not provide a quantified outlook.",
    ticker: "AAPL",
  });
}
