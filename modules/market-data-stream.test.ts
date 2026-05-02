import {describe, expect, test} from "vitest";
import {
  getPayloadLogPreview,
  isPotentialMarketDataPayload,
  normalizeEventData,
  parseStreamEvent,
} from "./market-data-stream.ts";

describe("market-data-stream", () => {
  test("normalizes websocket message data shapes", () => {
    expect(normalizeEventData("payload")).toBe("payload");
    expect(normalizeEventData(Buffer.from("buffered"))).toBe("buffered");
    expect(normalizeEventData(new TextEncoder().encode("array-buffer").buffer)).toBe("array-buffer");
    expect(normalizeEventData({data: "nope"})).toBeNull();
  });

  test("parses direct, framed, nested and delimited market stream payloads", () => {
    expect(parseStreamEvent(JSON.stringify({
      pid: "123",
      last_numeric: "1,234.50",
      pc: "+5.5",
      pcp: "1.25%",
    }))).toEqual({
      pid: 123,
      lastNumeric: 1234.5,
      priceChange: 5.5,
      percentageChange: 1.25,
    });

    const framed = `a[${JSON.stringify(JSON.stringify({
      message: JSON.stringify({
        pid: 456,
        last_numeric: 99.5,
        pc: -1.2,
        pcp: -0.5,
      }),
    }))}]`;
    expect(parseStreamEvent(framed)).toEqual({
      pid: 456,
      lastNumeric: 99.5,
      priceChange: -1.2,
      percentageChange: -0.5,
    });

    expect(parseStreamEvent(`prefix::${JSON.stringify({
      pid: 789,
      last_numeric: 10,
      pc: 0.1,
      pcp: 0.2,
    })}`)?.pid).toBe(789);
    expect(parseStreamEvent(`noise ${JSON.stringify({
      pid: 321,
      last_numeric: 10,
      pc: 0,
      pcp: 0,
    })} tail`)?.pid).toBe(321);
  });

  test("rejects malformed or incomplete market stream payloads", () => {
    expect(parseStreamEvent("")).toBeNull();
    expect(parseStreamEvent("a[not-json")).toBeNull();
    expect(parseStreamEvent(JSON.stringify({
      pid: 123,
      last_numeric: "missing other fields",
    }))).toBeNull();
    expect(parseStreamEvent(JSON.stringify({
      pid: Number.POSITIVE_INFINITY,
      last_numeric: 1,
      pc: 1,
      pcp: 1,
    }))).toBeNull();
  });

  test("detects likely payloads and truncates log previews", () => {
    expect(isPotentialMarketDataPayload("pid-123::payload")).toBe(true);
    expect(isPotentialMarketDataPayload("last_numeric")).toBe(true);
    expect(isPotentialMarketDataPayload("{\"pid\":123}")).toBe(true);
    expect(isPotentialMarketDataPayload("{\\\"pid\\\":123}")).toBe(true);
    expect(isPotentialMarketDataPayload("heartbeat")).toBe(false);

    expect(getPayloadLogPreview("  one\n two\tthree  ")).toBe("one two three");
    expect(getPayloadLogPreview("x".repeat(501))).toBe(`${"x".repeat(500)}...`);
  });
});
