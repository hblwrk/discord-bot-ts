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

type TwitterTestMessage = {
  author?: {
    bot?: boolean;
    globalName?: string | null;
    username?: string;
  };
  channel: {
    send: ReturnType<typeof vi.fn>;
  };
  content: string;
  delete: ReturnType<typeof vi.fn>;
  embeds: unknown[];
  id: string;
  member?: {
    displayName?: string;
  } | null;
  reply: ReturnType<typeof vi.fn>;
  suppressEmbeds: ReturnType<typeof vi.fn>;
  webhookId?: string | null;
};

let nextMessageId = 0;

function createTwitterMessage(content: string): TwitterTestMessage {
  nextMessageId += 1;
  return {
    channel: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    content,
    delete: vi.fn().mockResolvedValue(undefined),
    embeds: [],
    id: `message-${nextMessageId}`,
    reply: vi.fn().mockResolvedValue(undefined),
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
      "tweet (https://x.com/example/status/123), and <https://twitter.com/example/status/456>!",
    )).toEqual([
      "https://fxtwitter.com/example/status/123",
      "https://fxtwitter.com/example/status/456",
    ]);
  });
});

describe("addTwitterLinkRewrites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  test("deletes a link-only message and reposts it crediting the poster", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("https://x.com/example/status/123");
    message.member = {displayName: "Xeophon"};

    await handler(message);

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(message.channel.send).toHaveBeenCalledWith({
      allowedMentions: {
        parse: [],
      },
      content: "From Xeophon: https://fxtwitter.com/example/status/123",
    });
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("treats a link wrapped in brackets and punctuation as link-only", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("<https://x.com/example/status/123>!");
    message.member = {displayName: "Xeophon"};

    await handler(message);

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(message.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: "From Xeophon: https://fxtwitter.com/example/status/123",
    }));
  });

  test("reposts every link when a link-only message holds several", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage(
      "https://x.com/example/status/123 https://twitter.com/example/status/456",
    );
    message.member = {displayName: "Xeophon"};

    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: "From Xeophon: https://fxtwitter.com/example/status/123\nhttps://fxtwitter.com/example/status/456",
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

  test("credits the global name, then the username, then a fallback", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");

    const globalNameMessage = createTwitterMessage("https://x.com/example/status/123");
    globalNameMessage.author = {globalName: "GlobalName"};
    await handler(globalNameMessage);

    const usernameMessage = createTwitterMessage("https://x.com/example/status/456");
    usernameMessage.author = {globalName: null, username: "username"};
    await handler(usernameMessage);

    const anonymousMessage = createTwitterMessage("https://x.com/example/status/789");
    await handler(anonymousMessage);

    expect(globalNameMessage.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: "From GlobalName: https://fxtwitter.com/example/status/123",
    }));
    expect(usernameMessage.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: "From username: https://fxtwitter.com/example/status/456",
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

  test("falls back to replying when the credited name leaves no room for the link", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const handler = getHandler("messageCreate");
    const message = createTwitterMessage("https://x.com/example/status/123");
    message.member = {displayName: "x".repeat(2_000)};

    await handler(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "https://fxtwitter.com/example/status/123",
    }));
  });
});
