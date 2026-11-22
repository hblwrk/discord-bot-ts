import {beforeEach, describe, expect, test, vi} from "vitest";
import {createEventClient} from "./test-utils/discord-mocks.ts";

const loggerMock = vi.hoisted(() => ({
  log: vi.fn(),
}));
const headMock = vi.hoisted(() => vi.fn());

vi.mock("./logging.ts", () => ({
  getLogger: () => loggerMock,
}));

vi.mock("axios", () => ({
  __esModule: true,
  default: {
    head: (...args: unknown[]) => headMock(...args),
  },
}));

import {
  addRedditLinkRewrites,
  getRedditLinks,
  resolveRedditShareLink,
  type ShareLinkResolver,
} from "./reddit-link-rewrite.ts";

type RedditTestMessage = {
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
  reply: ReturnType<typeof vi.fn>;
  suppressEmbeds: ReturnType<typeof vi.fn>;
  webhookId?: string | null;
};

const shareLink = "https://www.reddit.com/r/RemarkableTablet/s/PfFj7TdhlT";
const sharePath = "/r/RemarkableTablet/s/PfFj7TdhlT";
// Location header Reddit sends for shareLink.
const shareTarget = "https://www.reddit.com/r/RemarkableTablet/comments/1twzgb0/a_few_words_on_the_pure/"
  + "?share_id=Gh240wWgBFEKM0c6ZfZp8&utm_content=share_button&utm_medium=web3x&utm_name=web3xcss&utm_source=share&utm_term=1";
const shareFixed = "https://vxreddit.com/r/RemarkableTablet/comments/1twzgb0/a_few_words_on_the_pure/";

let nextMessageId = 0;

function createRedditMessage(content: string): RedditTestMessage {
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

function createResolver(targets: Record<string, string | undefined> = {[sharePath]: shareTarget}) {
  return vi.fn<ShareLinkResolver>(async path => targets[path]);
}

function setupHandlers(resolveShareLink?: ShareLinkResolver) {
  const {client, getHandler} = createEventClient();
  addRedditLinkRewrites(client, resolveShareLink);
  return {
    create: getHandler("messageCreate"),
    update: getHandler("messageUpdate"),
  };
}

async function redditLinks(content: string, resolveShareLink: ShareLinkResolver = createResolver()) {
  return (await getRedditLinks(content, resolveShareLink)).links;
}

async function cleanLinks(content: string, resolveShareLink?: ShareLinkResolver): Promise<string[]> {
  return (await redditLinks(content, resolveShareLink)).map(link => link.link);
}

const noPing = {parse: [], repliedUser: false};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getRedditLinks", () => {
  test.each([
    [
      "https://www.reddit.com/r/RemarkableTablet/comments/1uhyao1/morning_vibes/",
      "https://vxreddit.com/r/RemarkableTablet/comments/1uhyao1/morning_vibes/",
    ],
    [
      "https://reddit.com/r/pics/comments/5sfexx/this_is_shelia",
      "https://vxreddit.com/r/pics/comments/5sfexx/this_is_shelia/",
    ],
    [
      "http://old.reddit.com/r/pics/comments/5sfexx/",
      "https://vxreddit.com/r/pics/comments/5sfexx/",
    ],
    [
      "https://np.reddit.com/r/IAmA/comments/z1c9z/i_am_barack_obama/c60o0iw/",
      "https://vxreddit.com/r/IAmA/comments/z1c9z/i_am_barack_obama/c60o0iw/",
    ],
    [
      "https://www.reddit.com/r/RemarkableTablet/comments/1ulad9y/comment/ov38mit/",
      "https://vxreddit.com/r/RemarkableTablet/comments/1ulad9y/comment/ov38mit/",
    ],
    [
      "https://m.reddit.com/user/YourFat888/comments/1unl820/maybe_the_voices_are_right/",
      "https://vxreddit.com/user/YourFat888/comments/1unl820/maybe_the_voices_are_right/",
    ],
    [
      "https://new.reddit.com/u/YourFat888/comments/1unl820/",
      "https://vxreddit.com/u/YourFat888/comments/1unl820/",
    ],
    [
      "https://sh.reddit.com/r/reddit.com/comments/87/the_downing_street_memo/",
      "https://vxreddit.com/r/reddit.com/comments/87/the_downing_street_memo/",
    ],
    [
      "https://WWW.REDDIT.COM/comments/1twzgb0",
      "https://vxreddit.com/comments/1twzgb0/",
    ],
    [
      "https://redd.it/1twzgb0",
      "https://vxreddit.com/comments/1twzgb0/",
    ],
    [
      "https://www.reddit.com/gallery/1ulibqk",
      "https://vxreddit.com/comments/1ulibqk/",
    ],
    [
      "https://i.reddit.com/r/pics/comments/5sfexx/caf%C3%A9/",
      "https://vxreddit.com/r/pics/comments/5sfexx/caf%C3%A9/",
    ],
  ])("rewrites %s", async (pasted, expected) => {
    expect(await redditLinks(pasted)).toEqual([{link: expected, source: "original", changed: true}]);
  });

  test.each([
    [
      "https://www.reddit.com/r/news/comments/1ujr690/supreme_court/?share_id=Gh240wWgBFEKM0c6ZfZp8&utm_content=share_button&utm_source=share",
      "https://vxreddit.com/r/news/comments/1ujr690/supreme_court/",
    ],
    [
      "https://amp.reddit.com/r/IAmA/comments/z1c9z/i_am_barack_obama/c60o0iw/?context=3&utm_medium=web2x#c60o0iw",
      "https://vxreddit.com/r/IAmA/comments/z1c9z/i_am_barack_obama/c60o0iw/",
    ],
    [
      "https://redd.it/1twzgb0?utm_source=share",
      "https://vxreddit.com/comments/1twzgb0/",
    ],
  ])("removes tracking from %s", async (pasted, expected) => {
    expect(await cleanLinks(pasted)).toEqual([expected]);
  });

  test.each([
    "https://www.reddit.com/",
    "https://www.reddit.com/r/pics/",
    "https://www.reddit.com/user/someone/",
    "https://www.reddit.com/settings",
    "https://www.reddit.com/1twzgb0",
    "https://www.reddit.com/r/pics/wiki/index",
    "https://www.reddit.com/r/pics/comments/5sfexx/slug/c60o0iw/extra/",
    "https://www.reddit.com/r/pics/comments/5SFEXX/",
    "https://www.reddit.com/r/pics/comments/5sfexx/slug.with.dots/",
    "https://www.reddit.com/r/a/b/comments/5sfexx/",
    "https://redd.it/",
    "https://redd.it/r/pics/comments/5sfexx/",
    "https://redd.it/gallery/1ulibqk",
    "https://i.redd.it/txanwjv071ah1.jpeg",
    "https://v.redd.it/fs1sgj08nnah1",
    "https://preview.redd.it/txanwjv071ah1.jpeg?width=640&s=abc",
    "https://evilreddit.com/r/pics/comments/5sfexx/",
    "https://reddit.com.evil.test/r/pics/comments/5sfexx/",
    "https://reddit.com.embed.works/r/pics/comments/5sfexx/",
    "https://rxddit.com/r/pics/comments/5sfexx/",
    "https://user:pass@reddit.com/r/pics/comments/5sfexx/",
    "https://reddit.com:8443/r/pics/comments/5sfexx/",
    "https://[invalid",
  ])("leaves %s alone", async value => {
    const resolveShareLink = createResolver();

    expect(await redditLinks(`look ${value}`, resolveShareLink)).toEqual([]);
    expect(resolveShareLink).not.toHaveBeenCalled();
  });

  test("keeps proxy hosts and paths while removing tracking parameters", async () => {
    expect(await redditLinks(
      "https://vxreddit.com/r/pics/comments/5sfexx/slug/?share_id=abc&utm_source=share https://www.vxreddit.com/1twzgb0?l#top",
    )).toEqual([
      {link: "https://vxreddit.com/r/pics/comments/5sfexx/slug/", source: "proxy", changed: true},
      {link: "https://www.vxreddit.com/1twzgb0", source: "proxy", changed: true},
    ]);
  });

  test("marks clean proxy links as unchanged", async () => {
    expect(await redditLinks("https://vxreddit.com/r/pics/comments/5sfexx")).toEqual([
      {link: "https://vxreddit.com/r/pics/comments/5sfexx", source: "proxy", changed: false},
    ]);
  });

  test("rewrites proxy gallery links, which vxReddit does not serve", async () => {
    expect(await redditLinks("https://vxreddit.com/gallery/1ulibqk")).toEqual([
      {link: "https://vxreddit.com/comments/1ulibqk/", source: "proxy", changed: true},
    ]);
  });

  test("replaces share links with the post they redirect to", async () => {
    const resolveShareLink = createResolver();

    expect(await redditLinks(shareLink, resolveShareLink)).toEqual([
      {link: shareFixed, source: "original", changed: true},
    ]);
    expect(resolveShareLink).toHaveBeenCalledWith(sharePath);
  });

  test.each([
    `https://old.reddit.com${sharePath}/`,
    `https://reddit.com${sharePath}?utm_source=share`,
  ])("resolves %s through the same share path", async pasted => {
    const resolveShareLink = createResolver({[sharePath]: shareTarget, [`${sharePath}/`]: shareTarget});

    expect(await cleanLinks(pasted, resolveShareLink)).toEqual([shareFixed]);
  });

  test("replaces proxy share links and keeps them marked as proxy links", async () => {
    expect(await redditLinks(`https://vxreddit.com${sharePath}`)).toEqual([
      {link: shareFixed, source: "proxy", changed: true},
    ]);
  });

  test.each([
    ["no redirect", undefined],
    ["a subreddit redirect for an unknown token", "https://www.reddit.com/r/RemarkableTablet/"],
    ["a login redirect", "https://www.reddit.com/login/?dest=https%3A%2F%2Fwww.reddit.com%2Fr%2Fx%2Fs%2FPfFj7TdhlT"],
    ["a redirect to another share link", "https://www.reddit.com/r/RemarkableTablet/s/AAAAAAAAAA"],
    ["a redirect to a proxy", "https://vxreddit.com/r/RemarkableTablet/comments/1twzgb0/"],
    ["a redirect to another site", "https://evil.test/r/RemarkableTablet/comments/1twzgb0/"],
    ["an invalid redirect", "not a url"],
  ])("leaves share links alone after %s", async (_label, target) => {
    expect(await redditLinks(shareLink, createResolver({[sharePath]: target}))).toEqual([]);
  });

  test("does not resolve share links on redd.it", async () => {
    const resolveShareLink = createResolver();

    expect(await redditLinks(`https://redd.it${sharePath}`, resolveShareLink)).toEqual([]);
    expect(resolveShareLink).not.toHaveBeenCalled();
  });

  test("resolves each share link once and at most three per message", async () => {
    const paths = ["/r/a/s/AAAAAAAAAA", "/r/a/s/BBBBBBBBBB", "/r/a/s/CCCCCCCCCC", "/r/a/s/DDDDDDDDDD"];
    const resolveShareLink = vi.fn<ShareLinkResolver>(async path => `https://www.reddit.com/r/a/comments/${path.at(-1)?.toLowerCase()}1/`);
    const content = [paths[0], paths[0], ...paths].map(path => `https://www.reddit.com${path}`).join(" ");

    expect(await cleanLinks(content, resolveShareLink)).toEqual([
      "https://vxreddit.com/r/a/comments/a1/",
      "https://vxreddit.com/r/a/comments/b1/",
      "https://vxreddit.com/r/a/comments/c1/",
    ]);
    expect(resolveShareLink.mock.calls).toEqual([[paths[0]], [paths[1]], [paths[2]]]);
  });

  test("returns links in paste order and deduplicates by post and comment", async () => {
    expect(await cleanLinks([
      "https://www.reddit.com/r/pics/comments/5sfexx/slug/",
      "https://old.reddit.com/r/pics/comments/5sfexx/",
      "https://redd.it/5sfexx",
      "https://www.reddit.com/r/IAmA/comments/z1c9z/slug/c60o0iw/",
      "https://www.reddit.com/r/IAmA/comments/z1c9z/",
      shareLink,
      "https://www.reddit.com/r/RemarkableTablet/comments/1twzgb0/",
    ].join("\n"))).toEqual([
      "https://vxreddit.com/r/pics/comments/5sfexx/slug/",
      "https://vxreddit.com/r/IAmA/comments/z1c9z/slug/c60o0iw/",
      "https://vxreddit.com/r/IAmA/comments/z1c9z/",
      shareFixed,
    ]);
  });

  test("trims trailing punctuation, skips bracket-suppressed links and keeps spoilers", async () => {
    expect(await cleanLinks(
      "(https://redd.it/1twzgb0). <https://redd.it/5sfexx> ||https://redd.it/z1c9z||",
    )).toEqual([
      "https://vxreddit.com/comments/1twzgb0/",
      "||https://vxreddit.com/comments/z1c9z/||",
    ]);
  });

  test("resolves share links over the network by default", async () => {
    headMock.mockResolvedValueOnce({headers: {location: shareTarget}});

    expect((await getRedditLinks(shareLink)).links.map(link => link.link)).toEqual([shareFixed]);
  });
});

describe("resolveRedditShareLink", () => {
  test("reads the redirect target without following it", async () => {
    headMock.mockResolvedValueOnce({headers: {location: shareTarget}});

    expect(await resolveRedditShareLink(sharePath)).toBe(shareTarget);
    expect(headMock).toHaveBeenCalledWith(`https://www.reddit.com${sharePath}`, expect.objectContaining({
      headers: {"User-Agent": "Mozilla/5.0 (compatible; bot)"},
      maxRedirects: 0,
      timeout: 5_000,
    }));
    const {validateStatus} = headMock.mock.calls[0]?.[1] as {validateStatus: (status: number) => boolean};
    expect([200, 299, 300, 301, 307, 399, 400, 403].map(validateStatus)).toEqual([false, false, true, true, true, true, false, false]);
  });

  test("resolves a relative redirect against reddit.com", async () => {
    headMock.mockResolvedValueOnce({headers: {location: "/r/RemarkableTablet/comments/1twzgb0/"}});

    expect(await resolveRedditShareLink(sharePath)).toBe("https://www.reddit.com/r/RemarkableTablet/comments/1twzgb0/");
  });

  test("returns nothing without a redirect target", async () => {
    headMock.mockResolvedValueOnce({headers: {}});

    expect(await resolveRedditShareLink(sharePath)).toBeUndefined();
  });

  test("logs failures without the share token", async () => {
    headMock.mockRejectedValueOnce(new Error("Request failed with status code 403"));

    expect(await resolveRedditShareLink(sharePath)).toBeUndefined();
    expect(loggerMock.log).toHaveBeenCalledWith("warn", "Error resolving Reddit share link: Error: Request failed with status code 403");
    expect(JSON.stringify(loggerMock.log.mock.calls)).not.toContain("PfFj7TdhlT");
  });
});

describe("addRedditLinkRewrites", () => {
  test("replaces a link-only message with cleaned links credited to the poster", async () => {
    const {create} = setupHandlers(createResolver());
    const message = createRedditMessage(
      `https://www.reddit.com/r/pics/comments/5sfexx/slug/?share_id=abc&utm_source=share\n${shareLink}`,
    );

    await create(message);

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(message.channel.send).toHaveBeenCalledWith({
      allowedMentions: {parse: []},
      content: `From <@${message.author?.id}>: https://vxreddit.com/r/pics/comments/5sfexx/slug/\n${shareFixed}`,
    });
    expect(message.reply).not.toHaveBeenCalled();
  });

  test("leaves an unresolved share link alone", async () => {
    const {create} = setupHandlers(createResolver({}));
    const message = createRedditMessage(shareLink);

    await create(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  test("keeps the message when one of its share links cannot be resolved", async () => {
    const {create} = setupHandlers(createResolver({}));
    const message = createRedditMessage(`https://redd.it/5sfexx ${shareLink}`);

    await create(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith({
      allowedMentions: noPing,
      content: "https://vxreddit.com/comments/5sfexx/",
    });
  });

  test("replies to messages with surrounding text and suppresses the broken preview", async () => {
    const {create, update} = setupHandlers(createResolver());
    const message = createRedditMessage(`look at this ${shareLink}`);

    await create(message);
    await update({}, {...message, embeds: [{}]});

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith({allowedMentions: noPing, content: shareFixed});
    expect(message.suppressEmbeds).toHaveBeenCalledWith(true);
  });

  test("leaves clean link-only proxy links alone", async () => {
    const {create} = setupHandlers(createResolver());
    const message = createRedditMessage("https://vxreddit.com/r/pics/comments/5sfexx/slug/");

    await create(message);

    expect(message.delete).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
  });

  test("logs failures with the Reddit site name", async () => {
    const {create} = setupHandlers(createResolver());
    const message = createRedditMessage("see https://redd.it/5sfexx");
    message.reply.mockRejectedValueOnce(new Error("missing permissions"));

    await create(message);

    expect(loggerMock.log).toHaveBeenCalledWith("error", "Error sending fixed Reddit link: Error: missing permissions");
  });

  test("resolves share links over the network by default", async () => {
    headMock.mockResolvedValueOnce({headers: {location: shareTarget}});
    const {create} = setupHandlers();
    const message = createRedditMessage(shareLink);

    await create(message);

    expect(message.channel.send).toHaveBeenCalledWith({
      allowedMentions: {parse: []},
      content: `From <@${message.author?.id}>: ${shareFixed}`,
    });
  });
});
