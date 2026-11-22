import {beforeEach, describe, expect, test, vi} from "vitest";
import {createEventClient} from "./test-utils/discord-mocks.ts";
import {addInstagramLinkRewrites, getInstagramLinks} from "./instagram-link-rewrite.ts";

const loggerMock = vi.hoisted(() => ({
  log: vi.fn(),
}));

vi.mock("./logging.ts", () => ({
  getLogger: () => loggerMock,
}));

type InstagramTestMessage = {
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
  suppressEmbeds: ReturnType<typeof vi.fn>;
  webhookId?: string | null;
};

let nextMessageId = 0;

function createInstagramMessage(content: string): InstagramTestMessage {
  nextMessageId += 1;
  return {
    author: {id: `author-${nextMessageId}`},
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

function setupHandlers() {
  const {client, getHandler} = createEventClient();
  addInstagramLinkRewrites(client);
  return {
    create: getHandler("messageCreate"),
    update: getHandler("messageUpdate"),
  };
}

function instagramLinks(content: string) {
  return getInstagramLinks(content).links;
}

function cleanLinks(content: string): string[] {
  return instagramLinks(content).map(link => link.link);
}

const noPing = {parse: [], repliedUser: false};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getInstagramLinks", () => {
  test.each([
    ["https://www.instagram.com/p/C0xFHGOrBN7/", "https://kirkstagram.com/p/C0xFHGOrBN7/"],
    ["https://instagram.com/reel/C0xFHGOrBN7", "https://kirkstagram.com/reel/C0xFHGOrBN7/"],
    ["https://www.instagram.com/reels/C0xFHGOrBN7/", "https://kirkstagram.com/reel/C0xFHGOrBN7/"],
    ["https://www.instagram.com/tv/C0xFHGOrBN7/", "https://kirkstagram.com/tv/C0xFHGOrBN7/"],
    ["https://m.instagram.com/p/C0xFHGOrBN7/", "https://kirkstagram.com/p/C0xFHGOrBN7/"],
    ["https://instagr.am/p/C0xFHGOrBN7/", "https://kirkstagram.com/p/C0xFHGOrBN7/"],
    ["http://www.instagram.com/p/C0xFHGOrBN7/", "https://kirkstagram.com/p/C0xFHGOrBN7/"],
    ["https://www.instagram.com/some.user_1/p/C0xFHGOrBN7/", "https://kirkstagram.com/p/C0xFHGOrBN7/"],
    ["https://www.instagram.com/some.user_1/reel/C0xFHGOrBN7/", "https://kirkstagram.com/reel/C0xFHGOrBN7/"],
    ["https://WWW.INSTAGRAM.COM/p/Ab-_9xYzQ/", "https://kirkstagram.com/p/Ab-_9xYzQ/"],
  ])("rewrites %s to Kirkstagram", (pasted, expected) => {
    expect(instagramLinks(pasted)).toEqual([{link: expected, source: "original", changed: true}]);
  });

  test.each([
    ["?igsh=MWFhYnB3eGZ0ZmRxbQ==", ""],
    ["?utm_source=ig_web_copy_link&igshid=MzRlODBiNWFlZA==", ""],
    ["#comments", ""],
    ["?img_index=3&igsh=MWFhYnB3eGZ0ZmRxbQ==", "?img_index=3"],
    ["?igsh=abc&img_index=1", "?img_index=1"],
    ["?img_index=20", "?img_index=20"],
    ["?img_index=0", ""],
    ["?img_index=21", ""],
    ["?img_index=02", ""],
    ["?img_index=-1", ""],
    ["?img_index=2abc", ""],
  ])("cleans query %s to %j", (query, expectedQuery) => {
    expect(cleanLinks(`https://www.instagram.com/reel/C0xFHGOrBN7/${query}`))
      .toEqual([`https://kirkstagram.com/reel/C0xFHGOrBN7/${expectedQuery}`]);
  });

  test.each([
    "https://www.instagram.com/",
    "https://www.instagram.com/someuser/",
    "https://www.instagram.com/stories/someuser/3141592653589793238/",
    "https://www.instagram.com/share/reel/BAabcdefgh/",
    "https://www.instagram.com/explore/tags/cats/",
    "https://www.instagram.com/p/abcd/",
    "https://www.instagram.com/p/C0xFHGOrBN7/extra/",
    "https://www.instagram.com/p/C0xFHGOrBN7/0/",
    "https://www.instagram.com/a/b/p/C0xFHGOrBN7/",
    "https://instagram.com.evil.test/p/C0xFHGOrBN7/",
    "https://evilinstagram.com/p/C0xFHGOrBN7/",
    "https://instagram.com@evil.test/p/C0xFHGOrBN7/",
    "https://user:pass@www.instagram.com/p/C0xFHGOrBN7/",
    "https://www.instagram.com:8443/p/C0xFHGOrBN7/",
    "https://instagramez.com/p/C0xFHGOrBN7/",
    "https://ddinstagram.com/p/C0xFHGOrBN7/",
    "https://[invalid/p/C0xFHGOrBN7/",
  ])("ignores unsupported or unsafe URL %s", value => {
    expect(instagramLinks(`look ${value}`)).toEqual([]);
  });

  test("keeps proxy hosts and paths while removing tracking parameters", () => {
    expect(instagramLinks(
      "https://kkinstagram.com/reel/C0xFHGOrBN7/?igsh=MWFhYnB3eGZ0ZmRxbQ== https://www.kirkstagram.com/someone/p/D1yGIHPsCO8/?img_index=4&utm_source=x",
    )).toEqual([
      {link: "https://kkinstagram.com/reel/C0xFHGOrBN7/", source: "proxy", changed: true},
      {link: "https://www.kirkstagram.com/someone/p/D1yGIHPsCO8/?img_index=4", source: "proxy", changed: true},
    ]);
  });

  test("keeps a proxy carousel path segment instead of a query position", () => {
    expect(instagramLinks("https://kirkstagram.com/p/C0xFHGOrBN7/2/?img_index=5")).toEqual([
      {link: "https://kirkstagram.com/p/C0xFHGOrBN7/2/", source: "proxy", changed: true},
    ]);
  });

  test("marks clean proxy links as unchanged", () => {
    expect(instagramLinks("https://kkinstagram.com/p/C0xFHGOrBN7/")).toEqual([
      {link: "https://kkinstagram.com/p/C0xFHGOrBN7/", source: "proxy", changed: false},
    ]);
  });

  test("returns links in paste order and deduplicates by post and carousel position", () => {
    expect(cleanLinks([
      "https://instagram.com/p/AAAAAAAAAAA/",
      "https://www.instagram.com/reel/BBBBBBBBBBB/?igsh=x",
      "https://instagram.com/p/AAAAAAAAAAA/?igsh=y",
      "https://kkinstagram.com/p/AAAAAAAAAAA/",
      "https://instagram.com/p/AAAAAAAAAAA/?img_index=2",
    ].join(" "))).toEqual([
      "https://kirkstagram.com/p/AAAAAAAAAAA/",
      "https://kirkstagram.com/reel/BBBBBBBBBBB/",
      "https://kirkstagram.com/p/AAAAAAAAAAA/?img_index=2",
    ]);
  });

  test("trims trailing punctuation and skips bracket-suppressed links", () => {
    expect(cleanLinks(
      "(https://www.instagram.com/p/C0xFHGOrBN7/?igsh=x). <https://www.instagram.com/reel/D1yGIHPsCO8/>",
    )).toEqual(["https://kirkstagram.com/p/C0xFHGOrBN7/"]);
  });

  test("keeps spoilers, preferring a spoilered duplicate", () => {
    expect(cleanLinks("||https://www.instagram.com/p/C0xFHGOrBN7/?igsh=x||")).toEqual([
      "||https://kirkstagram.com/p/C0xFHGOrBN7/||",
    ]);
    expect(cleanLinks(
      "https://instagram.com/p/C0xFHGOrBN7/ ||https://instagram.com/p/C0xFHGOrBN7/||",
    )).toEqual(["||https://kirkstagram.com/p/C0xFHGOrBN7/||"]);
  });
});

describe("addInstagramLinkRewrites", () => {
  test("ignores bot-authored and webhook messages", async () => {
    const {create} = setupHandlers();
    const botMessage = createInstagramMessage("https://www.instagram.com/p/C0xFHGOrBN7/");
    botMessage.author = {bot: true, id: "bot"};
    const webhookMessage = createInstagramMessage("https://www.instagram.com/p/C0xFHGOrBN7/");
    webhookMessage.webhookId = "webhook";

    await create(botMessage);
    await create(webhookMessage);

    for (const message of [botMessage, webhookMessage]) {
      expect(message.delete).not.toHaveBeenCalled();
      expect(message.reply).not.toHaveBeenCalled();
      expect(message.channel.send).not.toHaveBeenCalled();
    }
  });

  test.each([
    "no links here",
    "profile https://www.instagram.com/someuser/",
    "https://www.instagram.com/share/reel/BAabcdefgh/",
    "<https://www.instagram.com/p/C0xFHGOrBN7/>",
    "hidden <https://www.instagram.com/p/C0xFHGOrBN7/> preview",
  ])("leaves %j alone", async content => {
    const {create} = setupHandlers();
    const message = createInstagramMessage(content);

    await create(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("replaces a link-only message with cleaned links credited to the poster", async () => {
    const {create} = setupHandlers();
    const message = createInstagramMessage(
      " https://www.instagram.com/reel/C0xFHGOrBN7/?igsh=MWFhYnB3eGZ0ZmRxbQ==\n(https://instagram.com/p/D1yGIHPsCO8/) ",
    );

    await create(message);

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(message.channel.send).toHaveBeenCalledWith({
      allowedMentions: {parse: []},
      content: `From <@${message.author?.id}>: https://kirkstagram.com/reel/C0xFHGOrBN7/\nhttps://kirkstagram.com/p/D1yGIHPsCO8/`,
    });
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("keeps the reply context of a replaced message", async () => {
    const {create} = setupHandlers();
    const message = createInstagramMessage("https://www.instagram.com/p/C0xFHGOrBN7/");
    message.reference = {messageId: "parent"};

    await create(message);

    expect(message.channel.send).toHaveBeenCalledWith({
      allowedMentions: noPing,
      content: `From <@${message.author?.id}>: https://kirkstagram.com/p/C0xFHGOrBN7/`,
      reply: {failIfNotExists: false, messageReference: "parent"},
    });
  });

  test("credits someone when the author id is missing", async () => {
    const {create} = setupHandlers();
    const message = createInstagramMessage("||https://www.instagram.com/p/C0xFHGOrBN7/||");
    delete message.author;

    await create(message);

    expect(message.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: "From someone: ||https://kirkstagram.com/p/C0xFHGOrBN7/||",
    }));
  });

  test("replies instead when the original cannot be deleted", async () => {
    const {create} = setupHandlers();
    const message = createInstagramMessage("https://www.instagram.com/p/C0xFHGOrBN7/");
    message.delete.mockRejectedValueOnce(new Error("Missing Permissions"));
    message.embeds = [{type: "link"}];

    await create(message);

    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith({
      allowedMentions: noPing,
      content: "https://kirkstagram.com/p/C0xFHGOrBN7/",
    });
    expect(message.suppressEmbeds).toHaveBeenCalledWith(true);
    expect(loggerMock.log).toHaveBeenCalledWith("error", expect.stringContaining("Error deleting original Instagram message"));
  });

  test("logs a failed replacement without replying to the deleted message", async () => {
    const {create} = setupHandlers();
    const message = createInstagramMessage("https://www.instagram.com/p/C0xFHGOrBN7/");
    message.channel.send.mockRejectedValueOnce(new Error("Missing Access"));

    await create(message);

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(message.reply).not.toHaveBeenCalled();
    expect(loggerMock.log).toHaveBeenCalledWith("error", expect.stringContaining("Error posting replacement Instagram message"));
  });

  test("replies to messages with surrounding text and suppresses the broken preview", async () => {
    const {create} = setupHandlers();
    const message = createInstagramMessage(
      "look at this https://www.instagram.com/reel/C0xFHGOrBN7/?igsh=x and this https://instagram.com/p/D1yGIHPsCO8/",
    );
    message.embeds = [{type: "link"}];

    await create(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith({
      allowedMentions: noPing,
      content: "https://kirkstagram.com/reel/C0xFHGOrBN7/\nhttps://kirkstagram.com/p/D1yGIHPsCO8/",
    });
    expect(message.suppressEmbeds).toHaveBeenCalledWith(true);
  });

  test("treats links from other sites as surrounding text", async () => {
    const {create} = setupHandlers();
    const message = createInstagramMessage("https://x.com/example/status/123 https://www.instagram.com/p/C0xFHGOrBN7/");

    await create(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith({
      allowedMentions: noPing,
      content: "https://kirkstagram.com/p/C0xFHGOrBN7/",
    });
  });

  test("suppresses the preview once Discord attaches it", async () => {
    const {create, update} = setupHandlers();
    const message = createInstagramMessage("look https://www.instagram.com/p/C0xFHGOrBN7/");

    await create(message);
    expect(message.suppressEmbeds).not.toHaveBeenCalled();

    await update(undefined, message);
    expect(message.suppressEmbeds).not.toHaveBeenCalled();

    message.embeds = [{type: "link"}];
    await update(undefined, message);
    await update(undefined, message);
    expect(message.suppressEmbeds).toHaveBeenCalledTimes(1);
  });

  test("ignores updates for messages it is not tracking", async () => {
    const {update} = setupHandlers();
    const message = createInstagramMessage("look https://www.instagram.com/p/C0xFHGOrBN7/");
    message.embeds = [{type: "link"}];

    await update(undefined, message);

    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("stops waiting for the preview after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const {create, update} = setupHandlers();
      const message = createInstagramMessage("look https://www.instagram.com/p/C0xFHGOrBN7/");

      await create(message);
      vi.advanceTimersByTime(15_000);
      message.embeds = [{type: "link"}];
      await update(undefined, message);

      expect(message.suppressEmbeds).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps existing proxy previews when raw links are pasted alongside them", async () => {
    const {create, update} = setupHandlers();
    const message = createInstagramMessage(
      "compare https://kkinstagram.com/p/D1yGIHPsCO8/ with https://www.instagram.com/p/C0xFHGOrBN7/",
    );
    message.embeds = [{type: "link"}];

    await create(message);
    await update(undefined, message);

    expect(message.reply).toHaveBeenCalledWith({
      allowedMentions: noPing,
      content: "https://kirkstagram.com/p/C0xFHGOrBN7/",
    });
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("reposts link-only raw and proxy links together in paste order", async () => {
    const {create} = setupHandlers();
    const message = createInstagramMessage(
      "https://kkinstagram.com/reel/D1yGIHPsCO8/ https://www.instagram.com/p/C0xFHGOrBN7/?igsh=x",
    );

    await create(message);

    expect(message.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: `From <@${message.author?.id}>: https://kkinstagram.com/reel/D1yGIHPsCO8/\nhttps://kirkstagram.com/p/C0xFHGOrBN7/`,
    }));
  });

  test("reposts a link-only proxy link to remove its tracking parameters", async () => {
    const {create} = setupHandlers();
    const message = createInstagramMessage("https://kkinstagram.com/reel/C0xFHGOrBN7/?igsh=MWFhYnB3eGZ0ZmRxbQ==");

    await create(message);

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(message.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: `From <@${message.author?.id}>: https://kkinstagram.com/reel/C0xFHGOrBN7/`,
    }));
  });

  test.each([
    "https://kkinstagram.com/reel/C0xFHGOrBN7/",
    "see https://kkinstagram.com/reel/C0xFHGOrBN7/?igsh=MWFhYnB3eGZ0ZmRxbQ==",
  ])("leaves proxy-only message %j alone", async content => {
    const {create} = setupHandlers();
    const message = createInstagramMessage(content);
    message.embeds = [{type: "link"}];

    await create(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("logs failed replies and failed suppression", async () => {
    const {create} = setupHandlers();
    const message = createInstagramMessage("look https://www.instagram.com/p/C0xFHGOrBN7/");
    message.embeds = [{type: "link"}];
    message.reply.mockRejectedValueOnce(new Error("Missing Access"));
    message.suppressEmbeds.mockRejectedValueOnce(new Error("Missing Permissions"));

    await create(message);

    await vi.waitFor(() => {
      expect(loggerMock.log).toHaveBeenCalledWith("error", expect.stringContaining("Error sending fixed Instagram link"));
      expect(loggerMock.log).toHaveBeenCalledWith("error", expect.stringContaining("Error suppressing Instagram embed"));
    });
  });
});
