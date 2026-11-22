import {describe, expect, test, vi} from "vitest";
import {
  createEmbedSuppressionTracker,
  getMessageContentWithinDiscordLimit,
  getSpoilerSpans,
  isEmbedSuppressedLink,
  isInsideSpoiler,
  messageHasEmbeds,
  messageIsOnlyLinks,
  resolvePosterCredit,
  trimTrailingUrlPunctuation,
  unwrapSpoiler,
  wrapSpoiler,
} from "./discord-link-utils.ts";

describe("trimTrailingUrlPunctuation", () => {
  test.each([
    ["https://example.test/a).", "https://example.test/a"],
    ["https://example.test/a?b=1!?", "https://example.test/a?b=1"],
    ["https://example.test/a", "https://example.test/a"],
    [".,!", ""],
  ])("trims %s", (value, expected) => {
    expect(trimTrailingUrlPunctuation(value)).toBe(expected);
  });
});

describe("isEmbedSuppressedLink", () => {
  test("requires both angle brackets around the link", () => {
    const link = "https://example.test/a";
    expect(isEmbedSuppressedLink(`<${link}>`, 1, link.length)).toBe(true);
    expect(isEmbedSuppressedLink(`<${link}`, 1, link.length)).toBe(false);
    expect(isEmbedSuppressedLink(`${link}>`, 0, link.length)).toBe(false);
  });
});

describe("spoilers", () => {
  test("finds spoiler spans and ignores escaped or code-wrapped delimiters", () => {
    const content = "a ||b|| \\||c|| `||d||` ```||e||``` ||f||";
    const spans = getSpoilerSpans(content);
    const spoilered = spans.map(span => content.slice(span.start, span.end));

    expect(spoilered).toEqual(["||b||", "|| `||d||` ```||e||``` ||"]);
  });

  test("treats an unclosed code span as code to the end", () => {
    expect(getSpoilerSpans("`||a|| ||b||")).toEqual([]);
    expect(getSpoilerSpans("```||a|| ||b||")).toEqual([]);
  });

  test("checks containment and wraps or unwraps links", () => {
    const spans = [{start: 2, end: 10}];
    expect(isInsideSpoiler(spans, 4, 8)).toBe(true);
    expect(isInsideSpoiler(spans, 1, 8)).toBe(false);
    expect(wrapSpoiler("https://example.test")).toBe("||https://example.test||");
    expect(unwrapSpoiler("||https://example.test||")).toBe("https://example.test");
    expect(unwrapSpoiler("|||")).toBe("|||");
    expect(unwrapSpoiler("https://example.test")).toBe("https://example.test");
  });
});

describe("getMessageContentWithinDiscordLimit", () => {
  test("joins links until the next one would exceed the limit", () => {
    expect(getMessageContentWithinDiscordLimit(["aaaa", "bbbb", "cccc"], 9)).toBe("aaaa\nbbbb");
    expect(getMessageContentWithinDiscordLimit(["aaaa"], 3)).toBe("");
    expect(getMessageContentWithinDiscordLimit(["aaaa", "bbbb"])).toBe("aaaa\nbbbb");
  });
});

describe("messageIsOnlyLinks", () => {
  const isExampleLink = (url: string) => url.startsWith("https://example.test/");

  test.each([
    ["https://example.test/a", true],
    [" (https://example.test/a), ||https://example.test/b||\n", true],
    ["see https://example.test/a", false],
    ["https://other.test/a", false],
    ["<https://example.test/a>", false],
    ["no links", false],
  ])("classifies %j as %s", (content, expected) => {
    expect(messageIsOnlyLinks(content, isExampleLink)).toBe(expected);
  });
});

describe("resolvePosterCredit", () => {
  test("mentions the author or falls back to a neutral label", () => {
    expect(resolvePosterCredit({id: "123"})).toBe("<@123>");
    expect(resolvePosterCredit({id: ""})).toBe("someone");
    expect(resolvePosterCredit({})).toBe("someone");
    expect(resolvePosterCredit(undefined)).toBe("someone");
  });
});

describe("messageHasEmbeds", () => {
  test("requires a non-empty embed array", () => {
    expect(messageHasEmbeds({embeds: [{}]})).toBe(true);
    expect(messageHasEmbeds({embeds: []})).toBe(false);
    expect(messageHasEmbeds({embeds: null})).toBe(false);
    expect(messageHasEmbeds({})).toBe(false);
  });
});

describe("createEmbedSuppressionTracker", () => {
  test("tracks ids until stopped or expired, restarting the wait on re-track", () => {
    vi.useFakeTimers();
    try {
      const tracker = createEmbedSuppressionTracker(100);
      tracker.track("a");
      tracker.track("b");
      expect(tracker.has("a")).toBe(true);

      tracker.stop("a");
      tracker.stop("missing");
      expect(tracker.has("a")).toBe(false);

      vi.advanceTimersByTime(60);
      tracker.track("b");
      vi.advanceTimersByTime(60);
      expect(tracker.has("b")).toBe(true);

      vi.advanceTimersByTime(40);
      expect(tracker.has("b")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
