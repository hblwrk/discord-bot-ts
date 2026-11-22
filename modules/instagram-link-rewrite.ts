import {
  addLinkRewriteHandlers,
  buildLinkRewriteResult,
  getLinkCandidates,
  type LinkRewriteClient,
  type LinkRewriteResult,
  type ParsedRewriteLink,
} from "./link-rewrite-handler.ts";

// Kirkstagram serves Discord the post metadata and media that instagram.com
// withholds from link crawlers.
const rewriteHost = "kirkstagram.com";
const instagramHosts = new Set(["instagram.com", "m.instagram.com", "instagr.am"]);
// Embed proxies whose previews already work; their links keep their host.
const instagramProxyHosts = new Set(["kirkstagram.com", "kkinstagram.com"]);
// Posts, reels and IGTV, optionally under a /<username>/ prefix, with the
// optional carousel position segment that the embed proxies accept.
const postPathRegex = /^\/(?:([\w.]{1,30})\/)?(p|reels?|tv)\/([\w-]{5,64})(?:\/([1-9]\d?))?\/?$/u;
// /share/p/<token> and /share/reel/<token> carry an opaque token that
// identifies the sharing account instead of the post shortcode.
const sharePathPrefix = "share";
// Instagram carousels hold at most 20 items.
const carouselIndexRegex = /^(?:[1-9]|1\d|20)$/u;

function getCarouselIndex(url: URL): string | undefined {
  const index = url.searchParams.get("img_index");
  return null !== index && carouselIndexRegex.test(index) ? index : undefined;
}

// Rebuilds a post link from its host, path and carousel position alone. Every
// other query parameter (igsh/igshid share ids that tie a link to the account
// that shared it, utm_* campaign tags), the fragment and any credentials are
// discarded. URLs with credentials or a port are left alone.
function parseInstagramLink(value: string): ParsedRewriteLink | undefined {
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
  const isRawInstagram = instagramHosts.has(host);
  if (false === isRawInstagram && false === instagramProxyHosts.has(host)) {
    return undefined;
  }

  const match = postPathRegex.exec(url.pathname);
  if (null === match || sharePathPrefix === match[1]?.toLowerCase()) {
    return undefined;
  }

  const [, , kindSegment, shortcode, pathIndex] = match;
  const index = pathIndex ?? getCarouselIndex(url);
  const key = `${shortcode}:${index ?? ""}`;
  if (isRawInstagram) {
    const kind = "reels" === kindSegment ? "reel" : kindSegment;
    const query = undefined === index ? "" : `?img_index=${index}`;
    return {url: `https://${rewriteHost}/${kind}/${shortcode}/${query}`, source: "original", key};
  }

  // Proxies keep their own path, including a carousel position segment.
  const query = undefined === pathIndex && undefined !== index ? `?img_index=${index}` : "";
  return {url: `https://${url.hostname}${url.pathname}${query}`, source: "proxy", key};
}

// Instagram post links in paste order, cleaned and deduplicated by post and
// carousel position. Bracket-suppressed links are skipped; spoilers are kept.
export function getInstagramLinks(content: string): LinkRewriteResult {
  return buildLinkRewriteResult(getLinkCandidates(content).map(candidate => ({
    candidate,
    parsed: parseInstagramLink(candidate.url),
  })));
}

export function addInstagramLinkRewrites(client: LinkRewriteClient) {
  addLinkRewriteHandlers(client, {
    siteName: "Instagram",
    getLinks: getInstagramLinks,
  });
}
