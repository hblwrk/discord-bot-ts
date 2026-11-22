import axios from "axios";
import {getLogger} from "./logging.ts";
import {
  addLinkRewriteHandlers,
  buildLinkRewriteResult,
  getLinkCandidates,
  type LinkRewriteClient,
  type LinkRewriteResult,
  type ParsedRewriteLink,
  type RewriteSource,
} from "./link-rewrite-handler.ts";

const logger = getLogger();

// vxReddit serves Discord the title, images, galleries and videos with sound
// that reddit.com withholds from link crawlers.
const rewriteHost = "vxreddit.com";
const redditHosts = new Set([
  "reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "np.reddit.com",
  "m.reddit.com",
  "sh.reddit.com",
  "amp.reddit.com",
  "i.reddit.com",
]);
const redditShortHost = "redd.it";
// Embed proxies whose previews already work; their links keep their host.
const redditProxyHosts = new Set(["vxreddit.com"]);
// /comments/<post>[/<slug>[/<comment>]], optionally under /r/<subreddit>,
// /u/<user> or /user/<user>. Comment links from the current site use
// "comment" in place of the slug.
const postPathRegex = /^(\/(?:r|u|user)\/[\w.-]{1,32})?\/comments\/([0-9a-z]{1,13})(?:\/([\w%-]{1,300})(?:\/([0-9a-z]{1,13}))?)?\/?$/u;
// redd.it/<post>; vxReddit serves the same short form.
const shortPathRegex = /^\/([0-9a-z]{1,13})\/?$/u;
// reddit.com/gallery/<post> opens the post that holds the gallery.
const galleryPathRegex = /^\/gallery\/([0-9a-z]{1,13})\/?$/u;
// /r/<subreddit>/s/<token> links from the app's share button. The token
// identifies the sharing account, and Reddit redirects it to the post with a
// share_id parameter that does the same.
const sharePathRegex = /^\/(?:r|u|user)\/[\w.-]{1,32}\/s\/[0-9A-Za-z]{6,20}\/?$/u;
const shareResolveTimeoutMs = 5_000;
// Bounds the outbound requests a single message can trigger.
const maxShareLinksPerMessage = 3;

type RedditLocation = {
  url: URL;
  host: string;
  source: RewriteSource;
};

type RedditPostPath = {
  // Canonical vxReddit path.
  path: string;
  key: string;
  // Whether vxReddit serves the pasted path as it is.
  servedByProxy: boolean;
};

export type ShareLinkResolver = (sharePath: string) => Promise<string | undefined>;

function getRedditLocation(value: string): RedditLocation | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if ("" !== url.username || "" !== url.password || "" !== url.port) {
    return undefined;
  }

  const host = url.hostname.startsWith("www.") ? url.hostname.slice(4) : url.hostname;
  if (redditHosts.has(host) || redditShortHost === host) {
    return {url, host, source: "original"};
  }

  if (redditProxyHosts.has(host)) {
    return {url, host, source: "proxy"};
  }

  return undefined;
}

function getPostPath(location: RedditLocation): RedditPostPath | undefined {
  const {pathname} = location.url;
  if (redditShortHost !== location.host) {
    const postMatch = postPathRegex.exec(pathname);
    if (null !== postMatch) {
      const [, prefix = "", post, slug, comment] = postMatch;
      const slugPath = undefined === slug ? "" : `/${slug}`;
      const commentPath = undefined === comment ? "" : `/${comment}`;
      return {path: `${prefix}/comments/${post}${slugPath}${commentPath}/`, key: `${post}:${comment ?? ""}`, servedByProxy: true};
    }

    const galleryMatch = galleryPathRegex.exec(pathname);
    if (null !== galleryMatch) {
      return {path: `/comments/${galleryMatch[1]}/`, key: `${galleryMatch[1]}:`, servedByProxy: false};
    }
  }

  // Single-segment paths on reddit.com are site pages, not posts.
  if (redditShortHost === location.host || "proxy" === location.source) {
    const shortMatch = shortPathRegex.exec(pathname);
    if (null !== shortMatch) {
      return {path: `/comments/${shortMatch[1]}/`, key: `${shortMatch[1]}:`, servedByProxy: true};
    }
  }

  return undefined;
}

function getSharePath(location: RedditLocation): string | undefined {
  return redditShortHost !== location.host && sharePathRegex.test(location.url.pathname)
    ? location.url.pathname
    : undefined;
}

// Rebuilds a post or comment link from its path alone. Every query parameter
// (share_id, which ties a link to the account that shared it, utm_* campaign
// tags, context), the fragment and any credentials are discarded. Share links
// are replaced by the post they resolve to. URLs with credentials or a port
// are left alone.
function parseRedditLink(value: string, resolvedShares: ReadonlyMap<string, string | undefined>): ParsedRewriteLink | undefined {
  const location = getRedditLocation(value);
  if (undefined === location) {
    return undefined;
  }

  const sharePath = getSharePath(location);
  if (undefined !== sharePath) {
    const target = resolvedShares.get(sharePath);
    const targetLocation = undefined === target ? undefined : getRedditLocation(target);
    // A redirect elsewhere (a subreddit for an unknown token, a login page)
    // leaves the link alone.
    const targetPost = undefined === targetLocation || "original" !== targetLocation.source
      ? undefined
      : getPostPath(targetLocation);
    return undefined === targetPost
      ? undefined
      : {url: `https://${rewriteHost}${targetPost.path}`, source: location.source, key: targetPost.key};
  }

  const post = getPostPath(location);
  if (undefined === post) {
    return undefined;
  }

  if ("proxy" === location.source) {
    const path = post.servedByProxy ? location.url.pathname : post.path;
    return {url: `https://${location.url.hostname}${path}`, source: "proxy", key: post.key};
  }

  return {url: `https://${rewriteHost}${post.path}`, source: "original", key: post.key};
}

// Reddit answers a share link with a redirect to the post. Only the Location
// header is read; the redirect is not followed.
export async function resolveRedditShareLink(sharePath: string): Promise<string | undefined> {
  try {
    const response = await axios.head(`https://www.reddit.com${sharePath}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; bot)",
      },
      maxRedirects: 0,
      timeout: shareResolveTimeoutMs,
      validateStatus: (status: number) => 300 <= status && status < 400,
    });
    const location: unknown = response.headers["location"];
    return "string" === typeof location ? new URL(location, "https://www.reddit.com").href : undefined;
  } catch (error: unknown) {
    logger.log(
      "warn",
      `Error resolving Reddit share link: ${error}`,
    );
    return undefined;
  }
}

// Reddit post and comment links in paste order, cleaned and deduplicated by
// post and comment. Bracket-suppressed links are skipped; spoilers are kept.
// Share links are resolved first, up to maxShareLinksPerMessage per message.
export async function getRedditLinks(
  content: string,
  resolveShareLink: ShareLinkResolver = resolveRedditShareLink,
): Promise<LinkRewriteResult> {
  const candidates = getLinkCandidates(content);
  const sharePaths = new Set<string>();
  for (const candidate of candidates) {
    const location = getRedditLocation(candidate.url);
    const sharePath = undefined === location ? undefined : getSharePath(location);
    if (undefined !== sharePath && sharePaths.size < maxShareLinksPerMessage) {
      sharePaths.add(sharePath);
    }
  }

  const resolvedShares = new Map(await Promise.all(
    [...sharePaths].map(async sharePath => [sharePath, await resolveShareLink(sharePath)] as const),
  ));

  return buildLinkRewriteResult(candidates.map(candidate => ({
    candidate,
    parsed: parseRedditLink(candidate.url, resolvedShares),
  })));
}

export function addRedditLinkRewrites(client: LinkRewriteClient, resolveShareLink: ShareLinkResolver = resolveRedditShareLink) {
  addLinkRewriteHandlers(client, {
    siteName: "Reddit",
    getLinks: content => getRedditLinks(content, resolveShareLink),
  });
}
