import {describe, expect, test, vi} from "vitest";
import {createEventClient} from "./test-utils/discord-mocks.ts";
import {addTwitterLinkRewrites, getTwitterProxyLinks} from "./twitter-link-rewrite.ts";

const logger = vi.hoisted(() => ({log: vi.fn()}));
vi.mock("./logging.ts", () => ({getLogger: () => logger}));
vi.mock("./twitter-sanity.ts", () => ({createTwitterIntrospector: () => vi.fn().mockResolvedValue(undefined)}));

function proxyMessage(content: string) {
  return {
    id: "proxy-message", author: {id: "123", bot: false}, webhookId: null as string | null,
    content, embeds: [{type: "video"}], delete: vi.fn().mockResolvedValue(undefined),
    suppressEmbeds: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({edit: vi.fn().mockResolvedValue(undefined)}),
    channel: {send: vi.fn()},
  };
}

describe("proxy post assessments", () => {
  test("extracts known proxy statuses, keeps modifiers and queries, and deduplicates by post ID", () => {
    expect(getTwitterProxyLinks("https://fixupx.com/a/status/123?s=20 https://vxtwitter.com/b/status/123/video/1 https://c.vxtwitter.com/a/status/456, <https://fxtwitter.com/a/status/789> https://fixvx.com/profile https://fixvx.com.evil.test/a/status/111 https://x.com/a/status/222"))
      .toEqual(["https://fixupx.com/a/status/123?s=20", "https://c.vxtwitter.com/a/status/456"]);
  });

  test.each(["fxtwitter.com", "fixupx.com", "twittpr.com", "xfixup.com", "vxtwitter.com", "fixvx.com", "c.vxtwitter.com", "g.fxtwitter.com"])("checks %s and replies with compact text while preserving the original preview", async host => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge", description: "Reality check."});
    addTwitterLinkRewrites(client, inspect);
    const url = `https://${host}/a/status/123?s=20`;
    const message = proxyMessage(url);
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => {
      expect(message.reply).toHaveBeenCalledExactlyOnceWith({content: `-# Badge\n-# Reality check.\n-# Post: <${url}>`, allowedMentions: {parse: [], repliedUser: false}});
    });
    await getHandler("messageUpdate")(undefined, message);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(url);
    expect(message.content).toBe(url);
    expect(message.embeds).toEqual([{type: "video"}]);
    expect(message.delete).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("finishes handling a proxy paste while assessment is pending", async () => {
    const {client, getHandler} = createEventClient();
    let finish: (value: {title: string}) => void = () => {};
    const pending = new Promise<{title: string}>(resolve => { finish = resolve; });
    addTwitterLinkRewrites(client, () => pending);
    const message = proxyMessage("https://fixvx.com/a/status/123");
    await getHandler("messageCreate")(message);
    expect(message.reply).not.toHaveBeenCalled();
    finish({title: "Late badge"});
    await vi.waitFor(() => { expect(message.reply).toHaveBeenCalledTimes(1); });
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("checks distinct proxies alongside raw X links without suppressing their previews", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge"});
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage("https://x.com/a/status/123 https://fixupx.com/a/status/123 https://fixvx.com/b/status/456");
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => { expect(inspect).toHaveBeenCalledTimes(2); });
    expect(inspect).toHaveBeenCalledWith("https://fxtwitter.com/a/status/123");
    expect(inspect).toHaveBeenCalledWith("https://fixvx.com/b/status/456");
    expect(message.reply).toHaveBeenCalledWith({content: "https://fxtwitter.com/a/status/123", allowedMentions: {parse: [], repliedUser: false}});
    await getHandler("messageUpdate")(undefined, message);
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
  });

  test("converts a mixed paste before its proxy assessment finishes", async () => {
    const {client, getHandler} = createEventClient();
    let finish: (value: {title: string}) => void = () => {};
    const pending = new Promise<{title: string}>(resolve => { finish = resolve; });
    addTwitterLinkRewrites(client, link => new URL(link).hostname === "fixvx.com" ? pending : Promise.resolve(undefined));
    const message = proxyMessage("https://x.com/a/status/123 https://fixvx.com/b/status/456");
    await getHandler("messageCreate")(message);
    expect(message.reply).toHaveBeenCalledExactlyOnceWith({content: "https://fxtwitter.com/a/status/123", allowedMentions: {parse: [], repliedUser: false}});
    finish({title: "Late badge"});
    await vi.waitFor(() => { expect(message.reply).toHaveBeenCalledTimes(2); });
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("bounds assessment calls even when converted aliases share an ID", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge"});
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage("https://x.com/a/status/100 https://x.com/b/status/100 " + [101, 102, 103, 104].map(id => `https://fixvx.com/a/status/${id}`).join(" "));
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => { expect(inspect).toHaveBeenCalledTimes(4); });
    expect(inspect).not.toHaveBeenCalledWith("https://fixvx.com/a/status/103");
  });

  test("shares the four-post limit across converted and existing proxy links", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge"});
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage("https://x.com/a/status/100 " + [101, 102, 103, 104, 105].map(id => `https://fixvx.com/a/status/${id}`).join(" "));
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => { expect(inspect).toHaveBeenCalledTimes(4); });
    expect(inspect).not.toHaveBeenCalledWith("https://fixvx.com/a/status/104");
    expect(inspect).not.toHaveBeenCalledWith("https://fixvx.com/a/status/105");
  });

  test("keeps available badges in paste order when another proxy assessment rejects", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue({title: "Second"});
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage("https://fixvx.com/a/status/123 https://fixupx.com/b/status/456");
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => {
      expect(message.reply).toHaveBeenCalledExactlyOnceWith({content: "-# Link 2: Second\n-# Post: <https://fixupx.com/b/status/456>", allowedMentions: {parse: [], repliedUser: false}});
    });
  });

  test("handles failed badge delivery without changing the original", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client, vi.fn().mockResolvedValue({title: "Badge"}));
    const message = proxyMessage("https://fixvx.com/a/status/123");
    message.reply.mockRejectedValue(new Error("permission denied"));
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => { expect(logger.log).toHaveBeenCalledWith("warn", "Twitter/X proxy badge reply failed; keeping the original link preview."); });
    expect(message.delete).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test.each(["bot", "webhook", "suppressed", "profile", "unsupported"])("does not assess %s proxy posts", async kind => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge"});
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage(kind === "suppressed" ? "<https://fixvx.com/a/status/123>" : kind === "profile" ? "https://fixvx.com/a" : kind === "unsupported" ? "https://fixvx.com.evil.test/a/status/123" : "https://fixvx.com/a/status/123");
    if (kind === "bot") message.author.bot = true;
    if (kind === "webhook") message.webhookId = "hook";
    await getHandler("messageCreate")(message);
    expect(inspect).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
  });

  test("sends no empty reply when assessments are unavailable or cannot fit", async () => {
    for (const result of [undefined, {title: "Badge", description: "x".repeat(2_000)}]) {
      const {client, getHandler} = createEventClient();
      const inspect = vi.fn().mockResolvedValue(result);
      addTwitterLinkRewrites(client, inspect);
      const message = proxyMessage("https://fixvx.com/a/status/123");
      await getHandler("messageCreate")(message);
      await vi.waitFor(() => { expect(inspect).toHaveBeenCalledTimes(1); });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(message.reply).not.toHaveBeenCalled();
    }
  });
});
