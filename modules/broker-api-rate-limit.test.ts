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

  test("keeps one pending delay timer and clears it when work can start", async () => {
    let now = 0;
    const clearTimeoutMock = vi.fn();
    const timers: {callback: () => void; timer: ReturnType<typeof setTimeout>}[] = [];
    const limiter = new BrokerApiRateLimiter({
      clearTimeout: clearTimeoutMock,
      maxQueueSize: 4,
      minIntervalMs: 100,
      now: () => now,
      setTimeout: callback => {
        const timer = Symbol("timer") as unknown as ReturnType<typeof setTimeout>;
        timers.push({callback, timer});
        return timer;
      },
    });
    const started: string[] = [];

    await expect(limiter.run(async () => {
      started.push("first");
      return "first";
    })).resolves.toBe("first");

    now = 50;
    const second = limiter.run(async () => {
      started.push("second");
      return "second";
    });
    expect(timers).toHaveLength(1);

    now = 60;
    const third = limiter.run(async () => {
      started.push("third");
      return "third";
    });
    expect(timers).toHaveLength(1);

    now = 100;
    const fourth = limiter.run(async () => {
      started.push("fourth");
      return "fourth";
    });

    expect(clearTimeoutMock).toHaveBeenCalledWith(timers[0]?.timer);
    await expect(second).resolves.toBe("second");

    now = 200;
    timers[1]?.callback();
    await expect(third).resolves.toBe("third");

    now = 300;
    timers[2]?.callback();
    await expect(fourth).resolves.toBe("fourth");
    expect(started).toEqual(["first", "second", "third", "fourth"]);
  });
});
