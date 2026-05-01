import moment from "moment-timezone";
import {describe, expect, test, vi} from "vitest";
import {type BrokerApiRateLimiter} from "./broker-api-rate-limit.ts";
import {addExpectedMovesToEarningsEvents} from "./earnings-expected-move.ts";
import {type EarningsEvent} from "./earnings-types.ts";
import {type OptionDeltaCredentials} from "./options-delta.ts";
import {type OptionStrategyLookupResult, type getOptionStraddleLookup} from "./options-strategy.ts";

const credentials: OptionDeltaCredentials = {
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
};
const rateLimiter: Pick<BrokerApiRateLimiter, "run"> = {
  run: operation => operation(),
};
const now = () => moment.tz("2025-02-18T12:00:00", "US/Eastern");

function createEarningsEvent(overrides: Partial<EarningsEvent> = {}): EarningsEvent {
  return {
    ticker: "AAPL",
    when: "after_close",
    date: "2025-02-21",
    importance: 1,
    companyName: "Apple",
    marketCap: 2_800_000_000_000,
    marketCapText: "$2.8T",
    epsConsensus: "2.13",
    ...overrides,
  };
}

function createLookupResult(overrides: Partial<OptionStrategyLookupResult> = {}): OptionStrategyLookupResult {
  return {
    actualDte: 3,
    call: null,
    expiration: "2025-02-21",
    midTotal: 12.4,
    put: null,
    requestedDte: 3,
    rolled: false,
    symbol: "AAPL",
    targetDelta: 0.5,
    underlyingPrice: 190.42,
    underlyingPriceIsRealtime: true,
    ...overrides,
  };
}

describe("earnings expected move enrichment", () => {
  test("skips lookups when credentials are unavailable", async () => {
    const lookupMock = vi.fn();
    const events = [createEarningsEvent()];

    const result = await addExpectedMovesToEarningsEvents(events, {
      credentials: null,
      getOptionStraddleLookupFn: lookupMock as unknown as typeof getOptionStraddleLookup,
      now,
      rateLimiter,
    });

    expect(result).toBe(events);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test("adds expected moves for timer-filtered bluechip earnings", async () => {
    const lookupMock = vi.fn(async () => createLookupResult({
      actualDte: 4,
      expiration: "2025-02-22",
      midTotal: 13.25,
      rolled: true,
    }));
    const bluechipEvent = createEarningsEvent({ticker: "NVDA"});
    const smallCapEvent = createEarningsEvent({
      ticker: "SMALL",
      marketCap: 2_000_000_000,
    });

    const result = await addExpectedMovesToEarningsEvents([smallCapEvent, bluechipEvent], {
      credentials,
      getOptionStraddleLookupFn: lookupMock as unknown as typeof getOptionStraddleLookup,
      marketCapFilter: "bluechips",
      now,
      rateLimiter,
      when: "all",
    });

    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledWith({
      credentials,
      dte: 3,
      symbol: "NVDA",
    }, {
      rateLimiter,
    });
    expect(result[0]).toEqual(smallCapEvent);
    expect(result[1]).toEqual({
      ...bluechipEvent,
      expectedMove: 13.25,
      expectedMoveActualDte: 4,
      expectedMoveExpiration: "2025-02-22",
    });
  });

  test("keeps earnings events when expected moves are unavailable", async () => {
    const logger = {
      log: vi.fn(),
    };
    const lookupMock = vi.fn(async () => {
      throw new Error("quote unavailable");
    });
    const event = createEarningsEvent({ticker: "MSFT"});

    const result = await addExpectedMovesToEarningsEvents([event], {
      credentials,
      getOptionStraddleLookupFn: lookupMock as unknown as typeof getOptionStraddleLookup,
      logger,
      now,
      rateLimiter,
    });

    expect(result).toEqual([event]);
    expect(logger.log).toHaveBeenCalledWith("warn", expect.objectContaining({
      message: "Expected move unavailable for earnings event.",
      source: "timer-earnings-expected-move",
      ticker: "MSFT",
    }));
  });
});
