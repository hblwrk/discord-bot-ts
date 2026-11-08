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
    expect(isPotentialPrimaryStatement(post({text: "Airtable layoffs were reported today.", authorHandle: "trader"}))).toBe(true);
    expect(isPotentialPrimaryStatement(post({text: "Airtable revenue fell 20%.", authorHandle: "trader"}))).toBe(true);
    expect(isPotentialPrimaryStatement(post({text: "Airtable is laying off staff.", authorHandle: "Airtable"}))).toBe(true);
    expect(isPotentialPrimaryStatement(post({text: "Introducing Omni, shipping 30 improvements.", authorHandle: "Airtable"}))).toBe(true);
    expect(isPotentialPrimaryStatement(post({text: "We're excited about the future."}))).toBe(false);
    expect(isPotentialPrimaryStatement(post({quotedText: "Airtable laid off staff."}))).toBe(false);
    expect(isPotentialPrimaryStatement(post({communityNote: {text: "Disputed", sourceUrls: []}}))).toBe(false);
  });

  test("attributes a post to a fetched, search-grounded company newsroom page", async () => {
    const {result, callFn, getWithRetryFn} = research();
    expect(await result).toEqual({organization: "Airtable", source});
    expect(callFn.mock.calls[0]?.[0]).toContain("SEC EDGAR exhibits");
    expect(callFn.mock.calls[0]?.[0]).toContain("EQS ad-hoc or Euronext company announcements");
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

  test("attributes a third-party finance report to the issuer without endorsing the poster", async () => {
    const thirdParty = post({authorHandle: "trader", text: "Airtable layoffs affect a large part of the team; 30 improvements shipped in 3 weeks."});
    expect(await research({post: thirdParty}).result).toEqual({organization: "Airtable", source});
  });

  test("requires an explicit issuer-symbol pairing for a ticker-only report", async () => {
    const tickerPost = post({authorHandle: "trader", text: "$ATBL layoffs affect a large part of the team; 30 improvements shipped in 3 weeks."});
    expect(await research({post: tickerPost, html: `${page}<p>Ticker: ATBL</p>`}).result)
      .toEqual({organization: "Airtable", source});
    expect(await research({post: {...tickerPost, text: tickerPost.text.replace("$ATBL", "$atbl")},
      html: `${page}<p>Ticker: ATBL</p>`}).result).toEqual({organization: "Airtable", source});
    expect(await research({post: tickerPost}).result).toBeUndefined();
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

  test("accepts a linked recognised report while still requiring issuer evidence", async () => {
    expect(await research({post: post({externalLinks: ["https://www.bloomberg.com/news/articles/airtable-report"]})}).result)
      .toEqual({organization: "Airtable", source});
  });

  test("accepts a matching investor-relations release or SEC filing exhibit", async () => {
    const investorSource = "https://investors.bendingspoons.com/newsroom/airtable-back-to-bases";
    const filingSource = "https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/a8-kex991.htm";
    expect(primarySourceUrl(investorSource, "Bending Spoons")).toBe(investorSource);
    expect(primarySourceUrl(filingSource, "Airtable")).toBe(filingSource);
    expect(primarySourceUrl(source, "Airtable")).toBe(source);
    expect(primarySourceUrl("https://www.eqs-news.com/news/ad-hoc/airtable-announces-restructuring/a4bad0de-1e35-4699-ae43-7ff8fb1f53e9", "Airtable"))
      .toBe("https://www.eqs-news.com/news/ad-hoc/airtable-announces-restructuring/a4bad0de-1e35-4699-ae43-7ff8fb1f53e9");
    expect(primarySourceUrl("https://live.euronext.com/en/products/equities/company-news/2026-10-13-airtable-announces-results", "Airtable"))
      .toBe("https://live.euronext.com/en/products/equities/company-news/2026-10-13-airtable-announces-results");
  });

  test("requires fetched issuer text even for a searched distribution notice", async () => {
    const disclosure = "https://www.eqs-news.com/news/ad-hoc/airtable-announces-restructuring/a4bad0de-1e35-4699-ae43-7ff8fb1f53e9";
    const answer = {matched: true, organization: "Airtable", sourceUrl: disclosure, evidenceQuote: quote};
    expect(await research({answer, searched: [disclosure]}).result).toEqual({organization: "Airtable", source: disclosure});
    expect(await research({answer, searched: [disclosure], html: "Airtable announced a different event."}).result).toBeUndefined();
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
    ["https://www.eqs-news.com/news/ad-hoc/fake-headline", "Airtable"],
    ["https://live.euronext.com/en/products/equities/company-news/airtable-announces-results", "Airtable"],
    [source, "Bending Spoons"],
  ])("rejects non-primary URL %s", (url, organization) => {
    expect(primarySourceUrl(url, organization)).toBeUndefined();
  });
});
