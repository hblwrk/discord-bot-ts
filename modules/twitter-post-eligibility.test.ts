import {describe, expect, test} from "vitest";
import {isClearlyNonFactualTeaser} from "./twitter-post-eligibility.ts";
import type {TwitterPostContext} from "./twitter-sanity-score.ts";

function post(text: string, additions: Partial<TwitterPostContext> = {}): TwitterPostContext {
  return {text, quotedText: "", media: [], externalLinks: [], authorJoined: "", defaultAvatar: false,
    authorWebsite: "", ...additions};
}

describe("clearly nonfactual Twitter teasers", () => {
  test.each([
    "The turn of a key.\n\nMission S world premiere. 15 October at 10:30 PM CEST.",
    "Coming soon.",
    "Something big is coming. Stay tuned.",
    "This is just a teaser. Stay tuned.",
    "Stay tuned. We will reveal more soon.",
    "Just announced: Mission S world premiere. 15 October at 10:30 PM CEST.",
  ])("skips a promotional fragment without a checkable claim: %s", text => {
    expect(isClearlyNonFactualTeaser(post(text, {media: ["1 Photo(s); content not inspected"]}))).toBe(true);
  });

  test.each([
    "The council approved the plan yesterday.",
    "Mission S has 500 hp. World premiere 15 October.",
    "Mission S is electric. World premiere 15 October.",
    "World premiere delayed until November.",
    "World premiere sales fell 80% last quarter.",
    "World premiere: 500 cars.",
    "Premiere tickets cost €500.",
  ])("keeps a factual claim eligible: %s", text => {
    expect(isClearlyNonFactualTeaser(post(text))).toBe(false);
  });

  test("keeps quoted claims, linked context and Community Notes eligible", () => {
    const text = "Mission S world premiere. 15 October at 10:30 PM CEST.";
    expect(isClearlyNonFactualTeaser(post(text, {quotedText: "The new model has 500 hp."}))).toBe(false);
    expect(isClearlyNonFactualTeaser(post(text, {externalLinks: ["https://example.org/details"]}))).toBe(false);
    expect(isClearlyNonFactualTeaser(post(text, {communityNote: {text: "Relevant context", sourceUrls: []}}))).toBe(false);
  });
});
