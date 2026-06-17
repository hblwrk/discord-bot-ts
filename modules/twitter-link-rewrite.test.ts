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
  };
  content: string;
  embeds: unknown[];
  id: string;
  reply: ReturnType<typeof vi.fn>;
  suppressEmbeds: ReturnType<typeof vi.fn>;
  webhookId?: string | null;
};

let nextMessageId = 0;

function createTwitterMessage(content: string): TwitterTestMessage {
  nextMessageId += 1;
  return {
    content,
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
    const message = createTwitterMessage("https://x.com/example/status/123");
    message.embeds = [{type: "rich"}];

    await handler(message);

    expect(message.suppressEmbeds).toHaveBeenCalledWith(true);
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "https://fxtwitter.com/example/status/123",
    }));
  });

  test("keeps waiting when a messageUpdate arrives without the embed", async () => {
    const {client, getHandler} = createEventClient();
    addTwitterLinkRewrites(client);

    const createHandler = getHandler("messageCreate");
    const updateHandler = getHandler("messageUpdate");
    const message = createTwitterMessage("https://x.com/example/status/123");

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
      const message = createTwitterMessage("https://x.com/example/status/123");

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
    const message = createTwitterMessage("https://x.com/example/status/123");
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
    const message = createTwitterMessage("https://x.com/example/status/123");
    message.reply.mockRejectedValue(new Error("reply failed"));

    await handler(message);

    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error sending fixed Twitter/X link"),
    );
  });
});
