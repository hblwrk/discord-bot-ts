import {beforeEach, describe, expect, test, vi} from "vitest";
import {createEventClient} from "./test-utils/discord-mocks.ts";
import {
  addTwitterLinkRewrites,
  getFixedTwitterLinks,
} from "./twitter-link-rewrite.ts";

const loggerMock = vi.hoisted(() => ({
  log: vi.fn(),
}));

vi.mock("./logging.ts", () => ({
  getLogger: () => loggerMock,
}));

vi.mock("./twitter-sanity.ts", () => ({
  createTwitterIntrospector: () => vi.fn().mockResolvedValue(undefined),
}));

type TwitterTestMessage = {
  author?: {
    bot?: boolean;
    id?: string;
  };
  channel: {
    send: ReturnType<typeof vi.fn>;
  };
  content: string;
  delete: ReturnType<typeof vi.fn>;
  embeds: unknown[];
  id: string;
  reference?: {
    messageId?: string;
  } | null;
  reply: ReturnType<typeof vi.fn>;
  response: {edit: ReturnType<typeof vi.fn>};
  suppressEmbeds: ReturnType<typeof vi.fn>;
  webhookId?: string | null;
};

let nextMessageId = 0;

function createTwitterMessage(content: string): TwitterTestMessage {
  nextMessageId += 1;
  const response = {edit: vi.fn().mockResolvedValue(undefined)};
  return {
    author: {id: `author-${nextMessageId}`},
    channel: {
      send: vi.fn().mockResolvedValue(response),
    },
    content,
    delete: vi.fn().mockResolvedValue(undefined),
    embeds: [],
    id: `message-${nextMessageId}`,
    reply: vi.fn().mockResolvedValue(response),
    response,
    suppressEmbeds: vi.fn().mockResolvedValue(undefined),
  };
}

describe("getFixedTwitterLinks", () => {
  test("rewrites Twitter and X links to clean fxtwitter URLs", () => {
    expect(getFixedTwitterLinks(
      "Watch https://x.com/example/status/123?s=20#anchor and https://twitter.com/example/status/456?ref=home.",
    )).toEqual([
      "https://fxtwitter.com/example/status/123",
      "https://fxtwitter.com/example/status/456",
    ]);
  });

  test("supports mobile and www hosts", () => {
    expect(getFixedTwitterLinks(
      "https://mobile.twitter.com/example/status/123 https://www.x.com/example/status/456",
    )).toEqual([
      "https://fxtwitter.com/example/status/123",
      "https://fxtwitter.com/example/status/456",
    ]);
  });

  test("ignores duplicate, non-twitter, existing fxtwitter, and bare host links", () => {
    expect(getFixedTwitterLinks(
      "https://x.com/example/status/123 https://x.com/example/status/123 https://fxtwitter.com/example/status/456 https://example.com https://x.com",
    )).toEqual([
      "https://fxtwitter.com/example/status/123",
    ]);
  });

  test("trims common trailing punctuation around links", () => {
    expect(getFixedTwitterLinks(
      "tweet (https://x.com/example/status/123), and https://twitter.com/example/status/456!",
    )).toEqual([
      "https://fxtwitter.com/example/status/123",
      "https://fxtwitter.com/example/status/456",
    ]);
  });

  test("ignores links enclosed in Discord embed suppression brackets", () => {
    expect(getFixedTwitterLinks(
      "<https://x.com/example/status/123>! <https://twitter.com/example/status/456?s=20> https://x.com/example/status/789",
    )).toEqual([
      "https://fxtwitter.com/example/status/789",
    ]);
  });
});

describe("addTwitterLinkRewrites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("edits ordered badges into the replacement and preserves credit/reply context", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn((link: string) => Promise.resolve({title: link.endsWith("123") ? "First badge" : "Second badge"}));
    addTwitterLinkRewrites(client, inspect);
    const message = createTwitterMessage("https://x.com/a/status/123 https://twitter.com/b/status/456");
    message.reference = {messageId: "parent"};
    await getHandler("messageCreate")(message);
    expect(message.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: `From <@${message.author?.id}>: https://fxtwitter.com/a/status/123\nhttps://fxtwitter.com/b/status/456`,
      reply: {messageReference: "parent", failIfNotExists: false},
      allowedMentions: {parse: [], repliedUser: false},
    }));
    await vi.waitFor(() => {
      expect(message.response.edit).toHaveBeenCalledExactlyOnceWith({
        content: `From <@${message.author?.id}>: https://fxtwitter.com/a/status/123\nhttps://fxtwitter.com/b/status/456\n-# Link 1: First badge\n-# Link 2: Second badge`,
        allowedMentions: {parse: [], repliedUser: false},
      });
    });
  });

  test("attaches a badge to mixed-content replies and deletion fallbacks", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client, vi.fn().mockResolvedValue({title: "Caution"}));
    const mixed = createTwitterMessage("look https://x.com/a/status/123");
    await getHandler("messageCreate")(mixed);
    const only = createTwitterMessage("https://x.com/a/status/123");
    only.delete.mockRejectedValue(new Error("permission"));
    await getHandler("messageCreate")(only);
    for (const message of [mixed, only]) {
      expect(message.reply).toHaveBeenCalledWith({content: "https://fxtwitter.com/a/status/123", allowedMentions: {parse: [], repliedUser: false}});
      await vi.waitFor(() => {
        expect(message.response.edit).toHaveBeenCalledWith({content: "https://fxtwitter.com/a/status/123\n-# Caution", allowedMentions: {parse: [], repliedUser: false}});
      });
    }
  });

  test("retains link order when metadata completes in reverse order", async () => {
    const {client, getHandler} = createEventClient();
    let finishFirst: (value: {title: string}) => void = () => {};
    const first = new Promise<{title: string}>(resolve => { finishFirst = resolve; });
    addTwitterLinkRewrites(client, link => link.endsWith("123") ? first : Promise.resolve({title: "Second"}));
    const message = createTwitterMessage("https://x.com/a/status/123 https://x.com/b/status/456");
    const pending = getHandler("messageCreate")(message);
    await Promise.resolve();
    finishFirst({title: "First"});
    await pending;
    await vi.waitFor(() => {
      expect(message.response.edit).toHaveBeenCalledExactlyOnceWith({content: `From <@${message.author?.id}>: https://fxtwitter.com/a/status/123\nhttps://fxtwitter.com/b/status/456\n-# Link 1: First\n-# Link 2: Second`, allowedMentions: {parse: [], repliedUser: false}});
    });
  });

  test("keeps the converted post's native video preview when appending an unavailable badge", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client, vi.fn().mockResolvedValue({
      title: "⚪ Sanity Rating unavailable",
      description: "The post text is unavailable, so its claims, media context and bot activity remain unverified.",
    }));
    const message = createTwitterMessage("https://x.com/RadioGenoa/status/2106661915741114638");
    const nativePreview = {type: "video", url: "https://fxtwitter.com/RadioGenoa/status/2106661915741114638", video: {url: "https://video.twimg.com/example.mp4"}};
    let previews = [nativePreview];
    message.response.edit.mockImplementation(async (payload: {embeds?: typeof previews}) => {
      if (payload.embeds) previews = payload.embeds;
    });
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => {
      expect(message.response.edit).toHaveBeenCalledExactlyOnceWith({
        content: `From <@${message.author?.id}>: https://fxtwitter.com/RadioGenoa/status/2106661915741114638\n-# ⚪ Sanity Rating unavailable\n-# The post text is unavailable, so its claims, media context and bot activity remain unverified.`,
        allowedMentions: {parse: [], repliedUser: false},
      });
    });
    expect(previews).toEqual([nativePreview]);
  });

  test("tracks original mixed-content embeds while the badge is pending", async () => {
    const {client, getHandler} = createEventClient();
    let finish: (value: undefined) => void = () => {};
    const inspection = new Promise<undefined>(resolve => { finish = resolve; });
    addTwitterLinkRewrites(client, () => inspection);
    const message = createTwitterMessage("look https://x.com/a/status/123");
    const pending = getHandler("messageCreate")(message);
    await pending;
    message.embeds = [{}];
    await getHandler("messageUpdate")(undefined, message);
    expect(message.suppressEmbeds).toHaveBeenCalledWith(true);
    finish(undefined);
    expect(message.reply.mock.calls.length + message.channel.send.mock.calls.length).toBe(1);
  });

  test.each([
    {name: "repost", prefix: "", deleteFails: false, replies: 0},
    {name: "mixed-content reply", prefix: "look ", deleteFails: false, replies: 1},
    {name: "deletion fallback", prefix: "", deleteFails: true, replies: 1},
  ])("delivers $name and finishes handling before slow assessment resolves", async ({prefix, deleteFails, replies}) => {
    const {client, getHandler} = createEventClient();
    let finish: (value: {title: string}) => void = () => {};
    const inspection = new Promise<{title: string}>(resolve => { finish = resolve; });
    const inspect = vi.fn(() => inspection);
    addTwitterLinkRewrites(client, inspect);
    const message = createTwitterMessage(`${prefix}https://x.com/a/status/123`);
    message.reference = {messageId: "parent"};
    if (deleteFails) {
      message.delete.mockRejectedValue(new Error("permission"));
    }
    const completed = vi.fn();
    const pending = Promise.resolve(getHandler("messageCreate")(message)).then(completed);
    try {
      await vi.waitFor(() => { expect(completed).toHaveBeenCalledTimes(1); });
      expect(message.reply).toHaveBeenCalledTimes(replies);
      expect(message.channel.send).toHaveBeenCalledTimes(1 - replies);
      expect(message.response.edit).not.toHaveBeenCalled();
      expect(inspect).toHaveBeenCalledExactlyOnceWith("https://fxtwitter.com/a/status/123");
      expect(inspect.mock.invocationCallOrder[0]).toBeGreaterThan(
        (replies ? message.reply : message.channel.send).mock.invocationCallOrder[0]!,
      );
    } finally {
      finish({title: "Late badge"});
      await pending;
    }
    await vi.waitFor(() => {
      expect(message.response.edit).toHaveBeenCalledExactlyOnceWith({content: `${replies ? "" : `From <@${message.author?.id}>: `}https://fxtwitter.com/a/status/123\n-# Late badge`, allowedMentions: {parse: [], repliedUser: false}});
    });
  });

  test("does not wait for original-preview suppression to send a converted link", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);
    const message = createTwitterMessage("look https://x.com/a/status/123");
    message.embeds = [{}];
    let finish: (value: undefined) => void = () => {};
    message.suppressEmbeds.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const completed = vi.fn();
    const pending = Promise.resolve(getHandler("messageCreate")(message)).then(completed);
    try {
      await vi.waitFor(() => { expect(completed).toHaveBeenCalledTimes(1); });
      expect(message.reply).toHaveBeenCalledTimes(1);
    } finally {
      finish(undefined);
      await pending;
    }
  });

  test("ignores updates on the removed original while its replacement badge is pending", async () => {
    const {client, getHandler} = createEventClient();
    let finish: (value: undefined) => void = () => {};
    const inspection = new Promise<undefined>(resolve => { finish = resolve; });
    addTwitterLinkRewrites(client, () => inspection);
    const message = createTwitterMessage("https://x.com/a/status/123");
    await getHandler("messageCreate")(message);
    message.embeds = [{}];
    await getHandler("messageUpdate")(undefined, message);
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
    finish(undefined);
  });

  test("limits assessments to four and survives assessment failure", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    addTwitterLinkRewrites(client, inspect);
    const message = createTwitterMessage(`look ${[100, 101, 102, 103, 104].map(id => `https://x.com/a/status/${id}`).join(" ")}`);
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => { expect(inspect).toHaveBeenCalledTimes(4); });
    expect(message.reply).toHaveBeenCalledTimes(1);
    expect(message.response.edit).not.toHaveBeenCalled();
  });

  test("does not attach badges for links omitted by the Discord content budget", async () => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge"});
    addTwitterLinkRewrites(client, inspect);
    const message = createTwitterMessage("https://x.com/a/status/123 https://x.com/b/status/456");
    message.author = {id: "1".repeat(1_935)};
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => {
      expect(message.response.edit).toHaveBeenCalledWith({content: `From <@${message.author?.id}>: https://fxtwitter.com/a/status/123\n-# Badge`, allowedMentions: {parse: [], repliedUser: false}});
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  test("keeps successful badges when another assessment rejects", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client, vi.fn().mockRejectedValueOnce(new Error("failure")).mockResolvedValue({title: "Second"}));
    const message = createTwitterMessage("https://x.com/a/status/123 https://x.com/b/status/456");
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => {
      expect(message.response.edit).toHaveBeenCalledWith({content: `From <@${message.author?.id}>: https://fxtwitter.com/a/status/123\nhttps://fxtwitter.com/b/status/456\n-# Link 2: Second`, allowedMentions: {parse: [], repliedUser: false}});
    });
  });

  test("retains the converted message and handles a rejected badge edit", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client, vi.fn().mockResolvedValue({title: "Badge"}));
    const message = createTwitterMessage("look https://x.com/a/status/123");
    message.response.edit.mockRejectedValue(new Error("deleted or permission denied"));
    await getHandler("messageCreate")(message);
    await vi.waitFor(() => {
      expect(loggerMock.log).toHaveBeenCalledWith("warn", "Twitter/X badge update failed; keeping the converted link.");
    });
    expect(message.reply).toHaveBeenCalledTimes(1);
    expect(message.delete).not.toHaveBeenCalled();
  });

  test.each(["look ", ""])("does not assess when sending the converted message fails for '%s'", async prefix => {
    const {client, getHandler} = createEventClient();
    const inspect = vi.fn().mockResolvedValue({title: "Badge"});
    addTwitterLinkRewrites(client, inspect);
    const message = createTwitterMessage(`${prefix}https://x.com/a/status/123`);
    message.channel.send.mockRejectedValue(new Error("send failed"));
    message.reply.mockRejectedValue(new Error("reply failed"));
    await getHandler("messageCreate")(message);
    expect(inspect).not.toHaveBeenCalled();
    expect(message.response.edit).not.toHaveBeenCalled();
  });

  test("replies immediately but defers suppression until the X card appears", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const createHandler = getHandler("messageCreate");
    const updateHandler = getHandler("messageUpdate");
    const message = createTwitterMessage("watch https://x.com/example/status/123?s=20");

    await createHandler(message);

    expect(message.reply).toHaveBeenCalledWith({
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
      content: "https://fxtwitter.com/example/status/123",
    });
    expect(message.suppressEmbeds).not.toHaveBeenCalled();

    message.embeds = [{type: "rich"}];
    await updateHandler(undefined, message);

    expect(message.suppressEmbeds).toHaveBeenCalledWith(true);
  });

  test("suppresses immediately when the card is already attached at create time", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("watch https://x.com/example/status/123");
    message.embeds = [{type: "rich"}];

    await handler(message);

    expect(message.suppressEmbeds).toHaveBeenCalledWith(true);
    expect(message.delete).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "https://fxtwitter.com/example/status/123",
    }));
  });

  test("keeps waiting when a messageUpdate arrives without the embed", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const createHandler = getHandler("messageCreate");
    const updateHandler = getHandler("messageUpdate");
    const message = createTwitterMessage("watch https://x.com/example/status/123");

    await createHandler(message);
    await updateHandler(undefined, message);

    expect(message.suppressEmbeds).not.toHaveBeenCalled();

    message.embeds = [{type: "rich"}];
    await updateHandler(undefined, message);
    await updateHandler(undefined, message);

    expect(message.suppressEmbeds).toHaveBeenCalledTimes(1);
  });

  test("ignores messageUpdate for messages it is not tracking", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const updateHandler = getHandler("messageUpdate");
    const message = createTwitterMessage("https://x.com/example/status/123");
    message.embeds = [{type: "rich"}];

    await updateHandler(undefined, message);

    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("stops waiting once the embed timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      const {client, getHandler} = createEventClient();
      addTwitterLinkRewrites(client);

      const createHandler = getHandler("messageCreate");
      const updateHandler = getHandler("messageUpdate");
      const message = createTwitterMessage("watch https://x.com/example/status/123");

      await createHandler(message);
      vi.advanceTimersByTime(15_000);

      message.embeds = [{type: "rich"}];
      await updateHandler(undefined, message);

      expect(message.suppressEmbeds).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("ignores bot-authored and webhook messages", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);
    const handler = getHandler("messageCreate");

    const botMessage = createTwitterMessage("https://x.com/example/status/123");
    botMessage.author = {bot: true};
    await handler(botMessage);

    const webhookMessage = createTwitterMessage("https://x.com/example/status/123");
    webhookMessage.webhookId = "webhook-id";
    await handler(webhookMessage);

    expect(botMessage.suppressEmbeds).not.toHaveBeenCalled();
    expect(botMessage.reply).not.toHaveBeenCalled();
    expect(webhookMessage.suppressEmbeds).not.toHaveBeenCalled();
    expect(webhookMessage.reply).not.toHaveBeenCalled();
  });

  test("does nothing when there are no fixable Twitter or X links", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("https://fxtwitter.com/example/status/123");

    await handler(message);

    expect(message.suppressEmbeds).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
  });

  test("still replies when suppressing the original embed fails", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("watch https://x.com/example/status/123");
    message.embeds = [{type: "rich"}];
    message.suppressEmbeds.mockRejectedValue(new Error("missing permission"));

    await handler(message);

    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "https://fxtwitter.com/example/status/123",
    }));
    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error suppressing Twitter/X embed"),
    );
  });

  test("logs reply failures without throwing", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("watch https://x.com/example/status/123");
    message.reply.mockRejectedValue(new Error("reply failed"));

    await handler(message);

    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error sending fixed Twitter/X link"),
    );
  });

  test("deletes a link-only message and reposts it crediting the poster by mention", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("https://x.com/example/status/123");
    message.author = {id: "111222333"};

    await handler(message);

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(message.channel.send).toHaveBeenCalledWith({
      allowedMentions: {
        parse: [],
      },
      content: "From <@111222333>: https://fxtwitter.com/example/status/123",
    });
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("preserves the reply context when replacing a link-only reply", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("https://x.com/example/status/123");
    message.author = {id: "111222333"};
    message.reference = {messageId: "original-message-id"};

    await handler(message);

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(message.channel.send).toHaveBeenCalledWith({
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
      content: "From <@111222333>: https://fxtwitter.com/example/status/123",
      reply: {
        failIfNotExists: false,
        messageReference: "original-message-id",
      },
    });
  });

  test("ignores a link enclosed in Discord embed suppression brackets", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("<https://x.com/example/status/123>!");
    message.author = {id: "111222333"};

    await handler(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("keeps a suppressed link when rewriting another link in the same message", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage(
      "<https://x.com/example/status/123> https://x.com/example/status/456",
    );

    await handler(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "https://fxtwitter.com/example/status/456",
    }));
  });

  test("reposts every link when a link-only message holds several", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage(
      "https://x.com/example/status/123 https://twitter.com/example/status/456",
    );
    message.author = {id: "111222333"};

    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: "From <@111222333>: https://fxtwitter.com/example/status/123\nhttps://fxtwitter.com/example/status/456",
    }));
  });

  test("replies instead of deleting when the message has surrounding text", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("look at this https://x.com/example/status/123");

    await handler(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "https://fxtwitter.com/example/status/123",
    }));
  });

  test("credits the poster by mention, falling back to a neutral label without an author id", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");

    const mentionMessage = createTwitterMessage("https://x.com/example/status/123");
    mentionMessage.author = {id: "987654321"};
    await handler(mentionMessage);

    const anonymousMessage = createTwitterMessage("https://x.com/example/status/789");
    anonymousMessage.author = {};
    await handler(anonymousMessage);

    expect(mentionMessage.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: "From <@987654321>: https://fxtwitter.com/example/status/123",
    }));
    expect(anonymousMessage.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: "From someone: https://fxtwitter.com/example/status/789",
    }));
  });

  test("falls back to replying when deleting the link-only message fails", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("https://x.com/example/status/123");
    message.delete.mockRejectedValue(new Error("missing permission"));

    await handler(message);

    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "https://fxtwitter.com/example/status/123",
    }));
    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error deleting original Twitter/X message"),
    );
  });

  test("logs when posting the replacement message fails", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("https://x.com/example/status/123");
    message.channel.send.mockRejectedValue(new Error("send failed"));

    await handler(message);

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(message.reply).not.toHaveBeenCalled();
    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error posting replacement Twitter/X message"),
    );
  });

  test("falls back to replying when the credit prefix leaves no room for the link", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("https://x.com/example/status/123");
    message.author = {id: "1".repeat(2_000)};

    await handler(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "https://fxtwitter.com/example/status/123",
    }));
  });
});
