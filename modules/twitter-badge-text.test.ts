import {describe, expect, test} from "vitest";
import {appendTwitterBadgeText, type TwitterBadge} from "./twitter-badge-text.ts";

const link = "From <@123>: https://fxtwitter.com/example/status/123";
const checkField = {name: "AI web cross-check: contradicted", value: "[Source](https://example.org/report)"};

describe("appendTwitterBadgeText", () => {
  test("shows a short combined status and one source", () => {
    const text = appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🟢 10% Spiciness — Supported claim, low spice, credible source",
      description: "The council approved the plan.",
      fields: [
        {name: "AI web cross-check: supported (review sources)", value: "[Source 1](https://example.org/report) · [Source 2](https://example.com/other)"},
        {name: "Source credibility: credible (@example)", value: "[Evidence](https://example.org/about)"},
        {name: "Community Note via FxTwitter", value: "A note excerpt."},
      ],
    }}], false);
    expect(text).toBe(`${link}\n-# 🟢 Supported claim [source](<https://example.org/report>)`);
  });

  test("omits wording score and long explanation for a caution", () => {
    const text = appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🟡 50% Spiciness (Caution)",
      description: "Verify the original evidence before sharing.",
      fields: [checkField],
    }}], false);
    expect(text).toBe(`${link}\n-# 🟡 Caution [source](<https://example.org/report>)`);
  });

  test("shows a red contradiction with just one factual source link", () => {
    const text = appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🔴 10% Spiciness — Claim contradicted",
      fields: [{name: "AI web cross-check: contradicted (review sources)",
        value: "[Source 1](https://reuters.com/world/report) · [Source 2](https://apnews.com/article/report)"}],
    }}], false);
    expect(text).toBe(`${link}\n-# 🔴 Claim contradicted [source](<https://reuters.com/world/report>)`);
  });

  test("shows a useful label when a check has no usable source link", () => {
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🟡 50% Spiciness (Caution)", fields: [{name: "AI web cross-check: disputed", value: "Source unavailable"}],
    }}], false)).toBe(`${link}\n-# 🟡 Caution`);
  });

  test.each([
    ["Claim contradicted", "Claim contradicted"],
    ["Source credibility concerns", "Source credibility concerns"],
    ["Wording caution", "Wording caution"],
    ["Fact check pending", "Checking claim"],
    ["Fact check unverified", "Claim unverified"],
    ["Source check pending", "Checking source credibility"],
    ["Account caution", "Account caution"],
  ])("explains a yellow %s assessment briefly", (reason, expected) => {
    expect(appendTwitterBadgeText("", [{linkNumber: 1, embed: {
      title: `🟡 10% Spiciness — ${reason}`, fields: [{name: "AI web cross-check: unverified", value: "No source"}],
    }}], false)).toBe(`-# 🟡 ${expected}`);
  });

  test("uses original link positions for multiple badges", () => {
    const badges: TwitterBadge[] = [1, 3].map(linkNumber => ({linkNumber, embed: {title: "🟡 50% Spiciness — Caution", fields: [checkField]}}));
    expect(appendTwitterBadgeText(link, badges, true)).toBe(`${link}\n-# Link 1: 🟡 Caution [source](<https://example.org/report>)\n-# Link 3: 🟡 Caution [source](<https://example.org/report>)`);
  });

  test("omits scored badges without a completed AI check", () => {
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {
      title: "🟢 10% Spiciness — Low sensationalism", fields: [{name: "Community Note via FxTwitter", value: "A note excerpt."}],
    }}], false)).toBe(link);
  });

  test("omits untitled and empty assessments", () => {
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {description: "orphaned text"}}], false)).toBe(link);
    expect(appendTwitterBadgeText(link, [], false)).toBe(link);
    expect(appendTwitterBadgeText(link, [{linkNumber: 1, embed: {title: "Unavailable", description: ""}}], false)).toBe(`${link}\n-# Unavailable`);
  });

  test("fits the exact message limit and omits a badge one character over it", () => {
    const badge = {linkNumber: 1, embed: {title: "🟢 10% Spiciness — Low sensationalism", fields: [checkField]}};
    const suffix = appendTwitterBadgeText("", [badge], false);
    const base = "x".repeat(2_000 - suffix.length - 1);
    expect(appendTwitterBadgeText(base, [badge], false).length).toBe(2_000);
    expect(appendTwitterBadgeText(`${base}x`, [badge], false)).toBe(`${base}x`);
  });

  test("omits an indicator when its source link does not fit", () => {
    const base = "x".repeat(1_850);
    expect(appendTwitterBadgeText(base, [{linkNumber: 1, embed: {
      title: "🟡 50% Spiciness (Caution)",
      fields: [{name: "AI web cross-check: disputed", value: `[Source](https://example.org/${"a".repeat(150)})`}],
    }}], false)).toBe(base);
  });

  test("keeps earlier badges when a later badge overflows", () => {
    const badges = [
      {linkNumber: 1, embed: {title: "First"}},
      {linkNumber: 2, embed: {title: "🟡 50% Spiciness — Caution", fields: [
        {name: "AI web cross-check: supported", value: `[Source](https://example.org/${"a".repeat(2_000)})`},
      ]}},
      {linkNumber: 3, embed: {title: "Third"}},
    ];
    expect(appendTwitterBadgeText(link, badges, true)).toBe(`${link}\n-# Link 1: First\n-# Link 3: Third`);
  });
});
