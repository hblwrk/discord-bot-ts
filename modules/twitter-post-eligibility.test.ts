import {describe, expect, test, vi} from "vitest";
import type {callAiProviderJson} from "./ai-provider.ts";
import {classifyTwitterPostForReview, isClearlyNonFactualTeaser} from "./twitter-post-eligibility.ts";
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

describe("Twitter review allow-list", () => {
  test.each(["news", "financial", "research_statistic", "none"] as const)(
    "accepts the structured %s category without web search", async category => {
      const call = vi.fn<typeof callAiProviderJson>().mockResolvedValue(JSON.stringify({category}));
      const logger = {log: vi.fn()};
      expect(await classifyTwitterPostForReview(post("A concrete post."), {logger}, call)).toBe(category);
      expect(call).toHaveBeenCalledWith(expect.stringContaining("study, survey, public statistic"),
        expect.objectContaining({properties: {category: expect.objectContaining({enum: expect.arrayContaining(["none", "research_statistic"])})}}),
        {logger}, "Twitter/X review gate", undefined,
        {profile: "routine", timeoutMs: 15_000});
      expect(call.mock.calls[0]?.[0]).toContain("puns, jokes");
    },
  );

  test("includes a quoted claim and rejects missing or invalid classifications", async () => {
    const call = vi.fn<typeof callAiProviderJson>().mockResolvedValueOnce(JSON.stringify({category: "research_statistic"}))
      .mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify({category: "maybe"}));
    const logger = {log: vi.fn()};
    const claim = post("See this", {quotedText: "A new study found a 40% reduction in symptoms."});
    expect(await classifyTwitterPostForReview(claim, {logger}, call)).toBe("research_statistic");
    expect(call.mock.calls[0]?.[0]).toContain(claim.quotedText);
    expect(await classifyTwitterPostForReview(claim, {logger}, call)).toBeUndefined();
    expect(await classifyTwitterPostForReview(claim, {logger}, call)).toBeUndefined();
  });
});
