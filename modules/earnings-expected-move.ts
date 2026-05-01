import moment from "moment-timezone";
import {BrokerApiRateLimiter} from "./broker-api-rate-limit.ts";
import {
  bluechipMinMarketCap,
  type EarningsEvent,
  type EarningsWhen,
  usEasternTimezone,
} from "./earnings-types.ts";
import {compareEarningsEventsForDisplay} from "./earnings-format.ts";
import {getLogger} from "./logging.ts";
import {
  createOptionDeltaLookupClient,
  type OptionDeltaCredentials,
  type OptionDeltaLookupDependencies,
} from "./options-delta.ts";
import {getOptionStraddleLookup} from "./options-strategy.ts";
import {readSecret} from "./secrets.ts";

type ExpectedMoveLogger = {
  log: (level: string, message: unknown) => void;
};
type ExpectedMoveMarketCapFilter = "all" | "bluechips" | string;
type ExpectedMoveWhenFilter = "all" | EarningsWhen | string;
type GetOptionStraddleLookup = typeof getOptionStraddleLookup;
type EarningsExpectedMoveOptions = {
  credentials?: OptionDeltaCredentials | null;
  getOptionStraddleLookupFn?: GetOptionStraddleLookup;
  concurrency?: number;
  logger?: ExpectedMoveLogger;
  marketCapFilter?: ExpectedMoveMarketCapFilter;
  maxCacheAgeMs?: number;
  maxEvents?: number;
  now?: () => moment.Moment;
  rateLimiter?: Pick<BrokerApiRateLimiter, "run">;
  timeoutMs?: number;
  when?: ExpectedMoveWhenFilter;
};
type ExpectedMoveCandidate = {
  cacheKey: string;
  dte: number;
  event: EarningsEvent;
  index: number;
};
type ExpectedMoveCacheEntry = {
  actualDte?: number;
  error?: string;
  expectedMove?: number;
  expiration?: string;
  status: "error" | "no_mid" | "ok";
  underlyingPrice?: number | null;
  underlyingPriceIsRealtime?: boolean;
  updatedAt: number;
};
type ExpectedMoveLookupDependencies = {
  credentials: OptionDeltaCredentials;
  getOptionStraddleLookupFn: GetOptionStraddleLookup;
  logger: ExpectedMoveLogger;
  nowMs: number;
  optionLookupDependencies: OptionDeltaLookupDependencies;
  rateLimiter: Pick<BrokerApiRateLimiter, "run">;
};

const defaultMaxExpectedMoveEvents = 500;
const defaultExpectedMoveFreshMaxAgeMs = 120_000;
const defaultExpectedMoveTimeoutMs = 15_000;
const defaultExpectedMoveConcurrency = 1;
const expectedMoveRateLimitIntervalMs = 1_000;
const expectedMoveMaxQueueSize = 512;
const earningsExpectedMoveRateLimiter = new BrokerApiRateLimiter({
  maxQueueSize: expectedMoveMaxQueueSize,
  minIntervalMs: expectedMoveRateLimitIntervalMs,
});
const defaultLogger = getLogger();
const expectedMoveCache = new Map<string, ExpectedMoveCacheEntry>();
const expectedMoveLookupsInFlight = new Map<string, Promise<ExpectedMoveCacheEntry>>();

function getExpectedMoveCredentials(
  options: EarningsExpectedMoveOptions,
  logger: ExpectedMoveLogger,
): OptionDeltaCredentials | null {
  if ("credentials" in options) {
    return options.credentials ?? null;
  }

  try {
    return {
      clientSecret: readSecret("tastytrade_client_secret"),
      refreshToken: readSecret("tastytrade_refresh_token"),
    };
  } catch {
    logger.log("warn", {
      source: "timer-earnings-expected-move",
      message: "Skipping earnings expected moves: option data credentials are unavailable.",
    });
    return null;
  }
}

function isIncludedByWhenFilter(event: EarningsEvent, when: ExpectedMoveWhenFilter | undefined): boolean {
  if (undefined === when || "all" === when) {
    return true;
  }

  return event.when === when;
}

function isIncludedByMarketCapFilter(
  event: EarningsEvent,
  marketCapFilter: ExpectedMoveMarketCapFilter | undefined,
): boolean {
  if ("bluechips" !== marketCapFilter) {
    return true;
  }

  return "number" === typeof event.marketCap
    && Number.isFinite(event.marketCap)
    && event.marketCap >= bluechipMinMarketCap;
}

function getExpectedMoveCacheKey(event: EarningsEvent, dte: number): string {
  return `${event.ticker.trim().toUpperCase()}:${event.date}:${dte}`;
}

function getExpectedMoveCandidates(
  events: EarningsEvent[],
  options: EarningsExpectedMoveOptions,
  now: () => moment.Moment,
): ExpectedMoveCandidate[] {
  const candidates: ExpectedMoveCandidate[] = [];
  const maxEvents = Math.max(0, Math.floor(options.maxEvents ?? defaultMaxExpectedMoveEvents));
  if (0 === maxEvents) {
    return candidates;
  }

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (undefined === event) {
      continue;
    }

    if (false === isIncludedByWhenFilter(event, options.when)
        || false === isIncludedByMarketCapFilter(event, options.marketCapFilter)) {
      continue;
    }

    const dte = getEarningsEventDte(event, now);
    if (null === dte) {
      continue;
    }

    candidates.push({
      cacheKey: getExpectedMoveCacheKey(event, dte),
      dte,
      event,
      index,
    });
  }

  return candidates
    .sort((first, second) => compareEarningsEventsForDisplay(first.event, second.event))
    .slice(0, maxEvents);
}

function getEarningsEventDte(event: EarningsEvent, now: () => moment.Moment): number | null {
  const eventDate = moment.tz(event.date, "YYYY-MM-DD", true, usEasternTimezone);
  if (false === eventDate.isValid()) {
    return null;
  }

  const currentDate = now().clone().tz(usEasternTimezone).startOf("day");
  return Math.max(0, eventDate.startOf("day").diff(currentDate, "days"));
}

function getExpectedMoveFromMidTotal(midTotal: number | null): number | null {
  if ("number" !== typeof midTotal || false === Number.isFinite(midTotal) || midTotal < 0) {
    return null;
  }

  return midTotal;
}

function getFreshExpectedMoveCacheEntry(
  cacheKey: string,
  nowMs: number,
  maxCacheAgeMs: number,
): ExpectedMoveCacheEntry | null {
  const cacheEntry = expectedMoveCache.get(cacheKey);
  if (undefined === cacheEntry) {
    return null;
  }

  if (cacheEntry.updatedAt > nowMs || nowMs - cacheEntry.updatedAt > maxCacheAgeMs) {
    return null;
  }

  return cacheEntry;
}

function applyExpectedMoveCacheEntry(
  event: EarningsEvent,
  cacheEntry: ExpectedMoveCacheEntry,
): EarningsEvent {
  if ("ok" !== cacheEntry.status || undefined === cacheEntry.expectedMove || undefined === cacheEntry.expiration) {
    return event;
  }

  const enrichedEvent: EarningsEvent = {
    ...event,
    expectedMove: cacheEntry.expectedMove,
    expectedMoveExpiration: cacheEntry.expiration,
  };
  if (undefined !== cacheEntry.actualDte) {
    enrichedEvent.expectedMoveActualDte = cacheEntry.actualDte;
  }
  if (undefined !== cacheEntry.underlyingPrice) {
    enrichedEvent.expectedMoveUnderlyingPrice = cacheEntry.underlyingPrice;
  }
  if (undefined !== cacheEntry.underlyingPriceIsRealtime) {
    enrichedEvent.expectedMoveUnderlyingPriceIsRealtime = cacheEntry.underlyingPriceIsRealtime;
  }

  return enrichedEvent;
}

async function lookupExpectedMoveCacheEntry(
  candidate: ExpectedMoveCandidate,
  dependencies: ExpectedMoveLookupDependencies,
): Promise<ExpectedMoveCacheEntry> {
  try {
    const result = await dependencies.getOptionStraddleLookupFn({
      credentials: dependencies.credentials,
      dte: candidate.dte,
      symbol: candidate.event.ticker,
    }, {
      ...dependencies.optionLookupDependencies,
      rateLimiter: dependencies.rateLimiter,
    });
    const expectedMove = getExpectedMoveFromMidTotal(result.midTotal);
    if (null === expectedMove) {
      dependencies.logger.log("warn", {
        source: "timer-earnings-expected-move",
        ticker: candidate.event.ticker,
        message: "Expected move unavailable because the ATM straddle mid is missing.",
      });
      return {
        status: "no_mid",
        updatedAt: dependencies.nowMs,
      };
    }

    return {
      actualDte: result.actualDte,
      expectedMove,
      expiration: result.expiration,
      status: "ok",
      underlyingPrice: result.underlyingPrice,
      underlyingPriceIsRealtime: result.underlyingPriceIsRealtime,
      updatedAt: dependencies.nowMs,
    };
  } catch (error) {
    dependencies.logger.log("warn", {
      source: "timer-earnings-expected-move",
      ticker: candidate.event.ticker,
      message: "Expected move unavailable for earnings event.",
      error: error instanceof Error ? error.name : String(error),
    });
    return {
      error: error instanceof Error ? error.name : String(error),
      status: "error",
      updatedAt: dependencies.nowMs,
    };
  }
}

function refreshExpectedMoveCacheEntry(
  candidate: ExpectedMoveCandidate,
  dependencies: ExpectedMoveLookupDependencies,
): Promise<ExpectedMoveCacheEntry> {
  const lookupInFlight = expectedMoveLookupsInFlight.get(candidate.cacheKey);
  if (undefined !== lookupInFlight) {
    return lookupInFlight;
  }

  const lookup = lookupExpectedMoveCacheEntry(candidate, dependencies)
    .then(cacheEntry => {
      expectedMoveCache.set(candidate.cacheKey, cacheEntry);
      return cacheEntry;
    })
    .finally(() => {
      expectedMoveLookupsInFlight.delete(candidate.cacheKey);
    });
  expectedMoveLookupsInFlight.set(candidate.cacheKey, lookup);
  return lookup;
}

function wait(delayMs: number): Promise<null> {
  return new Promise(resolve => {
    setTimeout(() => resolve(null), delayMs);
  });
}

async function waitForExpectedMoveCacheEntry(
  candidate: ExpectedMoveCandidate,
  dependencies: ExpectedMoveLookupDependencies,
  deadlineMs: number,
): Promise<ExpectedMoveCacheEntry | null> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    return null;
  }

  return Promise.race([
    refreshExpectedMoveCacheEntry(candidate, dependencies),
    wait(remainingMs),
  ]);
}

async function refreshExpectedMoveCandidates(
  candidates: ExpectedMoveCandidate[],
  dependencies: ExpectedMoveLookupDependencies,
  options: {
    concurrency: number;
    deadlineMs: number;
    onCacheEntry?: (candidate: ExpectedMoveCandidate, cacheEntry: ExpectedMoveCacheEntry) => void;
  },
): Promise<void> {
  let nextCandidateIndex = 0;
  const workerCount = Math.min(options.concurrency, candidates.length);
  const workers = Array.from({length: workerCount}, async () => {
    while (Date.now() < options.deadlineMs) {
      const candidate = candidates[nextCandidateIndex];
      nextCandidateIndex++;
      if (undefined === candidate) {
        return;
      }

      const cacheEntry = await waitForExpectedMoveCacheEntry(candidate, dependencies, options.deadlineMs);
      if (null !== cacheEntry) {
        options.onCacheEntry?.(candidate, cacheEntry);
      }
    }
  });

  await Promise.all(workers);
}

export async function addExpectedMovesToEarningsEvents(
  events: EarningsEvent[],
  options: EarningsExpectedMoveOptions = {},
): Promise<EarningsEvent[]> {
  if (0 === events.length) {
    return events;
  }

  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => moment.tz(usEasternTimezone));
  const nowMs = now().valueOf();
  const maxCacheAgeMs = Math.max(0, Math.floor(options.maxCacheAgeMs ?? defaultExpectedMoveFreshMaxAgeMs));
  const candidates = getExpectedMoveCandidates(events, options, now);
  if (0 === candidates.length) {
    return events;
  }

  const enrichedEvents = [...events];
  const candidatesToRefresh: ExpectedMoveCandidate[] = [];
  for (const candidate of candidates) {
    const cacheEntry = getFreshExpectedMoveCacheEntry(candidate.cacheKey, nowMs, maxCacheAgeMs);
    if (null === cacheEntry) {
      candidatesToRefresh.push(candidate);
      continue;
    }

    enrichedEvents[candidate.index] = applyExpectedMoveCacheEntry(candidate.event, cacheEntry);
  }

  if (0 === candidatesToRefresh.length) {
    return enrichedEvents;
  }

  const credentials = getExpectedMoveCredentials(options, logger);
  if (null === credentials) {
    return enrichedEvents;
  }

  const getOptionStraddleLookupFn = options.getOptionStraddleLookupFn ?? getOptionStraddleLookup;
  const sharedOptionClient = getOptionStraddleLookupFn === getOptionStraddleLookup
    ? createOptionDeltaLookupClient(credentials)
    : null;
  const optionLookupDependencies: OptionDeltaLookupDependencies = null === sharedOptionClient
    ? {}
    : {
      clientFactory: () => sharedOptionClient,
    };
  const rateLimiter = options.rateLimiter ?? earningsExpectedMoveRateLimiter;
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? defaultExpectedMoveTimeoutMs));
  const deadlineMs = Date.now() + timeoutMs;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? defaultExpectedMoveConcurrency));
  await refreshExpectedMoveCandidates(candidatesToRefresh, {
    credentials,
    getOptionStraddleLookupFn,
    logger,
    nowMs,
    optionLookupDependencies,
    rateLimiter,
  }, {
    concurrency,
    deadlineMs,
    onCacheEntry: (candidate, cacheEntry) => {
      enrichedEvents[candidate.index] = applyExpectedMoveCacheEntry(candidate.event, cacheEntry);
    },
  });

  return enrichedEvents;
}

export async function warmExpectedMoveCacheForEarningsEvents(
  events: EarningsEvent[],
  options: EarningsExpectedMoveOptions = {},
): Promise<void> {
  await addExpectedMovesToEarningsEvents(events, {
    ...options,
    timeoutMs: options.timeoutMs ?? 105_000,
  });
}

export function clearExpectedMoveCacheForTests() {
  expectedMoveCache.clear();
  expectedMoveLookupsInFlight.clear();
}
