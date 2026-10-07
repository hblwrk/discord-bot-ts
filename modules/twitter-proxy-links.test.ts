import {describe, expect, test, vi} from "vitest";
import {createEventClient} from "./test-utils/discord-mocks.ts";
import {addTwitterLinkRewrites, getTwitterProxyLinks} from "./twitter-link-rewrite.ts";

const logger = vi.hoisted(() => ({log: vi.fn()}));
vi.mock("./logging.ts", () => ({getLogger: () => logger}));
vi.mock("./twitter-sanity.ts", () => ({createTwitterIntrospector: () => vi.fn().mockResolvedValue(undefined)}));

function proxyMessage(content: string) {
  const response = {edit: vi.fn().mockResolvedValue(undefined)};
  return {
    id: "proxy-message", author: {id: "123", bot: false}, webhookId: null as string | null,
    content, embeds: [{type: "video"}], delete: vi.fn().mockResolvedValue(undefined),
    reference: null as {messageId: string} | null, response,
    suppressEmbeds: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(response),
    channel: {send: vi.fn().mockResolvedValue(response)},
  };
}

describe("proxy post assessments", () => {
  test("extracts known proxy statuses, keeps modifiers and queries, and deduplicates by post ID", () => {
    expect(getTwitterProxyLinks("https://fixupx.com/a/status/123?s=20 https://vxtwitter.com/b/status/123/video/1 https://c.vxtwitter.com/a/status/456, <https://fxtwitter.com/a/status/789> https://fixvx.com/profile https://fixvx.com.evil.test/a/status/111 https://x.com/a/status/222"))
      .toEqual(["https://fixupx.com/a/status/123?s=20", "https://c.vxtwitter.com/a/status/456"]);
  });

  test.each([
    "x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com", "m.twitter.com", "www.x.com",
    "fxtwitter.com", "fixupx.com", "twittpr.com", "xfixup.com", "vxtwitter.com", "fixvx.com", "www.fixupx.com",
    "d.fxtwitter.com", "dl.fxtwitter.com", "t.fxtwitter.com", "i.fxtwitter.com", "g.fixupx.com", "m.fxtwitter.com", "o.fxtwitter.com",
    "c.vxtwitter.com", "c.fixvx.com",
  ])("reposts a link-only %s paste and edits its badge into that same message", async host => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge", description: "Reality check."});
    addTwitterLinkRewrites(client, inspect);
    const url = `https://${host}/a/status/123?s=20`;
    const raw = ["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com", "m.twitter.com", "www.x.com"].includes(host);
    const delivered = raw ? "https://fxtwitter.com/a/status/123" : url;
    const message = proxyMessage(`(${url}),`);
    message.reference = {messageId: "parent"};
    await getHandler("messageCreate")(message);
    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(message.channel.send).toHaveBeenCalledExactlyOnceWith({
      content: `From <@123>: ${delivered}`, allowedMentions: {parse: [], repliedUser: false},
      reply: {messageReference: "parent", failIfNotExists: false},
    });
    await vi.waitFor(() => {
      expect(message.response.edit).toHaveBeenCalledExactlyOnceWith({
        content: `From <@123>: ${delivered}\n-# Badge\n-# Reality check.`, allowedMentions: {parse: [], repliedUser: false},
      });
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(delivered);
    expect(inspect.mock.invocationCallOrder[0]).toBeGreaterThan(message.channel.send.mock.invocationCallOrder[0]!);
    await getHandler("messageUpdate")(undefined, message);
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("reposts immediately while a proxy assessment is pending", async () => {
    const {client, getHandler} = createEventClient();
    let finish: (value: {title: string}) => void = () => {};
    const pending = new Promise<{title: string}>(resolve => { finish = resolve; });
    addTwitterLinkRewrites(client, () => pending);
    const message = proxyMessage("https://fixvx.com/a/status/123");
    await getHandler("messageCreate")(message);
    expect(message.channel.send).toHaveBeenCalledExactlyOnceWith({
      content: "From <@123>: https://fixvx.com/a/status/123", allowedMentions: {parse: []},
    });
    expect(message.response.edit).not.toHaveBeenCalled();
    finish({title: "Late badge"});
    await vi.waitFor(() => { expect(message.response.edit).toHaveBeenCalledTimes(1); });
    expect(message.reply).not.toHaveBeenCalled();
  });

  test("combines raw/proxy pastes in order and deduplicates aliases by post ID", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge"});
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage("https://fixvx.com/b/status/456 https://x.com/a/status/123 https://fixupx.com/a/status/123");
    await getHandler("messageCreate")(message);
    const links = "https://fixvx.com/b/status/456\nhttps://fxtwitter.com/a/status/123";
    expect(message.channel.send).toHaveBeenCalledExactlyOnceWith({content: `From <@123>: ${links}`, allowedMentions: {parse: []}});
    await vi.waitFor(() => {
      expect(message.response.edit).toHaveBeenCalledExactlyOnceWith({
        content: `From <@123>: ${links}\n-# Link 1: Badge\n-# Link 2: Badge`, allowedMentions: {parse: [], repliedUser: false},
      });
    });
    expect(inspect.mock.calls.map(call => call[0])).toEqual(links.split("\n"));
    expect(message.reply).not.toHaveBeenCalled();
  });

  test("keeps a proxy modifier when its raw alias follows it", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue(undefined);
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage("https://g.fixupx.com/a/status/123?lang=de https://twitter.com/b/status/123");
    await getHandler("messageCreate")(message);
    expect(message.channel.send).toHaveBeenCalledExactlyOnceWith({content: "From <@123>: https://g.fixupx.com/a/status/123?lang=de", allowedMentions: {parse: []}});
    expect(inspect).toHaveBeenCalledExactlyOnceWith("https://g.fixupx.com/a/status/123?lang=de");
  });

  test("shares the four-post limit across raw and proxy links after deduplication", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge"});
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage("https://x.com/a/status/100 https://x.com/b/status/100 " + [101, 102, 103, 104].map(id => `https://fixvx.com/a/status/${id}`).join(" "));
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => { expect(inspect).toHaveBeenCalledTimes(4); });
    expect(inspect).toHaveBeenCalledWith("https://fixvx.com/a/status/103");
    expect(inspect).not.toHaveBeenCalledWith("https://fixvx.com/a/status/104");
  });

  test("keeps available badges in paste order when another assessment rejects", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue({title: "Second"});
    addTwitterLinkRewrites(client, inspect);
    const links = "https://fixvx.com/a/status/123\nhttps://fixupx.com/b/status/456";
    const message = proxyMessage(links);
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => {
      expect(message.response.edit).toHaveBeenCalledExactlyOnceWith({content: `From <@123>: ${links}\n-# Link 2: Second`, allowedMentions: {parse: [], repliedUser: false}});
    });
  });

  test("preserves surrounding text and the original proxy preview", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge"});
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage("look https://fixupx.com/a/status/123");
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => {
      expect(message.reply).toHaveBeenCalledExactlyOnceWith({content: "-# Badge\n-# Post: <https://fixupx.com/a/status/123>", allowedMentions: {parse: [], repliedUser: false}});
    });
    expect(message.delete).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
    expect(message.content).toBe("look https://fixupx.com/a/status/123");
  });

  test("keeps mixed messages with surrounding text and their previews", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge"});
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage("look https://x.com/a/status/123 https://fixupx.com/a/status/123 https://fixvx.com/b/status/456");
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => { expect(inspect).toHaveBeenCalledTimes(2); });
    expect(inspect).toHaveBeenCalledWith("https://fxtwitter.com/a/status/123");
    expect(inspect).toHaveBeenCalledWith("https://fixvx.com/b/status/456");
    expect(message.reply).toHaveBeenCalledWith({content: "https://fxtwitter.com/a/status/123", allowedMentions: {parse: [], repliedUser: false}});
    await getHandler("messageUpdate")(undefined, message);
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
  });

  test("falls back to a badge reply when deleting a proxy paste fails", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client, vi.fn().mockResolvedValue({title: "Badge"}));
    const message = proxyMessage("https://fixvx.com/a/status/123");
    message.delete.mockRejectedValue(new Error("permission denied"));
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => { expect(message.reply).toHaveBeenCalledTimes(1); });
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("handles failed badge delivery without changing the original text message", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client, vi.fn().mockResolvedValue({title: "Badge"}));
    const message = proxyMessage("look https://fixvx.com/a/status/123");
    message.reply.mockRejectedValue(new Error("permission denied"));
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => { expect(logger.log).toHaveBeenCalledWith("warn", "Twitter/X proxy badge reply failed; keeping the original link preview."); });
    expect(message.delete).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("does not start assessment or send another reply when reposting fails", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn();
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage("https://fixvx.com/a/status/123");
    message.channel.send.mockRejectedValue(new Error("send failed"));
    await getHandler("messageCreate")(message);
    expect(inspect).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith("error", expect.stringContaining("Error posting replacement Twitter/X message"));
  });

  test("keeps the replacement without another message when a badge edit fails", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client, vi.fn().mockResolvedValue({title: "Badge"}));
    const message = proxyMessage("https://fixvx.com/a/status/123");
    message.response.edit.mockRejectedValue(new Error("edit failed"));
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => { expect(logger.log).toHaveBeenCalledWith("warn", "Twitter/X badge update failed; keeping the converted link."); });
    expect(message.channel.send).toHaveBeenCalledTimes(1);
    expect(message.reply).not.toHaveBeenCalled();
  });

  test.each(["bot", "webhook", "suppressed", "profile", "unsupported"])("does not assess or repost %s proxy posts", async kind => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge"});
    addTwitterLinkRewrites(client, inspect);
    const message = proxyMessage(kind === "suppressed" ? "<https://fixvx.com/a/status/123>" : kind === "profile" ? "https://fixvx.com/a" : kind === "unsupported" ? "https://fixvx.com.evil.test/a/status/123" : "https://fixvx.com/a/status/123");
    if (kind === "bot") message.author.bot = true;
    if (kind === "webhook") message.webhookId = "hook";
    await getHandler("messageCreate")(message);
    expect(inspect).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
  });

  test.each(["<https://fixvx.com/b/status/456>", "https://example.com", "https://fixvx.com/profile"])("does not delete a proxy paste containing an unhandled link: %s", async other => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client, vi.fn().mockResolvedValue(undefined));
    const message = proxyMessage(`https://fixvx.com/a/status/123 ${other}`);
    await getHandler("messageCreate")(message);
    expect(message.delete).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
  });

  test("keeps the replacement when assessments are unavailable or cannot fit", async () => {
    for (const result of [undefined, {title: "Badge", description: "x".repeat(2_000)}]) {
      const {client, getHandler} = createEventClient();
      const inspect = vi.fn().mockResolvedValue(result);
      addTwitterLinkRewrites(client, inspect);
      const message = proxyMessage("https://fixvx.com/a/status/123");
      await getHandler("messageCreate")(message);
      await vi.waitFor(() => { expect(inspect).toHaveBeenCalledTimes(1); });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(message.reply).not.toHaveBeenCalled();
      expect(message.channel.send).toHaveBeenCalledTimes(1);
      expect(message.response.edit).not.toHaveBeenCalled();
    }
  });
});
