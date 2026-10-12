import {beforeEach, describe, expect, test, vi} from "vitest";
import {createEventClient} from "./test-utils/discord-mocks.ts";
import {addTwitterLinkRewrites} from "./twitter-link-rewrite.ts";
import {createTwitterIntrospector} from "./twitter-sanity.ts";
import {clearAiProviderState} from "./ai-provider.ts";
import {crossCheckTwitterPost, type TwitterRealityCheck} from "./twitter-sanity-check.ts";

const logger = vi.hoisted(() => ({log: vi.fn()}));
vi.mock("./logging.ts", () => ({getLogger: () => logger}));

function message(content: string) {
  const response = {edit: vi.fn()};
  return {
    id: "silent-review", author: {id: "123"}, content,
    embeds: [{type: "video"}], response,
    channel: {send: vi.fn().mockResolvedValue(response)},
    reply: vi.fn().mockResolvedValue(response),
    delete: vi.fn().mockResolvedValue(undefined), suppressEmbeds: vi.fn().mockResolvedValue(undefined),
  };
}

describe("silent Twitter review delivery", () => {
  beforeEach(() => { clearAiProviderState(); });

  test.each(["x.com", "fixvx.com"])("%s adds a yellow badge when the review is disabled or missing credentials", async host => {
    for (const configured of ["none", "gemini", "openai"]) {
      const {client, getHandler} = createEventClient();
      const getWithRetryFn = vi.fn().mockResolvedValue({data: {status: {
        id: "123", text: "The council approved the plan yesterday.",
      }}});
      const introspect = createTwitterIntrospector({logger, getWithRetryFn,
        readSecretFn: name => name === "ai_provider" ? configured : "",
      });
      addTwitterLinkRewrites(client, introspect);
      const post = message(`https://${host}/a/status/123`);
      await getHandler("messageCreate")(post);
      await vi.waitFor(() => { expect(post.response.edit).toHaveBeenCalledTimes(1); });
      expect(getWithRetryFn).toHaveBeenCalledTimes(1);
      expect(post.response.edit).toHaveBeenCalledExactlyOnceWith({
        content: `From <@123>: https://${host === "x.com" ? "fxtwitter.com" : host}/a/status/123\n-# 🟡 Claim unverified`,
        allowedMentions: {parse: [], repliedUser: false},
      });
      expect(post.channel.send.mock.calls).toEqual([[{content: `From <@123>: https://${host === "x.com" ? "fxtwitter.com" : host}/a/status/123`, allowedMentions: {parse: []}}]]);
      expect(post.reply).not.toHaveBeenCalled();
      expect(post.delete).toHaveBeenCalledTimes(1);
      expect(post.suppressEmbeds).not.toHaveBeenCalled();
      expect(post.content).toBe(`https://${host}/a/status/123`);
    }
  });

  test.each(["x.com", "fixvx.com"].flatMap(host => ["The council approved the plan yesterday.", "They are hiding this from you"].map(text => [host, text] as const)))(
    "%s posts an unverified indicator without a source when AI cannot review: %s", async (host, text) => {
      for (const outcome of ["throw", "timeout", "null", "unverified"]) {
        const {client, getHandler} = createEventClient();
        const aiCall = vi.fn().mockResolvedValue(outcome === "unverified" ? JSON.stringify({verdict: "unverified"}) : null);
        if (outcome === "throw" || outcome === "timeout") aiCall.mockRejectedValueOnce(new Error(outcome));
        const introspect = createTwitterIntrospector({logger, aiAvailableFn: () => true,
          getWithRetryFn: vi.fn().mockResolvedValue({data: {status: {id: "123", text}}}),
          crossCheckFn: (post, deps) => crossCheckTwitterPost(post, deps, aiCall),
        });
        addTwitterLinkRewrites(client, introspect);
        const post = message(`https://${host}/a/status/123`);
        await getHandler("messageCreate")(post);
        const status = text === "They are hiding this from you" ? "Wording caution" : "Claim unverified";
        await vi.waitFor(() => {
          expect(post.response.edit.mock.lastCall?.[0]?.content).toBe(
            `From <@123>: https://${host === "x.com" ? "fxtwitter.com" : host}/a/status/123\n-# 🟡 ${status}`,
          );
        });
        expect(aiCall).toHaveBeenCalledTimes(1);
        expect(post.response.edit).toHaveBeenCalledTimes(status === "Wording caution" ? 1 : 2);
        expect(post.reply).not.toHaveBeenCalled();
        expect(post.channel.send).toHaveBeenCalledTimes(1);
      }
    },
  );

  test.each(["x.com", "fixvx.com"])("%s delivers the preview immediately while a calm post's AI check is pending", async host => {
    const {client, getHandler} = createEventClient();
    let finish: (value: TwitterRealityCheck) => void = () => {};
    const review = new Promise<TwitterRealityCheck>(resolve => { finish = resolve; });
    const crossCheckFn = vi.fn(() => review);
    const introspect = createTwitterIntrospector({logger, aiAvailableFn: () => true, crossCheckFn,
      getWithRetryFn: vi.fn().mockResolvedValue({data: {status: {id: "123", text: "The council approved the plan yesterday."}}}),
    });
    addTwitterLinkRewrites(client, introspect);
    const post = message(`https://${host}/a/status/123`);
    await getHandler("messageCreate")(post);
    await vi.waitFor(() => { expect(crossCheckFn).toHaveBeenCalledTimes(1); });
    await vi.waitFor(() => {
      expect(post.response.edit).toHaveBeenCalledExactlyOnceWith({
        content: `From <@123>: https://${host === "x.com" ? "fxtwitter.com" : host}/a/status/123\n-# 🟡 Checking claim`,
        allowedMentions: {parse: [], repliedUser: false},
      });
    });
    expect(post.reply).not.toHaveBeenCalled();
    expect(post.channel.send).toHaveBeenCalledTimes(1);
    expect(post.embeds).toEqual([{type: "video"}]);
    finish({verdict: "contradicted", sentence: "Reporting contradicts the council approval claim.", sources: ["https://reuters.com/world/report"]});
    const delivered = post.response.edit;
    await vi.waitFor(() => { expect(delivered).toHaveBeenCalledTimes(2); });
    const options = delivered.mock.calls[1]?.[0];
    expect(options.content).toContain("-# 🟡 Claim contradicted [source]");
    expect(options.content).not.toContain("Reporting contradicts the council approval claim.");
    expect(options.content).toContain("[source](<https://reuters.com/world/report>)");
    expect(options.content).not.toContain("skipped");
    expect(options).not.toHaveProperty("embeds");
    expect(options).not.toHaveProperty("flags");
    expect(post.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("shows a yellow indicator for a chart-led proxy post without a verifiable fact source", async () => {
    const id = "2109614293801201700";
    const url = `https://fxtwitter.com/Polityka_wSieci/status/${id}`;
    const {client, getHandler} = createEventClient();
    const getWithRetryFn = vi.fn().mockResolvedValue({data: {status: {
      id, text: "Our monitoring shows no drop in the network's activity after infrastructure damage.",
      media: {photos: [{}]}, quote: {text: "The network remained active."},
    }}});
    const crossCheckFn = vi.fn().mockResolvedValue(undefined);
    addTwitterLinkRewrites(client, createTwitterIntrospector({logger, aiAvailableFn: () => true, getWithRetryFn, crossCheckFn}));
    const post = message(url);
    await getHandler("messageCreate")(post);
    await vi.waitFor(() => {
      expect(post.response.edit.mock.lastCall?.[0]?.content).toBe(`From <@123>: ${url}\n-# 🟡 Claim unverified`);
    });
    expect(getWithRetryFn).toHaveBeenCalledExactlyOnceWith(`https://api.fxtwitter.com/2/status/${id}`,
      expect.anything(), expect.anything());
    expect(crossCheckFn).toHaveBeenCalledTimes(1);
    expect(post.response.edit).toHaveBeenCalledTimes(2);
  });
});
