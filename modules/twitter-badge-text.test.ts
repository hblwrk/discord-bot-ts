import {describe, expect, test} from "vitest";
import {appendTwitterBadgeText, type TwitterBadge} from "./twitter-badge-text.ts";

const link = "From <@123>: https://fxtwitter.com/example/status/123";
const legend = "Wording index, not a truth probability; media and bot activity unverified.";

describe("appendTwitterBadgeText", () => {
  test("adds a compact score and reality check while preserving credit and links", () => {
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🟡 50% Spiciness (Caution)",
      description: "Verify the original evidence before sharing.",
      fields: [{name: "Signals", value: "caps"}, {name: "Context", value: "1 video"}],
    }}], false)).toBe(`${link}\n\n🟡 50% Spiciness (Caution)\nVerify the original evidence before sharing.\n\n${legend}`);
  });

  test("retains AI attribution and full citation without adding source previews", () => {
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🟡 50% Spiciness (Caution)", description: "An attributed reality check.",
      fields: [{name: "AI web cross-check: disputed", value: "[Source](https://www.reuters.com/world/article)"}],
    }}], false)).toBe(`${link}\n\n🟡 50% Spiciness (Caution)\nAn attributed reality check.\nAI web cross-check: disputed\nSource: <https://www.reuters.com/world/article>\n\n${legend}`);
  });

  test("retains the note excerpt, attribution, evidence links and rating disclaimer", () => {
    const value = "A note excerpt.\n[Post](https://x.com/example/status/123) · [Source](https://example.org/article)\nRating status and cited evidence are unverified.";
    const text = appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🟢 10% Spiciness (Likely Fine)", description: "A Community Note adds context.",
      fields: [{name: "Community Note via FxTwitter (excerpt)", value}],
    }}], false);
    expect(text).toBe(`${link}\n\n🟢 10% Spiciness (Likely Fine)\nA Community Note adds context.\nCommunity Note via FxTwitter (excerpt)\nA note excerpt.\nPost: <https://x.com/example/status/123> · Source: <https://example.org/article>\nRating status and cited evidence are unverified.\n\n${legend}`);
  });

  test("uses original link positions and shares one wording legend", () => {
    const badges: TwitterBadge[] = [1, 3].map(linkNumber => ({linkNumber, embed: {title: "🟢 10% Spiciness (Likely Fine)"}}));
    expect(appendTwitterBadgeText(link, badges, true)).toBe(`${link}\n\nLink 1: 🟢 10% Spiciness (Likely Fine)\n\nLink 3: 🟢 10% Spiciness (Likely Fine)\n\n${legend}`);
  });

  test("omits untitled and empty assessments", () => {
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {description: "orphaned text"}}], false)).toBe(link);
    expect(appendTwitterBadgeText(link, [], false)).toBe(link);
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {title: "Unavailable", description: ""}}], false)).toBe(`${link}\n\nUnavailable`);
  });

  test("fits the exact message limit and omits an assessment one character over it", () => {
    const badge = {linkNumber: 1, embed: {title: "🟢 10% Spiciness (Likely Fine)"}};
    const suffix = appendTwitterBadgeText("", [badge], false);
    const base = "x".repeat(2_000 - suffix.length);
    expect(appendTwitterBadgeText(base, [badge], false).length).toBe(2_000);
    expect(appendTwitterBadgeText(`${base}x`, [badge], false)).toBe(`${base}x`);
  });

  test("omits the whole AI claim if its complete citation and disclaimer cannot fit", () => {
    const base = "x".repeat(1_850);
    expect(appendTwitterBadgeText(base, [{linkNumber: 1, embed: {
      title: "🟡 50% Spiciness (Caution)", description: "A factual claim.",
      fields: [{name: "AI web cross-check: disputed", value: `[Source](https://www.reuters.com/${"a".repeat(150)})`}],
    }}], false)).toBe(base);
  });

  test("keeps earlier badges when later evidence overflows and allows subsequent small badges", () => {
    const badges = [
      {linkNumber: 1, embed: {title: "First"}},
      {linkNumber: 2, embed: {title: "Second", fields: [{name: "Community Note via FxTwitter", value: "x".repeat(2_000)}]}},
      {linkNumber: 3, embed: {title: "Third"}},
    ];
    expect(appendTwitterBadgeText(link, badges, true)).toBe(`${link}\n\nLink 1: First\n\nLink 3: Third`);
  });
});
