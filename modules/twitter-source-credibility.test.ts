import {describe, expect, test, vi} from "vitest";
import type {callAiProviderJson} from "./ai-provider.ts";
import type {TwitterPostContext} from "./twitter-sanity-score.ts";
import {researchTwitterSource, selectCredibilityTarget} from "./twitter-source-credibility.ts";

const post: TwitterPostContext = {
  text: "An announcement.", quotedText: "", media: [], externalLinks: [],
  authorHandle: "example_org", authorJoined: "", defaultAvatar: false, authorWebsite: "",
};
const evidence = "https://example.org/about/editorial-standards";

function mockCall(value: unknown, searchedUrls = [evidence]) {
  return vi.fn<typeof callAiProviderJson>((_prompt, _schema, _deps, _task, _data, options = {}) => {
    options.onWebSources?.(searchedUrls);
    return Promise.resolve(typeof value === "string" || value === null ? value : JSON.stringify(value));
  });
}

describe("Twitter source credibility", () => {
  test("prefers a linked source, then a quoted link, then the posting account", () => {
    const linked = "https://reports.example.net/article";
    expect(selectCredibilityTarget({...post, externalLinks: ["https://x.com/a/status/2", linked],
      quotedExternalLinks: ["https://other.example.org/story"]})).toEqual({kind: "link", value: linked, label: "reports.example.net"});
    expect(selectCredibilityTarget({...post, quotedExternalLinks: [linked]})).toEqual({kind: "link", value: linked, label: "reports.example.net"});
    expect(selectCredibilityTarget({...post, externalLinks: ["https://t.co/short"]}))
      .toEqual({kind: "account", value: "example_org", label: "@example_org"});
  });

  test.each(["http://reports.example.net/story", "https://localhost/story", "https://127.0.0.1/story",
    "https://user:pass@reports.example.net/story", "https://reports.example.net:8443/story", "https://x.com/a/status/2"])(
    "does not research an unsafe or social link as a publisher: %s", link => {
      expect(selectCredibilityTarget({...post, externalLinks: [link]}))
        .toEqual({kind: "account", value: "example_org", label: "@example_org"});
    },
  );

  test("accepts linked-source credibility only with independent searched evidence", async () => {
    const target = {...post, externalLinks: ["https://reports.example.net/article"]};
    const callFn = mockCall({verdict: "credible", sourceUrls: [evidence]});
    expect(await researchTwitterSource(target, {logger: {log: vi.fn()}}, callFn)).toEqual({
      target: "linked source", label: "reports.example.net", verdict: "credible", source: evidence,
    });
    expect(callFn).toHaveBeenCalledWith(expect.stringContaining("linked source"), expect.anything(),
      expect.anything(), "Twitter/X source credibility", undefined,
      expect.objectContaining({useWebSearch: true, onWebSources: expect.any(Function)}));
  });

  test("accepts documented account concerns with an independently searched citation", async () => {
    const callFn = mockCall({verdict: "concerns", sourceUrls: [evidence]});
    expect(await researchTwitterSource(post, {logger: {log: vi.fn()}}, callFn)).toEqual({
      target: "posting account", label: "@example_org", verdict: "concerns", source: evidence,
    });
    expect(callFn.mock.calls[0]?.[0]).toContain("checkmark, follower count and age are not proof");
  });

  test.each([
    {value: {verdict: "credible", sourceUrls: [evidence]}, searched: []},
    {value: {verdict: "credible", sourceUrls: ["https://reports.example.net/about"]},
      searched: ["https://reports.example.net/about"]},
    {value: {verdict: "credible", sourceUrls: ["https://x.com/other/status/1"]},
      searched: ["https://x.com/other/status/1"]},
    {value: {verdict: "credible", sourceUrls: ["https://127.0.0.1/private"]},
      searched: ["https://127.0.0.1/private"]},
    {value: {verdict: "credible", sourceUrls: ["https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc"]},
      searched: ["https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc"]},
    {value: {verdict: "unverified", sourceUrls: [evidence]}, searched: [evidence]},
    {value: {verdict: "credible", sourceUrls: "wrong"}, searched: [evidence]},
    {value: "invalid JSON", searched: [evidence]},
  ])("keeps linked-source credibility unverified without independent provenance %#", async ({value, searched}) => {
    const target = {...post, externalLinks: ["https://reports.example.net/article"]};
    expect(await researchTwitterSource(target, {logger: {log: vi.fn()}}, mockCall(value, searched))).toEqual({
      target: "linked source", label: "reports.example.net", verdict: "unverified",
    });
  });

  test("does not call AI when no source or valid account is identified", async () => {
    const callFn = mockCall({verdict: "credible", sourceUrls: [evidence]});
    expect(await researchTwitterSource({...post, authorHandle: "bad handle"}, {logger: {log: vi.fn()}}, callFn)).toEqual({
      target: "unidentified", label: "source not identified", verdict: "unverified",
    });
    expect(callFn).not.toHaveBeenCalled();
  });

  test("handles provider failures without exposing response details", async () => {
    const logger = {log: vi.fn()};
    const callFn = vi.fn<typeof callAiProviderJson>().mockRejectedValue(new Error("private provider response"));
    expect(await researchTwitterSource(post, {logger}, callFn)).toMatchObject({verdict: "unverified"});
    expect(logger.log).toHaveBeenCalledExactlyOnceWith("debug", "Twitter/X source credibility check skipped.");
  });
});
