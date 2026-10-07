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

  test.each(["x.com", "fixvx.com"])("%s retains normal link delivery when the review is disabled or missing credentials", async host => {
    for (const configured of ["none", "gemini", "openai"]) {
      const {client, getHandler} = createEventClient();
      const getWithRetryFn = vi.fn();
      const introspect = createTwitterIntrospector({logger, getWithRetryFn,
        readSecretFn: name => name === "ai_provider" ? configured : "",
      });
      addTwitterLinkRewrites(client, introspect);
      const post = message(`https://${host}/a/status/123`);
      await getHandler("messageCreate")(post);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(getWithRetryFn).not.toHaveBeenCalled();
      expect(post.response.edit).not.toHaveBeenCalled();
      expect(post.channel.send.mock.calls).toEqual(host === "x.com"
        ? [[{content: "From <@123>: https://fxtwitter.com/a/status/123", allowedMentions: {parse: []}}]] : []);
      expect(post.reply).not.toHaveBeenCalled();
      expect(post.delete).toHaveBeenCalledTimes(host === "x.com" ? 1 : 0);
      expect(post.suppressEmbeds).toHaveBeenCalledTimes(host === "x.com" ? 1 : 0);
      expect(post.content).toBe(`https://${host}/a/status/123`);
    }
  });

  test.each(["x.com", "fixvx.com"].flatMap(host => ["The council approved the plan yesterday.", "They are hiding this from you"].map(text => [host, text] as const)))(
    "%s posts no badge or error when AI cannot review: %s", async (host, text) => {
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
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(aiCall).toHaveBeenCalledTimes(1);
        expect(post.response.edit).not.toHaveBeenCalled();
        expect(post.reply).not.toHaveBeenCalled();
        expect(post.channel.send).toHaveBeenCalledTimes(host === "x.com" ? 1 : 0);
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
    expect(post.response.edit).not.toHaveBeenCalled();
    expect(post.reply).not.toHaveBeenCalled();
    expect(post.channel.send).toHaveBeenCalledTimes(host === "x.com" ? 1 : 0);
    expect(post.embeds).toEqual([{type: "video"}]);
    finish({verdict: "contradicted", sentence: "Reporting contradicts the council approval claim.", sources: ["https://reuters.com/world/report"]});
    const delivered = host === "x.com" ? post.response.edit : post.reply;
    await vi.waitFor(() => { expect(delivered).toHaveBeenCalledTimes(1); });
    const options = delivered.mock.calls[0]?.[0];
    expect(options.content).toContain("**10% wording spice**");
    expect(options.content).toContain("**AI web check: contradicted (review sources)**");
    expect(options.content).toContain("Source 1: <https://reuters.com/world/report>");
    expect(options.content).not.toContain("skipped");
    expect(options).not.toHaveProperty("embeds");
    expect(options).not.toHaveProperty("flags");
    expect(post.suppressEmbeds).toHaveBeenCalledTimes(host === "x.com" ? 1 : 0);
  });
});
