import {describe, expect, test, vi} from "vitest";
import {createTwitterIntrospector, parseTwitterPost} from "./twitter-sanity.ts";

function payload(text = "A cat enjoys a sunny afternoon.", id = "123") {
  return {code: 200, status: {id, text}};
}

function dependencies(data: unknown = payload()) {
  return {
    logger: {log: vi.fn()},
    aiAvailableFn: vi.fn(() => true),
    getWithRetryFn: vi.fn().mockResolvedValue({data}),
    crossCheckFn: vi.fn().mockResolvedValue({verdict: "supported", sentence: "Reporting supports this specific claim.", sources: ["https://reuters.com/world/report"]}),
    nowMs: () => Date.parse("2026-10-07T12:00:00Z"),
  };
}

describe("Twitter metadata and badge service", () => {
  test("skips all badges and metadata when AI review is unavailable", async () => {
    const deps = dependencies();
    deps.aiAvailableFn.mockReturnValue(false);
    expect(await createTwitterIntrospector(deps)("https://fixvx.com/a/status/123")).toBeUndefined();
    expect(deps.getWithRetryFn).not.toHaveBeenCalled();
    expect(deps.crossCheckFn).not.toHaveBeenCalled();
    expect(deps.logger.log).not.toHaveBeenCalled();
  });

  test("checks availability before returning a previously successful cached badge", async () => {
    const deps = dependencies();
    const inspect = createTwitterIntrospector(deps);
    expect(await inspect("https://fixvx.com/a/status/123")).toBeDefined();
    deps.aiAvailableFn.mockReturnValue(false);
    expect(await inspect("https://fixvx.com/a/status/123")).toBeUndefined();
    deps.aiAvailableFn.mockReturnValue(true);
    expect(await inspect("https://fixvx.com/a/status/123")).toBeDefined();
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(1);
  });

  test.each(["unavailable", "error"])("omits AI-dependent badges on %s review and retries the next paste", async mode => {
    const deps = dependencies(payload("The council approved the plan yesterday."));
    if (mode === "error") deps.crossCheckFn.mockRejectedValueOnce(new Error("sensitive provider payload"));
    else deps.crossCheckFn.mockResolvedValueOnce(undefined);
    const inspect = createTwitterIntrospector(deps);
    expect(await inspect("https://fixvx.com/a/status/123")).toBeUndefined();
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
      .toMatchObject({title: "🟢 10% Spiciness — Low sensationalism"});
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
    expect(result).toMatchObject({title: "🟢 10% Spiciness — Low sensationalism", color: 0x2ecc71});
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
      .toMatchObject({title: "🟢 10% Spiciness — Low sensationalism"});
    expect(deps.crossCheckFn).toHaveBeenCalledTimes(1);
  });

  test.each(["supported", "contradicted"])("checks a calm claim and keeps its %s verdict separate from the wording score", async verdict => {
    const data = payload("The council approved the plan yesterday.");
    const deps = dependencies(data);
    deps.crossCheckFn.mockResolvedValue({verdict, sentence: "Reporting establishes the council's decision.", sources: ["https://reuters.com/world/report"]});
    const result = await createTwitterIntrospector(deps)("https://fixvx.com/a/status/123");
    expect(deps.crossCheckFn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({text: data.status.text}), expect.anything());
    expect(result).toMatchObject({title: "🟢 10% Spiciness — Low sensationalism", description: "Reporting establishes the council's decision."});
    expect(result?.fields).toContainEqual({name: `AI web cross-check: ${verdict} (review sources)`, value: "[Source 1](https://reuters.com/world/report)"});
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

  test("renders yellow/red wording independently of a source-linked AI verdict", async () => {
    const deps = dependencies(payload("They are hiding this from you"));
    deps.crossCheckFn.mockResolvedValue({
      verdict: "supported", sentence: "Reporting supports this specific claim.", sources: ["https://reuters.com/a(b)"],
    });
    const yellow = await createTwitterIntrospector(deps)("https://fxtwitter.com/a/status/123");
    expect(yellow).toMatchObject({title: "🟡 40% Spiciness — Caution", description: "Reporting supports this specific claim."});
    expect(yellow?.fields).toContainEqual({name: "AI web cross-check: supported (review sources)", value: "[Source 1](https://reuters.com/a%28b%29)"});
    deps.getWithRetryFn.mockResolvedValue({data: payload("THEY ARE HIDING THIS FROM YOU! BIG IF TRUE! WAKE UP SHEEPLE!!! 🧵👇")});
    expect(await createTwitterIntrospector(deps)("https://fxtwitter.com/a/status/123"))
      .toMatchObject({title: "🔴 95% Spiciness — High sensationalism", color: 0xe74c3c});
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

  test("silently omits a Community Note badge when its AI check is unusable", async () => {
    const deps = dependencies({status: {id: "123", text: "A calm factual claim.", community_note: {text: "A supplied note."}}});
    deps.crossCheckFn.mockResolvedValue(undefined);
    expect(await createTwitterIntrospector(deps)("https://fixvx.com/a/status/123")).toBeUndefined();
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
      .toMatchObject({title: "🟢 20% Spiciness — Low sensationalism"});
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
