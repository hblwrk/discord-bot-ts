import moment from "moment-timezone";
import {BrokerApiRateLimiter} from "./broker-api-rate-limit.ts";
import {
  bluechipMinMarketCap,
  type EarningsEvent,
  type EarningsWhen,
  usEasternTimezone,
} from "./earnings-types.ts";
import {getLogger} from "./logging.ts";
import {type OptionDeltaCredentials} from "./options-delta.ts";
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
  logger?: ExpectedMoveLogger;
  marketCapFilter?: ExpectedMoveMarketCapFilter;
  maxEvents?: number;
  now?: () => moment.Moment;
  rateLimiter?: Pick<BrokerApiRateLimiter, "run">;
  when?: ExpectedMoveWhenFilter;
};

const defaultMaxExpectedMoveEvents = 16;
const expectedMoveRateLimitIntervalMs = 1_000;
const expectedMoveMaxQueueSize = 16;
const earningsExpectedMoveRateLimiter = new BrokerApiRateLimiter({
  maxQueueSize: expectedMoveMaxQueueSize,
  minIntervalMs: expectedMoveRateLimitIntervalMs,
});
const defaultLogger = getLogger();

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

function getExpectedMoveCandidateIndexes(
  events: EarningsEvent[],
  options: EarningsExpectedMoveOptions,
): number[] {
  const candidateIndexes: number[] = [];
  const maxEvents = Math.max(0, Math.floor(options.maxEvents ?? defaultMaxExpectedMoveEvents));
  if (0 === maxEvents) {
    return candidateIndexes;
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

    candidateIndexes.push(index);
    if (candidateIndexes.length >= maxEvents) {
      break;
    }
  }

  return candidateIndexes;
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

export async function addExpectedMovesToEarningsEvents(
  events: EarningsEvent[],
  options: EarningsExpectedMoveOptions = {},
): Promise<EarningsEvent[]> {
  if (0 === events.length) {
    return events;
  }

  const logger = options.logger ?? defaultLogger;
  const candidateIndexes = getExpectedMoveCandidateIndexes(events, options);
  if (0 === candidateIndexes.length) {
    return events;
  }

  const credentials = getExpectedMoveCredentials(options, logger);
  if (null === credentials) {
    return events;
  }

  const getOptionStraddleLookupFn = options.getOptionStraddleLookupFn ?? getOptionStraddleLookup;
  const now = options.now ?? (() => moment.tz(usEasternTimezone));
  const rateLimiter = options.rateLimiter ?? earningsExpectedMoveRateLimiter;
  const enrichedEvents = [...events];

  for (const eventIndex of candidateIndexes) {
    const event = enrichedEvents[eventIndex];
    if (undefined === event) {
      continue;
    }

    const dte = getEarningsEventDte(event, now);
    if (null === dte) {
      continue;
    }

    try {
      const result = await getOptionStraddleLookupFn({
        credentials,
        dte,
        symbol: event.ticker,
      }, {
        rateLimiter,
      });
      const expectedMove = getExpectedMoveFromMidTotal(result.midTotal);
      if (null === expectedMove) {
        continue;
      }

      enrichedEvents[eventIndex] = {
        ...event,
        expectedMove,
        expectedMoveActualDte: result.actualDte,
        expectedMoveExpiration: result.expiration,
      };
    } catch (error) {
      logger.log("warn", {
        source: "timer-earnings-expected-move",
        ticker: event.ticker,
        message: "Expected move unavailable for earnings event.",
        error: error instanceof Error ? error.name : String(error),
      });
    }
  }

  return enrichedEvents;
}
