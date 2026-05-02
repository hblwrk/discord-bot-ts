import {describe, expect, test} from "vitest";
import {
  getDiscordRateLimitRetryAfterMs,
  getDiscordRetryAfterHeaderMs,
  toDiscordRetryAfterFieldMs,
  toDiscordRetryAfterHeaderMs,
  toDiscordTimerMs,
} from "./discord-retry-after.ts";

describe("discord-retry-after", () => {
  test("normalizes millisecond and retry-after-second fields", () => {
    expect(toDiscordTimerMs(12.1)).toBe(13);
    expect(toDiscordTimerMs(" 12.1 ")).toBe(13);
    expect(toDiscordTimerMs(0)).toBeUndefined();
    expect(toDiscordTimerMs("")).toBeUndefined();
    expect(toDiscordTimerMs("nope")).toBeUndefined();

    expect(toDiscordRetryAfterFieldMs(1.2)).toBe(1200);
    expect(toDiscordRetryAfterFieldMs("1.2")).toBe(1200);
    expect(toDiscordRetryAfterFieldMs(-1)).toBeUndefined();
  });

  test("normalizes retry-after headers from seconds and dates", () => {
    const now = Date.parse("2026-05-01T12:00:00.000Z");

    expect(toDiscordRetryAfterHeaderMs(["2.4"], now)).toBe(2400);
    expect(toDiscordRetryAfterHeaderMs(3, now)).toBe(3000);
    expect(toDiscordRetryAfterHeaderMs("Fri, 01 May 2026 12:00:05 GMT", now)).toBe(5000);
    expect(toDiscordRetryAfterHeaderMs("Fri, 01 May 2026 11:59:59 GMT", now)).toBeUndefined();
    expect(toDiscordRetryAfterHeaderMs("not a date", now)).toBeUndefined();
    expect(toDiscordRetryAfterHeaderMs([], now)).toBeUndefined();
  });

  test("reads retry-after headers from fetch-like and plain header bags", () => {
    const now = Date.parse("2026-05-01T12:00:00.000Z");
    const fetchHeaders = {
      get: (headerName: string) => "retry-after" === headerName ? "1.5" : undefined,
    };

    expect(getDiscordRetryAfterHeaderMs(fetchHeaders, now)).toBe(1500);
    expect(getDiscordRetryAfterHeaderMs({"Retry-After": "2"}, now)).toBe(2000);
    expect(getDiscordRetryAfterHeaderMs({"retry-after": 3}, now)).toBe(3000);
    expect(getDiscordRetryAfterHeaderMs(null, now)).toBeUndefined();
    expect(getDiscordRetryAfterHeaderMs({"retry-after": ""}, now)).toBeUndefined();
  });

  test("uses the largest retry value from known Discord error shapes", () => {
    const now = Date.parse("2026-05-01T12:00:00.000Z");
    const error = Object.assign(new Error("limited"), {
      retryAfterMs: 100,
      retryAfter: 200,
      sublimitTimeout: 300,
      timeToReset: 400,
      retry_after: 0.5,
      rawError: {
        retryAfter: 600,
        retry_after: 0.7,
      },
      headers: {
        "retry-after": "0.8",
      },
      response: {
        headers: {
          "retry-after": "0.9",
        },
      },
    });

    expect(getDiscordRateLimitRetryAfterMs(error, now)).toBe(900);
    expect(getDiscordRateLimitRetryAfterMs("not-error", now)).toBeUndefined();
    expect(getDiscordRateLimitRetryAfterMs(new Error("plain"), now)).toBeUndefined();
  });
});
