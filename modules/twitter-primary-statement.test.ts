import {describe, expect, test, vi} from "vitest";
import type {callAiProviderJson} from "./ai-provider.ts";
import {isPotentialPrimaryStatement, primarySourceUrl, researchTwitterPrimaryStatement} from "./twitter-primary-statement.ts";
import type {TwitterPostContext} from "./twitter-sanity-score.ts";

const source = "https://www.airtable.com/newsroom/back-to-bases";
const quote = "We're parting ways with a large portion of the pre-acquisition team.";
const text = "Today we're laying off a large part of the Airtable team. We've shipped 30+ improvements in 3 weeks.";
const page = `<article><h1>Airtable update</h1><p>${quote}</p><p>In the past three weeks, our team shipped more than 30 improvements.</p></article>`;

function post(additions: Partial<TwitterPostContext> = {}): TwitterPostContext {
  return {text, quotedText: "", media: [], externalLinks: [], authorHandle: "fedesimio",
    authorJoined: "", defaultAvatar: false, authorWebsite: "", ...additions};
}

function research(options: {
  answer?: unknown; searched?: readonly string[]; html?: string; post?: TwitterPostContext;
} = {}) {
  const answer = options.answer ?? {matched: true, organization: "Airtable", sourceUrl: source, evidenceQuote: quote};
  const callFn = vi.fn<typeof callAiProviderJson>((_prompt, _schema, _deps, _task, _data, settings = {}) => {
    settings.onWebSources?.([...(options.searched ?? [source])]);
    return Promise.resolve(JSON.stringify(answer));
  });
  const getWithRetryFn = vi.fn().mockResolvedValue({data: options.html ?? page});
  return {result: researchTwitterPrimaryStatement(options.post ?? post(), {logger: {log: vi.fn()}, getWithRetryFn}, callFn),
    callFn, getWithRetryFn};
}

describe("Twitter first-party statement attribution", () => {
  test("checks plausible company and company-connected announcements", () => {
    expect(isPotentialPrimaryStatement(post())).toBe(true);
    expect(isPotentialPrimaryStatement(post({text: "Airtable is laying off staff."}))).toBe(false);
    expect(isPotentialPrimaryStatement(post({text: "Airtable is laying off staff.", authorHandle: "Airtable"}))).toBe(true);
    expect(isPotentialPrimaryStatement(post({text: "Introducing Omni, shipping 30 improvements.", authorHandle: "Airtable"}))).toBe(true);
    expect(isPotentialPrimaryStatement(post({text: "We're excited about the future."}))).toBe(false);
    expect(isPotentialPrimaryStatement(post({quotedText: "Airtable laid off staff."}))).toBe(false);
    expect(isPotentialPrimaryStatement(post({communityNote: {text: "Disputed", sourceUrls: []}}))).toBe(false);
  });

  test("attributes a post to a fetched, search-grounded company newsroom page", async () => {
    const {result, callFn, getWithRetryFn} = research();
    expect(await result).toEqual({organization: "Airtable", source});
    expect(callFn.mock.calls[0]?.[0]).toContain("investor-relations releases, and SEC EDGAR filing exhibits");
    expect(callFn.mock.calls[0]?.[0]).toContain("every material factual assertion");
    expect(getWithRetryFn).toHaveBeenCalledExactlyOnceWith(source, expect.objectContaining({
      maxRedirects: 0, maxContentLength: 1_000_000, responseType: "text",
    }), expect.objectContaining({maxAttempts: 1, timeoutMs: 5_000}));
  });

  test("accepts the same organization when the source uses a legal suffix", async () => {
    const answer = {matched: true, organization: "Airtable, Inc.", sourceUrl: source, evidenceQuote: quote};
    expect(await research({answer}).result).toEqual({organization: "Airtable, Inc.", source});
  });

  test("attributes a third-person company-account announcement to its official release", async () => {
    const companyPost = post({authorHandle: "Airtable",
      text: "Airtable is laying off a large part of its team and shipped 30 improvements in 3 weeks."});
    expect(await research({post: companyPost}).result).toEqual({organization: "Airtable", source});
  });

  test("attributes a company-account launch without repeating its name only when the source matches", async () => {
    const companyPost = post({authorHandle: "Airtable", text: "Introducing Omni and 30 new improvements."});
    const launchPage = `${page}<p>Introducing Omni and 30 new improvements.</p>`;
    expect(await research({post: companyPost, html: launchPage}).result).toEqual({organization: "Airtable", source});
  });

  test.each([
    ["not searched", {searched: []}],
    ["copied unrelated quote", {html: "<p>Airtable. We announced an unrelated product.</p>"}],
    ["missing number", {html: `<p>Airtable. ${quote} We improved the product.</p>`}],
    ["untrusted linked source", {post: post({externalLinks: ["https://rumors.example/story"]})}],
    ["different organization", {answer: {matched: true, organization: "Other", sourceUrl: source, evidenceQuote: quote}}],
    ["partial model answer", {answer: {matched: false, organization: "Airtable", sourceUrl: source, evidenceQuote: quote}}],
  ] as const)("rejects %s", async (_name, options) => {
    expect(await research(options).result).toBeUndefined();
  });

  test("accepts a link to the same corporate host with or without www", async () => {
    expect(await research({post: post({externalLinks: ["https://airtable.com/newsroom/back-to-bases"]})}).result)
      .toEqual({organization: "Airtable", source});
  });

  test("accepts a matching investor-relations release or SEC filing exhibit", async () => {
    const investorSource = "https://investors.bendingspoons.com/newsroom/airtable-back-to-bases";
    const filingSource = "https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/a8-kex991.htm";
    expect(primarySourceUrl(investorSource, "Bending Spoons")).toBe(investorSource);
    expect(primarySourceUrl(filingSource, "Airtable")).toBe(filingSource);
    expect(primarySourceUrl(source, "Airtable")).toBe(source);
  });

  test.each([
    ["http://www.airtable.com/newsroom/back-to-bases", "Airtable"],
    ["https://airtable.com.evil.example/newsroom/back-to-bases", "Airtable"],
    ["https://www.airtable.com/", "Airtable"],
    ["https://www.airtable.com/products/omni", "Airtable"],
    ["https://user:pass@www.airtable.com/newsroom/back-to-bases", "Airtable"],
    ["https://www.airtable.com:8443/newsroom/back-to-bases", "Airtable"],
    ["https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/index.htm", "Airtable"],
    ["https://evil.example/Archives/edgar/data/320193/000032019326000005/a8-kex991.htm", "Airtable"],
    [source, "Bending Spoons"],
  ])("rejects non-primary URL %s", (url, organization) => {
    expect(primarySourceUrl(url, organization)).toBeUndefined();
  });
});
