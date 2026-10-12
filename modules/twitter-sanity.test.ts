import {describe, expect, test, vi} from "vitest";
import type {callAiProviderJson} from "./ai-provider.ts";
import {createTwitterIntrospector, parseTwitterPost} from "./twitter-sanity.ts";
import {researchTwitterSource} from "./twitter-source-credibility.ts";
import {appendTwitterBadgeText} from "./twitter-badge-text.ts";

function payload(text = "A cat enjoys a sunny afternoon.", id = "123") {
  return {code: 200, status: {id, text}};
}

function dependencies(data: unknown = payload()) {
  return {
    logger: {log: vi.fn()},
    aiAvailableFn: vi.fn(() => true),
    getWithRetryFn: vi.fn().mockResolvedValue({data}),
    crossCheckFn: vi.fn().mockResolvedValue({verdict: "supported", sentence: "Reporting supports this specific claim.", sources: ["https://reuters.com/world/report"]}),
    credibilityFn: vi.fn().mockResolvedValue({target: "posting account", label: "@example", verdict: "credible",
      source: "https://example.org/about"}),
    nowMs: () => Date.parse("2026-10-07T12:00:00Z"),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return {promise, resolve};
}

describe("Twitter metadata and badge service", () => {
  test("publishes no badge or AI requests for the Porsche premiere teaser", async () => {
    const teaser = "The turn of a key.\n\nMission S world premiere. 15 October at 10:30 PM CEST.";
    const deps = dependencies({status: {id: "123", text: teaser, author: {screen_name: "PorscheNewsroom"},
      media: {photos: [{}]}}});
    const updates = vi.fn();
    const inspect = createTwitterIntrospector(deps);
    const badge = await inspect.observe!("https://fixupx.com/PorscheNewsroom/status/123", updates);
    expect(badge).toBeUndefined();
    expect(await inspect("https://x.com/PorscheNewsroom/status/123")).toBeUndefined();
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(1);
    expect(updates).not.toHaveBeenCalled();
    expect(deps.aiAvailableFn).not.toHaveBeenCalled();
    expect(deps.crossCheckFn).not.toHaveBeenCalled();
    expect(deps.credibilityFn).not.toHaveBeenCalled();
  });

  test("keeps a measurable claim in an announcement eligible for all checks", async () => {
    const deps = dependencies(payload("Mission S has 500 hp. World premiere 15 October."));
    const badge = await createTwitterIntrospector(deps)("https://fixupx.com/PorscheNewsroom/status/123");
    expect(badge).toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
    expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
    expect(deps.credibilityFn).toHaveBeenCalledTimes(1);
  });

  test("starts fact and source checks together, then publishes only changed trust verdicts", async () => {
    const deps = dependencies(payload("The council approved the plan yesterday."));
    const fact = deferred<Awaited<ReturnType<typeof deps.crossCheckFn>>>();
    const source = deferred<Awaited<ReturnType<typeof deps.credibilityFn>>>();
    deps.crossCheckFn.mockReturnValue(fact.promise);
    deps.credibilityFn.mockReturnValue(source.promise);
    const inspect = createTwitterIntrospector(deps);
    const updates = vi.fn();
    const result = inspect.observe!("https://fixvx.com/a/status/123", updates);
    await vi.waitFor(() => {
      expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
      expect(deps.credibilityFn).toHaveBeenCalledTimes(1);
    });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls[0]?.[0]).toMatchObject({title: "🔎 Checking"});
    fact.resolve({verdict: "supported", sentence: "Reporting supports this specific claim.", sources: ["https://reuters.com/world/report"]});
    await vi.waitFor(() => { expect(updates).toHaveBeenCalledTimes(2); });
    expect(updates.mock.calls[1]?.[0]).toMatchObject({title: "🟡 10% Spiciness — Source check pending"});
    source.resolve({target: "posting account", label: "@example", verdict: "credible", source: "https://example.org/about"});
    expect(await result).toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
    expect(updates).toHaveBeenCalledTimes(3);
    expect(updates.mock.calls[2]?.[0]).toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
  });

  test("publishes one final verdict when source research finishes before the fact check", async () => {
    const deps = dependencies();
    const fact = deferred<Awaited<ReturnType<typeof deps.crossCheckFn>>>();
    deps.crossCheckFn.mockReturnValue(fact.promise);
    const inspect = createTwitterIntrospector(deps);
    const updates = vi.fn();
    const result = inspect.observe!("https://fixvx.com/a/status/123", updates);
    await vi.waitFor(() => { expect(deps.credibilityFn).toHaveBeenCalledTimes(1); });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls[0]?.[0]).toMatchObject({title: "🔎 Checking"});
    fact.resolve({verdict: "supported", sentence: "Reporting supports this specific claim.", sources: ["https://reuters.com/world/report"]});
    expect(await result).toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
    expect(updates).toHaveBeenCalledTimes(2);
  });

  test("publishes red when independent contradiction evidence arrives and ignores later credibility support", async () => {
    const deps = dependencies();
    const fact = deferred<Awaited<ReturnType<typeof deps.crossCheckFn>>>();
    const source = deferred<Awaited<ReturnType<typeof deps.credibilityFn>>>();
    deps.crossCheckFn.mockReturnValue(fact.promise);
    deps.credibilityFn.mockReturnValue(source.promise);
    const updates = vi.fn();
    const result = createTwitterIntrospector(deps).observe!("https://fixvx.com/a/status/123", updates);
    await vi.waitFor(() => {
      expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
      expect(deps.credibilityFn).toHaveBeenCalledTimes(1);
    });
    expect(updates).toHaveBeenCalledTimes(1);
    fact.resolve({verdict: "contradicted", sentence: "The records directly refute the claim.",
      sources: ["https://reuters.com/world/report", "https://apnews.com/article/report"]});
    await vi.waitFor(() => { expect(updates).toHaveBeenCalledTimes(2); });
    expect(updates.mock.calls[1]?.[0]).toMatchObject({title: "🔴 10% Spiciness — Claim contradicted", color: 0xe74c3c});
    source.resolve({target: "linked source", label: "example.org", verdict: "credible", source: "https://example.org/about"});
    const badge = await result;
    expect(badge?.title).toBe("🔴 10% Spiciness — Claim contradicted");
    expect(updates).toHaveBeenCalledTimes(2);
    if (undefined === badge) throw new Error("Expected a contradiction badge");
    expect(appendTwitterBadgeText("", [{linkNumber: 1, embed: badge}], false))
      .toBe("-# 🔴 Claim contradicted — The records directly refute the claim. [source](<https://reuters.com/world/report>)");
  });

  test("a documented contradiction overrides a matching company source", async () => {
    const deps = dependencies({status: {id: "123", text: "Airtable announced layoffs and shipped 30 improvements.",
      author: {screen_name: "Airtable"}}});
    const primaryStatementFn = vi.fn().mockResolvedValue({organization: "Airtable",
      source: "https://www.airtable.com/newsroom/back-to-bases"});
    deps.crossCheckFn.mockResolvedValue({verdict: "contradicted", sentence: "The records refute the claim.",
      sources: ["https://reuters.com/world/report", "https://apnews.com/article/report"]});
    const badge = await createTwitterIntrospector({...deps, primaryStatementFn})("https://fixvx.com/Airtable/status/123");
    expect(primaryStatementFn).toHaveBeenCalledTimes(1);
    expect(badge?.title).toBe("🔴 10% Spiciness — Claim contradicted");
  });

  test("publishes an issuer statement before a slow fact check, then honors a contradiction", async () => {
    const deps = dependencies(payload("Airtable layoffs affect a large part of its team."));
    const fact = deferred<Awaited<ReturnType<typeof deps.crossCheckFn>>>();
    deps.crossCheckFn.mockReturnValue(fact.promise);
    const primaryStatementFn = vi.fn().mockResolvedValue({organization: "Airtable",
      source: "https://www.airtable.com/newsroom/back-to-bases"});
    const updates = vi.fn();
    const result = createTwitterIntrospector({...deps, primaryStatementFn}).observe!("https://fixvx.com/trader/status/123", updates);
    await vi.waitFor(() => { expect(updates.mock.lastCall?.[0]?.title).toBe("ℹ️ Company statement"); });
    fact.resolve({verdict: "contradicted", sentence: "The filing lists no layoffs.",
      sources: ["https://reuters.com/world/report", "https://apnews.com/article/report"]});
    expect((await result)?.title).toBe("🔴 10% Spiciness — Claim contradicted");
    expect(updates.mock.lastCall?.[0]?.title).toBe("🔴 10% Spiciness — Claim contradicted");
  });

  test("shows one public finance report as attributed rather than verified", async () => {
    const deps = dependencies(payload("Airtable layoffs affect a large part of its team."));
    const primaryStatementFn = vi.fn().mockResolvedValue(undefined);
    const source = "https://bloomberg.com/news/articles/airtable-layoffs";
    deps.crossCheckFn.mockResolvedValue({verdict: "supported", sentence: "A report describes the same layoffs.", sources: [source]});
    const badge = await createTwitterIntrospector({...deps, primaryStatementFn, primaryRetryDelayMs: 60_000})("https://fixvx.com/trader/status/123");
    expect(primaryStatementFn).toHaveBeenCalledTimes(1);
    expect(badge?.title).toBe("ℹ️ Reported claim");
    if (undefined === badge) throw new Error("Expected a reported-claim badge");
    expect(appendTwitterBadgeText("", [{linkNumber: 1, embed: badge}], false))
      .toBe(`-# ℹ️ Reported [source](<${source}>)`);
  });

  test("short retry upgrades a single report to issuer attribution once", async () => {
    const deps = dependencies(payload("Airtable layoffs affect a large part of its team."));
    const issuer = {organization: "Airtable", source: "https://www.airtable.com/newsroom/back-to-bases"};
    const primaryStatementFn = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(issuer);
    deps.crossCheckFn.mockResolvedValue({verdict: "supported", sentence: "A report describes the same layoffs.",
      sources: ["https://bloomberg.com/news/articles/airtable-layoffs"]});
    const updates = vi.fn();
    const inspect = createTwitterIntrospector({...deps, primaryStatementFn, primaryRetryDelayMs: 10});
    expect((await inspect.observe!("https://fixvx.com/trader/status/123", updates))?.title).toBe("ℹ️ Reported claim");
    await vi.waitFor(() => { expect(updates.mock.lastCall?.[0]?.title).toBe("ℹ️ Company statement"); });
    expect((await inspect("https://fixvx.com/trader/status/123"))?.title).toBe("ℹ️ Company statement");
    expect(primaryStatementFn).toHaveBeenCalledTimes(2);
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(1);
    expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
  });

  test("short retry leaves an unsupported claim untouched and ends the review", async () => {
    const deps = dependencies(payload("Airtable layoffs affect a large part of its team."));
    const primaryStatementFn = vi.fn().mockResolvedValue(undefined);
    deps.crossCheckFn.mockResolvedValue(undefined);
    const updates = vi.fn();
    const inspect = createTwitterIntrospector({...deps, primaryStatementFn, primaryRetryDelayMs: 10});
    expect((await inspect.observe!("https://fixvx.com/trader/status/123", updates))?.title)
      .toBe("🟡 10% Spiciness — Fact check unverified");
    await vi.waitFor(() => { expect(primaryStatementFn).toHaveBeenCalledTimes(2); });
    expect(updates.mock.lastCall?.[0]?.title).toBe("🟡 10% Spiciness — Fact check unverified");
    expect(updates).toHaveBeenCalledTimes(2);
    expect(primaryStatementFn).toHaveBeenCalledTimes(2);
  });

  test("publishes red after source research finishes first", async () => {
    const deps = dependencies();
    const fact = deferred<Awaited<ReturnType<typeof deps.crossCheckFn>>>();
    deps.crossCheckFn.mockReturnValue(fact.promise);
    const updates = vi.fn();
    const result = createTwitterIntrospector(deps).observe!("https://fixvx.com/a/status/123", updates);
    await vi.waitFor(() => { expect(deps.credibilityFn).toHaveBeenCalledTimes(1); });
    expect(updates).toHaveBeenCalledTimes(1);
    fact.resolve({verdict: "contradicted", sentence: "The records directly refute the claim.",
      sources: ["https://reuters.com/world/report", "https://apnews.com/article/report"]});
    expect(await result).toMatchObject({title: "🔴 10% Spiciness — Claim contradicted"});
    expect(updates).toHaveBeenCalledTimes(2);
  });

  test("does not publish again when source research supports an existing wording caution", async () => {
    const deps = dependencies(payload("Share this before they hide it!"));
    const source = deferred<Awaited<ReturnType<typeof deps.credibilityFn>>>();
    deps.credibilityFn.mockReturnValue(source.promise);
    const updates = vi.fn();
    const inspect = createTwitterIntrospector(deps);
    const result = inspect.observe!("https://fixvx.com/a/status/123", updates);
    await vi.waitFor(() => { expect(updates).toHaveBeenCalledTimes(2); });
    expect(updates.mock.calls[0]?.[0].title).toBe("🔎 Checking");
    expect(appendTwitterBadgeText("", [{linkNumber: 1, embed: updates.mock.calls[0]?.[0]}], false))
      .toBe("-# 🔎 Checking");
    expect(appendTwitterBadgeText("", [{linkNumber: 1, embed: updates.mock.calls[1]?.[0]}], false))
      .toBe("-# 🟡 Wording caution [source](<https://reuters.com/world/report>)");
    source.resolve({target: "posting account", label: "@example", verdict: "credible", source: "https://example.org/about"});
    expect((await result)?.title).toContain("Wording caution");
    expect(updates).toHaveBeenCalledTimes(2);
    const cachedUpdate = vi.fn();
    await inspect.observe!("https://fixvx.com/a/status/123", cachedUpdate);
    expect(cachedUpdate).toHaveBeenCalledTimes(1);
    expect(cachedUpdate.mock.calls[0]?.[0].fields).toContainEqual({
      name: "Source credibility: credible (@example)", value: "[Evidence](https://example.org/about)",
    });
    expect(deps.credibilityFn).toHaveBeenCalledTimes(1);
  });

  test("keeps an unverified factual check yellow while source research finishes", async () => {
    const deps = dependencies(payload("The council approved the plan yesterday."));
    const fact = deferred<Awaited<ReturnType<typeof deps.crossCheckFn>>>();
    const source = deferred<Awaited<ReturnType<typeof deps.credibilityFn>>>();
    deps.crossCheckFn.mockReturnValue(fact.promise);
    deps.credibilityFn.mockReturnValue(source.promise);
    const updates = vi.fn();
    const result = createTwitterIntrospector(deps).observe!("https://fxtwitter.com/a/status/123", updates);
    await vi.waitFor(() => {
      expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
      expect(deps.credibilityFn).toHaveBeenCalledTimes(1);
    });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls[0]?.[0]).toMatchObject({title: "🔎 Checking"});
    fact.resolve(undefined);
    await vi.waitFor(() => { expect(updates).toHaveBeenCalledTimes(2); });
    source.resolve({target: "posting account", label: "@example", verdict: "credible", source: "https://example.org/about"});
    const badge = await result;
    expect(badge).toMatchObject({title: "🟡 10% Spiciness — Fact check unverified"});
    expect(updates).toHaveBeenCalledTimes(2);
    if (undefined === badge) throw new Error("Expected an unverified badge");
    expect(appendTwitterBadgeText("", [{linkNumber: 1, embed: badge}], false)).toBe("-# 🟡 Claim unverified");
  });

  test("publishes a conservative badge without spending AI calls when the provider is unavailable", async () => {
    const deps = dependencies({status: {id: "123", text: "The council approved the plan yesterday.",
      author: {screen_name: "new_poster", followers: 42, joined: "2026-10-01"}}});
    deps.aiAvailableFn.mockReturnValue(false);
    const updates = vi.fn();
    const badge = await createTwitterIntrospector(deps).observe!("https://fixvx.com/a/status/123", updates);
    expect(badge).toMatchObject({title: "🟡 10% Spiciness — Fact check unverified"});
    expect(updates).toHaveBeenCalledTimes(1);
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(1);
    expect(deps.crossCheckFn).not.toHaveBeenCalled();
    expect(deps.credibilityFn).not.toHaveBeenCalled();
    expect(badge?.fields).toContainEqual({
      name: "Source credibility: unverified (@new_poster)",
      value: "Under 100 followers · Account under 30 days old · Independent evidence unavailable",
    });
    if (undefined === badge) throw new Error("Expected an unverified badge");
    expect(appendTwitterBadgeText("", [{linkNumber: 1, embed: badge}], false)).toBe("-# 🟡 Claim unverified");
  });

  test("retries after provider availability returns, while retaining a previously grounded cached badge", async () => {
    const deps = dependencies();
    const inspect = createTwitterIntrospector(deps);
    deps.aiAvailableFn.mockReturnValue(false);
    expect(await inspect("https://fixvx.com/a/status/123")).toMatchObject({title: "🟡 10% Spiciness — Fact check unverified"});
    deps.aiAvailableFn.mockReturnValue(true);
    expect(await inspect("https://fixvx.com/a/status/123")).toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
    deps.aiAvailableFn.mockReturnValue(false);
    expect(await inspect("https://fixvx.com/a/status/123")).toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(2);
    expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
  });

  test("rates the reported chart post URL with a yellow fallback when AI is unavailable", async () => {
    const id = "2109614293801201700";
    const deps = dependencies({status: {type: "status", id,
      text: "Dane z naszego nasluchu siatki kont nie potwierdzaja spadku aktywnosci.",
      media: {photos: [{type: "photo"}]}, author: {screen_name: "Polityka_wSieci"}}});
    deps.aiAvailableFn.mockReturnValue(false);
    const badge = await createTwitterIntrospector(deps)(`https://fxtwitter.com/Polityka_wSieci/status/${id}`);
    expect(badge?.title).toMatch(/^🟡/u);
    expect(deps.getWithRetryFn).toHaveBeenCalledExactlyOnceWith(
      `https://api.fxtwitter.com/2/status/${id}`, expect.anything(), expect.anything());
    expect(deps.crossCheckFn).not.toHaveBeenCalled();
  });

  test.each(["unavailable", "error"])("shows an unverified indicator on %s review and retries the next paste", async mode => {
    const deps = dependencies(payload("The council approved the plan yesterday."));
    if (mode === "error") deps.crossCheckFn.mockRejectedValueOnce(new Error("sensitive provider payload"));
    else deps.crossCheckFn.mockResolvedValueOnce(undefined);
    const inspect = createTwitterIntrospector(deps);
    const unverified = await inspect("https://fixvx.com/a/status/123");
    expect(unverified).toMatchObject({title: "🟡 10% Spiciness — Fact check unverified"});
    expect(unverified?.fields).toContainEqual({
      name: "AI web cross-check: unverified (review sources)", value: "Independent evidence unavailable",
    });
    expect(await inspect("https://fixvx.com/a/status/123")).toMatchObject({description: "Reporting supports this specific claim."});
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(2);
    expect(deps.crossCheckFn).toHaveBeenCalledTimes(2);
    expect(deps.logger.log.mock.calls.every(([level]) => level === "debug")).toBe(true);
  });

  test("retries failed metadata on the next paste", async () => {
    const deps = dependencies();
    deps.getWithRetryFn.mockRejectedValueOnce(new Error("temporary failure"));
    const inspect = createTwitterIntrospector(deps);
    expect(await inspect("https://fixvx.com/a/status/123")).toBeUndefined();
    expect(await inspect("https://fixvx.com/a/status/123")).toBeDefined();
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(2);
  });

  test.each(["fixupx.com", "xfixup.com", "twittpr.com", "vxtwitter.com", "fixvx.com", "c.vxtwitter.com"])("assesses %s through the fixed FxTwitter metadata endpoint", async host => {
    const deps = dependencies();
    expect(await createTwitterIntrospector(deps)(`https://${host}/example/status/123`))
      .toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
    expect(deps.getWithRetryFn).toHaveBeenCalledExactlyOnceWith("https://api.fxtwitter.com/2/status/123", expect.anything(), expect.anything());
  });

  test("fetches only the fixed provider endpoint with bounded, non-redirecting requests", async () => {
    const deps = dependencies();
    const result = await createTwitterIntrospector(deps)("https://fxtwitter.com/example/status/123?ref=ignored");
    expect(deps.getWithRetryFn).toHaveBeenCalledExactlyOnceWith(
      "https://api.fxtwitter.com/2/status/123",
      expect.objectContaining({maxContentLength: 512_000, maxRedirects: 0, httpsAgent: expect.anything()}),
      {maxAttempts: 1, timeoutMs: 5_000},
    );
    expect(result).toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice", color: 0x2ecc71});
    expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
  });

  test("accepts the live v2 envelope without the legacy code field", async () => {
    // Shape observed on the reported RadioGenoa post; no legacy body code exists.
    const data = {status: {
      type: "status", id: "2106661915741114638",
      text: "A major cleanup is underway in Ceuta. It was about time. Send them all back.",
      media: {videos: [{type: "video"}]}, community_note: null,
    }};
    expect(parseTwitterPost(data, data.status.id)).toMatchObject({text: data.status.text, media: ["1 Video(s); content not inspected"]});
    const deps = dependencies(data);
    expect(await createTwitterIntrospector(deps)(`https://fxtwitter.com/RadioGenoa/status/${data.status.id}`))
      .toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
    expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
  });

  test.each([
    {followers: 42, expected: 42},
    {followers: 0, expected: 0},
    {followers: -1, expected: undefined},
    {followers: 1.5, expected: undefined},
    {followers: "42", expected: undefined},
  ])("reads only a nonnegative integer follower count from FxTwitter metadata: $followers", ({followers, expected}) => {
    const parsed = parseTwitterPost({status: {id: "123", text: "A claim.", author: {followers}}}, "123");
    expect(parsed?.authorFollowers).toBe(expected);
  });

  test("applies account age and follower cautions without expanding the visible badge", async () => {
    const evidence = "https://example.org/account-review";
    const callFn = vi.fn<typeof callAiProviderJson>((_prompt, _schema, _deps, _task, _data, options = {}) => {
      options.onWebSources?.([evidence]);
      return Promise.resolve(JSON.stringify({verdict: "credible", sourceUrls: [evidence]}));
    });
    const data = {status: {id: "123", text: "The council approved the plan yesterday.",
      author: {screen_name: "small_account", followers: 42, joined: "2026-10-01"}}};
    const deps = dependencies(data);
    const badge = await createTwitterIntrospector({...deps,
      credibilityFn: (post, reviewDeps) => researchTwitterSource(post, reviewDeps, callFn),
    })("https://fixvx.com/a/status/123");
    expect(badge).toMatchObject({title: "🟡 10% Spiciness — Account caution"});
    expect(badge?.fields).toContainEqual({
      name: "Source credibility: unverified (@small_account)",
      value: `Under 100 followers · Account under 30 days old · [Evidence](${evidence})`,
    });
    if (undefined === badge) throw new Error("Expected a badge for the supported claim");
    expect(appendTwitterBadgeText("", [{linkNumber: 1, embed: badge}], false))
      .toBe("-# 🟡 Account caution [source](<https://reuters.com/world/report>)");
  });

  test.each([
    {verdict: "supported", icon: "🟢", label: "Supported claim, low spice", color: 0x2ecc71},
    {verdict: "contradicted", icon: "🟡", label: "Claim contradicted", color: 0xf1c40f},
  ] as const)("combines a calm post's wording score with a $verdict fact check", async ({verdict, icon, label, color}) => {
    const data = payload("The council approved the plan yesterday.");
    const deps = dependencies(data);
    deps.crossCheckFn.mockResolvedValue({verdict, sentence: "Reporting establishes the council's decision.", sources: ["https://reuters.com/world/report"]});
    const result = await createTwitterIntrospector(deps)("https://fixvx.com/a/status/123");
    expect(deps.crossCheckFn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({text: data.status.text}), expect.anything());
    expect(result).toMatchObject({title: `${icon} 10% Spiciness — ${label}`, color,
      description: "Reporting establishes the council's decision."});
    expect(result?.fields).toContainEqual({name: `AI web cross-check: ${verdict} (review sources)`, value: "[Source 1](https://reuters.com/world/report)"});
    expect(result?.fields).toContainEqual({name: "Source credibility: credible (@example)", value: "[Evidence](https://example.org/about)"});
  });

  test.each([
    {verdict: "concerns", icon: "🟡", label: "Source credibility concerns", color: 0xf1c40f, source: "https://example.org/concerns"},
    {verdict: "unverified", icon: "🟢", label: "Supported claim, low spice", color: 0x2ecc71, source: undefined},
  ])("uses documented account concerns but keeps missing reputation evidence neutral: $verdict", async ({verdict, icon, label, color, source}) => {
    const deps = dependencies(payload("The council approved the plan yesterday."));
    deps.credibilityFn.mockResolvedValue({target: "posting account", label: "@example", verdict, source});
    const badge = await createTwitterIntrospector(deps)("https://fixvx.com/a/status/123");
    expect(badge).toMatchObject({title: `${icon} 10% Spiciness — ${label}`, color});
    expect(badge?.fields).toContainEqual({name: `Source credibility: ${verdict} (@example)`,
      value: undefined === source ? "Independent evidence unavailable" : `[Evidence](${source})`});
    expect(deps.credibilityFn).toHaveBeenCalledTimes(1);
  });

  test("keeps a supported claim green when metadata identifies no account or linked source", async () => {
    const deps = dependencies(payload("The council approved the plan yesterday."));
    const badge = await createTwitterIntrospector({...deps, credibilityFn: researchTwitterSource})("https://fixvx.com/a/status/123");
    expect(badge).toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
    expect(badge?.fields).toContainEqual({name: "Source credibility: unverified (source not identified)",
      value: "Independent evidence unavailable"});
  });

  test("lets documented linked-source concerns block green regardless of poster reputation", async () => {
    const linked = "https://reports.example.net/story";
    const evidence = "https://independent.org/source-review";
    const data = {status: {id: "123", text: "The council approved the plan yesterday.",
      author: {screen_name: "established_poster", followers: 50_000, joined: "2020-01-01"},
      raw_text: {facets: [{type: "url", replacement: linked}]}}};
    const callFn = vi.fn<typeof callAiProviderJson>((prompt, _schema, _deps, _task, _data, options = {}) => {
      expect(prompt).toContain(linked);
      options.onWebSources?.([evidence]);
      return Promise.resolve(JSON.stringify({verdict: "concerns", sourceUrls: [evidence]}));
    });
    const deps = dependencies(data);
    const badge = await createTwitterIntrospector({...deps,
      credibilityFn: (post, reviewDeps) => researchTwitterSource(post, reviewDeps, callFn),
    })("https://fixvx.com/a/status/123");
    expect(badge).toMatchObject({title: "🟡 10% Spiciness — Source credibility concerns"});
    expect(badge?.fields).toContainEqual({name: "Source credibility: concerns (linked site)", value: `[Evidence](${evidence})`});
    expect(callFn).toHaveBeenCalledTimes(1);
  });

  test("treats missing linked-source reputation evidence as neutral even for a new poster", async () => {
    const data = {status: {id: "123", text: "The council approved the plan yesterday.",
      author: {screen_name: "new_poster", followers: 3, joined: "2026-10-01",
        avatar_url: "https://abs.twimg.com/default_profile_images/avatar.png"},
      raw_text: {facets: [{type: "url", replacement: "https://reports.example.net/story"}]}}};
    const deps = dependencies(data);
    const badge = await createTwitterIntrospector({...deps,
      credibilityFn: (post, reviewDeps) => researchTwitterSource(post, reviewDeps,
        vi.fn<typeof callAiProviderJson>().mockResolvedValue(JSON.stringify({verdict: "unverified", sourceUrls: []}))),
    })("https://fixvx.com/a/status/123");
    expect(badge).toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
    expect(badge?.fields).toContainEqual({name: "Source credibility: unverified (linked site)",
      value: "Independent evidence unavailable"});
  });

  test("uses one account caution only alongside mild wording concern", async () => {
    const deps = dependencies(payload("The council approved the plan yesterday!!!"));
    deps.credibilityFn.mockResolvedValue({target: "posting account", label: "@small", verdict: "unverified",
      cautions: ["Under 100 followers"]});
    const badge = await createTwitterIntrospector(deps)("https://fixvx.com/a/status/123");
    expect(badge).toMatchObject({title: "🟡 20% Spiciness — Account caution"});
  });

  test("keeps one account caution secondary to a supported calm claim", async () => {
    const deps = dependencies(payload("The council approved the plan yesterday."));
    deps.credibilityFn.mockResolvedValue({target: "posting account", label: "@small", verdict: "unverified",
      cautions: ["Under 100 followers"]});
    const badge = await createTwitterIntrospector(deps)("https://fixvx.com/a/status/123");
    expect(badge).toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
  });

  test("passes quoted claims to the check even when the author's wording is calm", async () => {
    const data = {status: {id: "123", text: "An interesting announcement.", quote: {text: "The council approved the plan yesterday."}}};
    const deps = dependencies(data);
    await createTwitterIntrospector(deps)("https://fixvx.com/a/status/123");
    expect(deps.crossCheckFn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      text: data.status.text, quotedText: data.status.quote.text,
    }), expect.anything());
  });

  test.each([
    {code: 404, status: {id: "123", text: "Not a successful response"}},
    {code: null, status: {id: "123", text: "Invalid code"}},
    {status: {type: "tombstone", id: "123", text: "This post is unavailable"}},
    {status: {type: "profile", id: "123", text: "Not a post"}},
    {status: {type: "status", id: "456", text: "A different post"}},
  ])("rejects error envelopes, tombstones and mismatched IDs without legacy code %#", data => {
    expect(parseTwitterPost(data, "123")).toBeUndefined();
  });

  test.each([
    "https://fxtwitter.com/example", "https://x.com/example/status/123", "https://fxtwitter.com.evil.test/a/status/123",
    "http://fxtwitter.com/example/status/123", "https://user:pass@fxtwitter.com/example/status/123",
    "https://fxtwitter.com/example/status/not-a-number", "https://fxtwitter.com/example/status/123/other", "broken",
  ])("ignores unsupported URL %s", async link => {
    const deps = dependencies();
    expect(await createTwitterIntrospector(deps)(link)).toBeUndefined();
    expect(deps.getWithRetryFn).not.toHaveBeenCalled();
  });

  test("coalesces duplicate IDs across usernames, photo suffixes and web links", async () => {
    const deps = dependencies();
    const inspect = createTwitterIntrospector(deps);
    const results = await Promise.all([
      inspect("https://fxtwitter.com/example/status/123/photo/1"),
      inspect("https://fxtwitter.com/i/web/status/123"),
      inspect("https://fxtwitter.com/other/status/123/"),
      inspect("https://fixupx.com/other/status/123"),
      inspect("https://fixvx.com/other/status/123"),
    ]);
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(1);
    expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(results[2]).toEqual(results[3]);
    expect(results[3]).toEqual(results[4]);
  });

  test("expires cached assessments after ten minutes", async () => {
    const deps = dependencies();
    let nowMs = 0;
    deps.nowMs = () => nowMs;
    const inspect = createTwitterIntrospector(deps);
    await inspect("https://fxtwitter.com/a/status/123");
    nowMs = 600_000;
    await inspect("https://fxtwitter.com/a/status/123");
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(2);
  });

  test("evicts the oldest entry when the bounded cache is full", async () => {
    const deps = dependencies();
    const inspect = createTwitterIntrospector(deps);
    for (let id = 100; id <= 200; id++) {
      deps.getWithRetryFn.mockResolvedValue({data: payload("A quiet day", String(id))});
      await inspect(`https://fxtwitter.com/a/status/${id}`);
    }
    await inspect("https://fxtwitter.com/a/status/100");
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(102);
  });

  test("bounds concurrent fetches and recovers capacity after they finish", async () => {
    const deps = dependencies();
    const resolvers: ((value: unknown) => void)[] = [];
    deps.getWithRetryFn.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve); }));
    const inspect = createTwitterIntrospector(deps);
    const pending = [100, 101, 102, 103].map(id => inspect(`https://fxtwitter.com/a/status/${id}`));
    expect(await inspect("https://fxtwitter.com/a/status/104")).toBeUndefined();
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(4);
    resolvers.forEach(resolve => { resolve({data: payload()}); });
    await Promise.all(pending);
    deps.getWithRetryFn.mockResolvedValue({data: payload("Quiet", "104")});
    expect(await inspect("https://fxtwitter.com/a/status/104")).toMatchObject({title: expect.stringContaining("🟢")});
  });

  test("shows yellow for supported claims with elevated wording spice", async () => {
    const deps = dependencies(payload("They are hiding this from you"));
    deps.crossCheckFn.mockResolvedValue({
      verdict: "supported", sentence: "Reporting supports this specific claim.", sources: ["https://reuters.com/a(b)"],
    });
    const yellow = await createTwitterIntrospector(deps)("https://fxtwitter.com/a/status/123");
    expect(yellow).toMatchObject({title: "🟡 40% Spiciness — Wording caution", description: "Reporting supports this specific claim."});
    expect(yellow?.fields).toContainEqual({name: "AI web cross-check: supported (review sources)", value: "[Source 1](https://reuters.com/a%28b%29)"});
    deps.getWithRetryFn.mockResolvedValue({data: payload("THEY ARE HIDING THIS FROM YOU! BIG IF TRUE! WAKE UP SHEEPLE!!! 🧵👇")});
    expect(await createTwitterIntrospector(deps)("https://fxtwitter.com/a/status/123"))
      .toMatchObject({title: "🟡 95% Spiciness — Wording caution", color: 0xf1c40f});
  });

  test("silently omits failed metadata without leaking remote errors", async () => {
    const deps = dependencies();
    deps.getWithRetryFn.mockRejectedValue(new Error("sensitive response body"));
    expect(await createTwitterIntrospector(deps)("https://fxtwitter.com/a/status/123"))
      .toBeUndefined();
    expect(deps.logger.log).toHaveBeenCalledExactlyOnceWith("debug", "Twitter/X introspection skipped; keeping the link preview.");
  });

  test.each(["A calm factual claim.", "They are hiding this from you"])(
    "checks posts with a Community Note independently of wording: %s", async text => {
      const data = {code: 200, status: {id: "123", text, community_note: {
        text: "The photograph was taken before this event. https://example.org/archive", facets: [],
      }}};
      const deps = dependencies(data);
      const result = await createTwitterIntrospector(deps)("https://fxtwitter.com/a/status/123");
      expect(result?.description).toBe("Reporting supports this specific claim.");
      const note = result?.fields?.find(field => field.name.startsWith("Community Note"));
      expect(note).toMatchObject({name: "Community Note via FxTwitter (excerpt)", value: expect.stringContaining("photograph")});
      expect(note?.value).toContain("[Note source](https://example.org/archive)");
      expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
      expect(deps.crossCheckFn.mock.calls[0]?.[0].communityNote).toMatchObject({text: expect.stringContaining("photograph")});
      expect(deps.getWithRetryFn).toHaveBeenCalledTimes(1);
      const withoutNote = await createTwitterIntrospector(dependencies(payload(text)))("https://fxtwitter.com/a/status/123");
      expect(result?.title).toBe(withoutNote?.title);
    },
  );

  test("shows a brief unverified status when a Community Note cannot establish the claim", async () => {
    const deps = dependencies({status: {id: "123", text: "A calm factual claim.", community_note: {text: "A supplied note."}}});
    deps.crossCheckFn.mockResolvedValue(undefined);
    const badge = await createTwitterIntrospector(deps)("https://fixvx.com/a/status/123");
    expect(badge).toMatchObject({title: "🟡 10% Spiciness — Fact check unverified"});
    if (undefined === badge) throw new Error("Expected an unverified badge");
    expect(appendTwitterBadgeText("", [{linkNumber: 1, embed: badge}], false)).toBe("-# 🟡 Claim unverified");
    expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, null, {text: " "}, {text: 7}, {text: "a".repeat(8_001)}])(
    "retains the web-check fallback for absent/invalid root notes %#", async community_note => {
      const deps = dependencies({code: 200, status: {id: "123", text: "Big if true", community_note,
        quote: {community_note: {text: "A note on another post", facets: []}},
      }});
      const result = await createTwitterIntrospector(deps)("https://fxtwitter.com/a/status/123");
      expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
      expect(result?.fields?.some(field => field.name.includes("Community Note"))).toBe(false);
    },
  );

  test.each([{}, {code: 404}, {code: 200, status: null}, {code: 200, status: {id: "456", text: "Wrong tweet"}}])(
    "does not score an unavailable or mismatched post %#", async data => {
      const deps = dependencies(data);
      expect(await createTwitterIntrospector(deps)("https://fxtwitter.com/a/status/123"))
        .toBeUndefined();
      expect(deps.crossCheckFn).not.toHaveBeenCalled();
    },
  );

  test("extracts bounded context without fetching untrusted external links", async () => {
    const data = {
      code: 200,
      status: {
        id: "123", text: "They are hiding this from you https://t.co/abc.",
        author: {joined: "2026-10-01", avatar_url: "https://abs.twimg.com/sticky/default_profile_images/avatar.png", website: {url: "https://reuters.com/"}},
        media: {photos: [{altText: "cat"}], videos: [{}], external: {url: "https://localhost/secret"}},
        raw_text: {facets: [
          {type: "url", replacement: "https://reuters.com/world/report"},
          {type: "url", replacement: "https://reuters.com/world/report"},
          {type: "url", replacement: "https://user:pass@host.test/secret"},
          {type: "url", replacement: "file:///etc/passwd"},
          {type: "url", replacement: "broken"},
          {type: "url", replacement: `https://host.test/${"a".repeat(351)}`},
          {type: "mention", replacement: "@everyone"}, {type: "url", replacement: 7},
        ]},
        quote: {text: "An original source describes another event."},
      },
    };
    expect(parseTwitterPost(data, "123")).toEqual({
      text: data.status.text, quotedText: data.status.quote.text,
      media: ["1 Photo(s); content not inspected", "1 Video(s); content not inspected", "External media; content not inspected"],
      externalLinks: ["https://reuters.com/world/report", "https://t.co/abc"],
      authorJoined: "2026-10-01", defaultAvatar: true, authorWebsite: "https://reuters.com/",
    });
    const deps = dependencies(data);
    const result = await createTwitterIntrospector(deps)("https://fxtwitter.com/a/status/123");
    expect(result?.fields).toContainEqual({name: "Context", value: expect.stringContaining("Profile links to a recognised")});
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(1);
    expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
  });

  test("uses expanded facet URLs in place of shorteners for social-citation scoring", async () => {
    const data = {code: 200, status: {
      id: "123", text: "An ordinary post https://t.co/abc.",
      raw_text: {facets: [{type: "url", original: "https://t.co/abc", replacement: "https://x.com/other/status/456"}]},
    }};
    expect(parseTwitterPost(data, "123")?.externalLinks).toEqual(["https://x.com/other/status/456"]);
    expect(await createTwitterIntrospector(dependencies(data))("https://fxtwitter.com/a/status/123"))
      .toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice"});
  });

  test("extracts the posting handle and quoted article link for credibility research", () => {
    const data = {status: {id: "123", text: "Read the quoted report.", author: {screen_name: "Reporter_1"},
      quote: {text: "The report https://t.co/abc", raw_text: {facets: [
        {type: "url", original: "https://t.co/abc", replacement: "https://reports.example.org/story"},
      ]}},
    }};
    expect(parseTwitterPost(data, "123")).toMatchObject({
      authorHandle: "Reporter_1", quotedExternalLinks: ["https://reports.example.org/story"], externalLinks: [],
    });
    expect(parseTwitterPost({status: {...data.status, author: {screen_name: "bad handle"}}}, "123"))
      .not.toHaveProperty("authorHandle");
  });

  test("researches a quoted article and includes its grounded credibility result in the badge", async () => {
    const article = "https://reports.example.org/story";
    const evidence = "https://independent.org/about-reports";
    const data = {status: {id: "123", text: "See the quoted article.", author: {screen_name: "poster"},
      quote: {text: "Source https://t.co/abc", raw_text: {facets: [
        {type: "url", original: "https://t.co/abc", replacement: article},
      ]}},
    }};
    const callFn = vi.fn<typeof callAiProviderJson>((prompt, _schema, _deps, _task, _inline, options = {}) => {
      expect(prompt).toContain(article);
      options.onWebSources?.([evidence]);
      return Promise.resolve(JSON.stringify({verdict: "credible", sourceUrls: [evidence]}));
    });
    const deps = dependencies(data);
    const badge = await createTwitterIntrospector({...deps,
      credibilityFn: (post, aiDeps) => researchTwitterSource(post, aiDeps, callFn),
    })("https://fixvx.com/poster/status/123");
    expect(callFn).toHaveBeenCalledTimes(1);
    expect(badge).toMatchObject({title: "🟢 10% Spiciness — Supported claim, low spice, credible source"});
    expect(badge?.fields).toContainEqual({name: "Source credibility: credible (linked site)",
      value: `[Evidence](${evidence})`});
  });

  test.each([false, true])("bounds badges and reserves the AI citation before optional context, with note: %s", async withNote => {
    const data = {code: 200, status: {
      id: "123", text: "THEY ARE HIDING THIS FROM YOU! BIG IF TRUE! WAKE UP SHEEPLE!!! 🧵👇",
      author: {joined: "2026-10-01", avatar_url: "https://abs.twimg.com/default_profile_images/a.png", website: {url: "https://reuters.com"}},
      quote: {text: "Context"}, media: {photos: [{}], videos: [{}], external: {}},
      raw_text: {facets: [{type: "url", replacement: "https://x.com/other/status/456"}]},
      ...(withNote ? {community_note: {text: "a".repeat(8_000), facets: [
        {type: "url", indices: [0, 1], replacement: `https://example.org/${"a".repeat(330)}`},
      ]}} : {}),
    }};
    const deps = dependencies(data);
    deps.crossCheckFn.mockResolvedValue({verdict: "contradicted", sentence: `${"a".repeat(279)}.`, sources: [`https://reuters.com/${"a".repeat(320)}`]});
    const badge = await createTwitterIntrospector(deps)("https://fxtwitter.com/a/status/123");
    const length = (badge?.title?.length ?? 0) + (badge?.description?.length ?? 0) + (badge?.footer?.text.length ?? 0)
      + (badge?.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
    expect(length * 4).toBeLessThanOrEqual(6_000);
    expect(badge?.fields?.every(field => field.value.length <= 1_024)).toBe(true);
    expect(badge?.fields?.[0]).toEqual({name: "AI web cross-check: contradicted (review sources)", value: `[Source 1](https://reuters.com/${"a".repeat(320)})`});
    // The longest note field cannot fit beside this maximum-sized AI claim;
    // omit that whole field, preserving the required AI citation.
    expect(badge?.fields?.some(field => field.name.includes("Community Note"))).toBe(false);
  });

  test.each([null, [], {code: 200, status: []}, payload(" "), payload("a".repeat(8_001)), {code: 200, status: {id: "123", text: 7}}])(
    "rejects invalid, missing, empty or oversized text %#", data => {
      expect(parseTwitterPost(data, "123")).toBeUndefined();
    },
  );
});
