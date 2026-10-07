import {describe, expect, test} from "vitest";
import {appendTwitterBadgeText, type TwitterBadge} from "./twitter-badge-text.ts";

const link = "From <@123>: https://fxtwitter.com/example/status/123";
const legend = "-# Wording score ≠ truth · Media/bots unverified.";
const checkField = {name: "AI web cross-check: contradicted", value: "[Source](https://www.reuters.com/world/article)"};
const checkText = "**AI: contradicted** · [source](<https://www.reuters.com/world/article>)";

describe("appendTwitterBadgeText", () => {
  test("adds a compact score and reality check while preserving credit and links", () => {
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🟡 50% Spiciness (Caution)",
      description: "Verify the original evidence before sharing.",
      fields: [checkField, {name: "Signals", value: "caps"}, {name: "Context", value: "1 video"}],
    }}], false)).toBe(`${link}\n-# 🟡 50% wording spice · ${checkText}\n-# Verify the original evidence before sharing.\n${legend}`);
  });

  test("retains AI attribution and full citation without adding source previews", () => {
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🟡 50% Spiciness (Caution)", description: "An attributed reality check.",
      fields: [{name: "AI web cross-check: disputed", value: "[Source](https://www.reuters.com/world/article)"}],
    }}], false)).toBe(`${link}\n-# 🟡 50% wording spice · **AI: disputed** · [source](<https://www.reuters.com/world/article>)\n-# An attributed reality check.\n${legend}`);
  });

  test("retains the note excerpt, attribution, evidence links and rating disclaimer", () => {
    const value = "A note excerpt.\n[Post](https://x.com/example/status/123) · [Source](https://example.org/article)\nRating status and cited evidence are unverified.";
    const text = appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🟢 10% Spiciness — Low sensationalism", description: "Reporting contradicts this claim.",
      fields: [checkField, {name: "Community Note via FxTwitter (excerpt)", value}],
    }}], false);
    expect(text).toBe(`${link}\n-# 🟢 10% wording spice · ${checkText}\n-# Reporting contradicts this claim.\n-# **Community Note via FxTwitter (excerpt)**\n-# A note excerpt.\n-# [Post](<https://x.com/example/status/123>) · [Source](<https://example.org/article>)\n-# Rating status and cited evidence are unverified.\n${legend}`);
  });

  test("uses original link positions and shares one wording legend", () => {
    const badges: TwitterBadge[] = [1, 3].map(linkNumber => ({linkNumber, embed: {title: "🟡 50% Spiciness — Caution", fields: [checkField]}}));
    expect(appendTwitterBadgeText(link, badges, true)).toBe(`${link}\n-# Link 1: 🟡 50% wording spice · ${checkText}\n-# Link 3: 🟡 50% wording spice · ${checkText}\n${legend}`);
  });

  test("displays a contradicted verdict independently of a low wording score", () => {
    const text = appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🟢 10% Spiciness — Low sensationalism",
      description: "Reporting contradicts this claim.", fields: [checkField],
    }}], false);
    expect(text).toBe(`${link}\n-# 🟢 10% wording spice · ${checkText}\n-# Reporting contradicts this claim.\n${legend}`);
    expect(text).not.toContain("skipped");
  });

  test("keeps the proxy post reference alongside the completed low-score AI check", () => {
    const text = appendTwitterBadgeText("", [{linkNumber: 1, embed: {
      title: "🟢 20% Spiciness — Low sensationalism",
      description: "Reporting contradicts this claim.\nPost: <https://fixvx.com/a/status/123>", fields: [checkField],
    }}], false);
    expect(text).toBe(`-# 🟢 20% wording spice · ${checkText}\n-# Reporting contradicts this claim.\n-# Post: <https://fixvx.com/a/status/123>\n${legend}`);
  });

  test.each([10, 50, 95])("omits scored badges without a completed AI check at %s%%, including notes alone", score => {
    for (const fields of [[], [{name: "Community Note via FxTwitter", value: "A note excerpt."}]]) {
      expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
        title: `🟢 ${score}% Spiciness — Low sensationalism`, description: "A claim without an AI verdict.", fields,
      }}], false)).toBe(link);
    }
  });

  test("omits untitled and empty assessments", () => {
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {description: "orphaned text"}}], false)).toBe(link);
    expect(appendTwitterBadgeText(link, [], false)).toBe(link);
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {title: "Unavailable", description: ""}}], false)).toBe(`${link}\n-# Unavailable`);
  });

  test("fits the exact message limit and omits an assessment one character over it", () => {
    const badge = {linkNumber: 1, embed: {title: "🟢 10% Spiciness — Low sensationalism", fields: [checkField]}};
    const suffix = appendTwitterBadgeText("", [badge], false);
    const base = "x".repeat(2_000 - suffix.length - 1);
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
    expect(appendTwitterBadgeText(link, badges, true)).toBe(`${link}\n-# Link 1: First\n-# Link 3: Third`);
  });
});
