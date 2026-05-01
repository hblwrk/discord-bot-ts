import {describe, expect, test} from "vitest";
import {BoundedTtlCache} from "./bounded-ttl-cache.ts";

describe("BoundedTtlCache", () => {
  test("expires entries and evicts the least recently used entry", () => {
    let now = 1_000;
    const cache = new BoundedTtlCache<string>({
      maxEntries: 2,
      now: () => now,
      ttlMs: 500,
    });

    cache.set("first", "one");
    cache.set("second", "two");
    expect(cache.get("first")).toBe("one");

    cache.set("third", "three");
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe("one");
    expect(cache.get("third")).toBe("three");

    now = 1_501;
    expect(cache.get("first")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("updates an existing entry without increasing cache size", () => {
    const cache = new BoundedTtlCache<string>({
      maxEntries: 2,
      ttlMs: 1_000,
    });

    cache.set("key", "first");
    cache.set("key", "second");

    expect(cache.get("key")).toBe("second");
    expect(cache.size).toBe(1);
  });

  test("does not store entries when disabled by size or ttl", () => {
    const zeroSizeCache = new BoundedTtlCache<string>({
      maxEntries: 0,
      ttlMs: 1_000,
    });
    const zeroTtlCache = new BoundedTtlCache<string>({
      maxEntries: 1,
      ttlMs: 0,
    });

    zeroSizeCache.set("key", "value");
    zeroTtlCache.set("key", "value");

    expect(zeroSizeCache.get("key")).toBeUndefined();
    expect(zeroTtlCache.get("key")).toBeUndefined();
  });
});
