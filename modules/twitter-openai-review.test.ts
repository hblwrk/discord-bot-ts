import {beforeEach, describe, expect, test, vi} from "vitest";
import {clearAiProviderState} from "./ai-provider.ts";
import {crossCheckTwitterPost} from "./twitter-sanity-check.ts";
import {createTwitterIntrospector} from "./twitter-sanity.ts";
import {addTwitterLinkRewrites} from "./twitter-link-rewrite.ts";
import {createEventClient} from "./test-utils/discord-mocks.ts";
import {twitterProxyHosts} from "./test-utils/twitter-proxy-hosts.ts";

const logger = vi.hoisted(() => ({log: vi.fn()}));
vi.mock("./logging.ts", () => ({getLogger: () => logger}));

// This fixture tests response transport/validation, not the accuracy of the provider's claim.
const sentence = "Spanish police escorted migrants away from Ceuta during a cleanup operation.";
const sources = [
  "https://apnews.com/article/fe8e003171d5ce019d978ed9eaea49ed",
  "https://apnews.com/article/9960b15a7cf31a0592b09ac47a8eac3f",
];
const reply = {verdict: "supported", realityCheck: sentence, sourceUrls: sources};
const post = {text: "A major cleanup is underway in Ceuta. It was about time. Send them all back.",
  quotedText: "Ceuta, day 64: it seems the Spanish police are clearing out the criminals. Good news, every now and then.",
  media: ["1 Video(s); content not inspected"], externalLinks: [], authorJoined: "", defaultAvatar: false, authorWebsite: ""};

function searchCall() {
  return {type: "web_search_call", status: "completed", action: {
    type: "search", sources: sources.map(url => ({type: "url", url})),
  }};
}

function dependencies(searchItems: unknown[] = [searchCall()]) {
  return {logger,
    readSecretFn: (name: string) => name === "ai_provider" ? "openai" : name === "openai_api_key" ? "test-key" : "",
    postWithRetryFn: vi.fn().mockResolvedValue({data: {output: [
      ...searchItems,
      {type: "message", status: "completed", content: [{type: "output_text", text: JSON.stringify(reply), annotations: []}]},
    ]}}),
  };
}

describe("Twitter review with OpenAI search sources", () => {
  beforeEach(() => { clearAiProviderState(); vi.clearAllMocks(); });

  test("accepts the reported JSON result with searched sources and no inline annotations", async () => {
    const deps = dependencies();
    expect(await crossCheckTwitterPost(post, deps)).toEqual({verdict: "supported", sentence, sources: [sources[0]]});
    expect(deps.postWithRetryFn).toHaveBeenCalledExactlyOnceWith("https://api.openai.com/v1/responses",
      expect.objectContaining({include: ["web_search_call.action.sources"]}), expect.anything(), expect.anything());
  });

  test.each([
    [],
    [{...searchCall(), status: "failed"}],
    [{...searchCall(), status: "in_progress"}],
    [{...searchCall(), type: "message"}],
    [{...searchCall(), action: {...searchCall().action, type: "open_page"}}],
    [{...searchCall(), action: {type: "search", sources: [{type: "url", url: "https://apnews.com/article/unrelated"}]}}],
    [{...searchCall(), action: {type: "search", sources: [{type: "other", url: sources[0]}, {type: "url"}, {}]}}],
  ].map(searchItems => ({searchItems})))("silently rejects the model-written sources without valid matching search provenance %#", async ({searchItems}) => {
    const deps = dependencies(searchItems);
    expect(await crossCheckTwitterPost(post, deps)).toBeUndefined();
    expect(logger.log).toHaveBeenCalledExactlyOnceWith("debug", "Twitter/X web cross-check skipped: no accepted source in provider search metadata.");
  });

  test.each(["x.com", ...twitterProxyHosts])("delivers the completed review for %s without replacing native embeds", async host => {
    const deps = dependencies();
    const getWithRetryFn = vi.fn().mockResolvedValue({data: {status: {id: "2106661915741114638", text: post.text,
      quote: {text: post.quotedText}, media: {videos: [{}]},
    }}});
    const introspect = createTwitterIntrospector({...deps,
      getWithRetryFn,
    });
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client, introspect);
    const response = {edit: vi.fn().mockResolvedValue(undefined)};
    const url = `https://${host}/RadioGenoa/status/2106661915741114638?s=20`;
    const deliveredUrl = host === "x.com" ? "https://fxtwitter.com/RadioGenoa/status/2106661915741114638" : url;
    const message = {id: "reported-review", author: {id: "123"}, content: url,
      embeds: [{type: "video"}], channel: {send: vi.fn().mockResolvedValue(response)},
      reply: vi.fn().mockResolvedValue(response), delete: vi.fn().mockResolvedValue(undefined), suppressEmbeds: vi.fn().mockResolvedValue(undefined),
    };
    await getHandler("messageCreate")(message);
    const delivered = response.edit;
    await vi.waitFor(() => {
      expect(delivered.mock.lastCall?.[0]?.content).toBe(`From <@123>: ${deliveredUrl}\n-# 🟢 [source](<${sources[0]}>)`);
    });
    expect(delivered.mock.calls[0]?.[0]?.content).toBe(`From <@123>: ${deliveredUrl}\n-# 🟡`);
    const options = delivered.mock.lastCall?.[0];
    expect(options.content).toBe(`From <@123>: ${deliveredUrl}\n-# 🟢 [source](<${sources[0]}>)`);
    expect(options).not.toHaveProperty("embeds");
    expect(options).not.toHaveProperty("flags");
    expect(getWithRetryFn).toHaveBeenCalledExactlyOnceWith("https://api.fxtwitter.com/2/status/2106661915741114638",
      expect.anything(), expect.anything());
    expect(deps.postWithRetryFn).toHaveBeenCalledTimes(1);
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
    expect(message.channel.send).toHaveBeenCalledTimes(1);
    expect(message.reply).not.toHaveBeenCalled();
  });
});
