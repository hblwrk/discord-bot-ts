import {afterEach, describe, expect, test, vi} from "vitest";
import {BrokerApiRateLimitError, BrokerApiRateLimiter} from "./broker-api-rate-limit.ts";

describe("BrokerApiRateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("runs one operation at a time and spaces operation starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const limiter = new BrokerApiRateLimiter({
      maxQueueSize: 2,
      minIntervalMs: 1_000,
    });
    const startedAt: number[] = [];

    const first = limiter.run(async () => {
      startedAt.push(Date.now());
      return "first";
    });
    const second = limiter.run(async () => {
      startedAt.push(Date.now());
      return "second";
    });

    await expect(first).resolves.toBe("first");
    expect(startedAt).toEqual([0]);

    await vi.advanceTimersByTimeAsync(999);
    expect(startedAt).toEqual([0]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBe("second");
    expect(startedAt).toEqual([0, 1_000]);
  });

  test("rejects when the bounded queue is full", async () => {
    let releaseFirst: (value: string) => void = () => {};
    const limiter = new BrokerApiRateLimiter({
      maxQueueSize: 1,
      minIntervalMs: 1_000,
    });
    const first = limiter.run(() => new Promise<string>(resolve => {
      releaseFirst = resolve;
    }));

    const second = limiter.run(async () => "second");
    await expect(limiter.run(async () => "third")).rejects.toThrow(BrokerApiRateLimitError);

    releaseFirst("first");
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });
});
