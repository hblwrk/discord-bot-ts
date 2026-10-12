import type {APIEmbed} from "discord.js";
import {getWithRetry} from "./http-retry.ts";
import {safeHttpsAgent} from "./safe-http.ts";
import {crossCheckTwitterPost, hasIndependentContradictionSources, recognisedSourceUrl, type TwitterRealityCheck} from "./twitter-sanity-check.ts";
import {researchTwitterSource, unresearchedTwitterSource, type TwitterSourceCredibility} from "./twitter-source-credibility.ts";
import {scoreTwitterPost, type TwitterPostContext, type TwitterSanityScore} from "./twitter-sanity-score.ts";
import {communityNoteField, parseTwitterCommunityNote} from "./twitter-community-note.ts";
import {getTwitterStatusId} from "./twitter-status-url.ts";
import {isAiProviderAvailable, type AiProviderDependencies} from "./ai-provider.ts";
import {appendTwitterBadgeText} from "./twitter-badge-text.ts";
import {isClearlyNonFactualTeaser} from "./twitter-post-eligibility.ts";

type TwitterSanityDependencies = AiProviderDependencies & {
  getWithRetryFn?: typeof getWithRetry;
  crossCheckFn?: typeof crossCheckTwitterPost;
  credibilityFn?: typeof researchTwitterSource;
  aiAvailableFn?: () => boolean;
};

export type TwitterIntrospector = ((url: string) => Promise<APIEmbed | undefined>) & {
  observe?: (url: string, onBadge: (badge: APIEmbed) => void) => Promise<APIEmbed | undefined>;
};

type CacheEntry = {
  expiresAt: number;
  result: Promise<APIEmbed | undefined>;
  latest: APIEmbed | undefined;
  listeners: Set<(badge: APIEmbed) => void>;
};

type AssessmentResult = {badge: APIEmbed | undefined; retryable: boolean};

export function createTwitterIntrospector(dependencies: TwitterSanityDependencies): TwitterIntrospector {
  const cache = new Map<string, CacheEntry>();
  let inFlight = 0;
  const start = (link: string, onBadge?: (badge: APIEmbed) => void): Promise<APIEmbed | undefined> => {
    const id = getTwitterStatusId(link);
    if (undefined === id) {
      return Promise.resolve(undefined);
    }
    const url = `https://fxtwitter.com/i/status/${id}`;
    const nowMs = dependencies.nowMs?.() ?? Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= nowMs) {
        cache.delete(key);
      }
    }
    const cached = cache.get(id);
    if (undefined !== cached) {
      if (undefined !== onBadge) {
        cached.listeners.add(onBadge);
        if (undefined !== cached.latest) onBadge(cached.latest);
        void cached.result.then(() => { cached.listeners.delete(onBadge); }, () => { cached.listeners.delete(onBadge); });
      }
      return cached.result;
    }
    if (inFlight >= 4) {
      return Promise.resolve(undefined);
    }
    if (cache.size >= 100) {
      const oldest = cache.keys().next().value;
      if (undefined !== oldest) {
        cache.delete(oldest);
      }
    }
    inFlight++;
    const entry: CacheEntry = {expiresAt: nowMs + 10 * 60_000, result: Promise.resolve(undefined), latest: undefined, listeners: new Set()};
    if (undefined !== onBadge) entry.listeners.add(onBadge);
    let visibleBadge = "";
    const publish = (badge: APIEmbed) => {
      entry.latest = badge;
      const nextVisibleBadge = appendTwitterBadgeText("", [{linkNumber: 1, embed: badge}], false);
      if (nextVisibleBadge === visibleBadge) return;
      visibleBadge = nextVisibleBadge;
      for (const listener of entry.listeners) {
        try { listener(badge); } catch { /* A delivery failure cannot stop the assessment. */ }
      }
    };
    const result: Promise<APIEmbed | undefined> = assessTwitterPost(id, url, dependencies, publish).then(({badge, retryable}) => {
      // Retry failed optional reviews on the next paste; cache conclusive
      // assessments, including posts that need no badge.
      if (retryable && cache.get(id)?.result === result) cache.delete(id);
      entry.latest = badge;
      return badge;
    }).finally(() => { inFlight--; entry.listeners.clear(); });
    entry.result = result;
    cache.set(id, entry);
    return result;
  };
  const introspect: TwitterIntrospector = link => start(link);
  introspect.observe = (link, onBadge) => start(link, onBadge);
  return introspect;
}

async function assessTwitterPost(
  id: string, url: string, dependencies: TwitterSanityDependencies, publish: (badge: APIEmbed) => void,
): Promise<AssessmentResult> {
  try {
    const response = await (dependencies.getWithRetryFn ?? getWithRetry)(
      `https://api.fxtwitter.com/2/status/${id}`,
      {
        httpsAgent: safeHttpsAgent,
        maxContentLength: 512_000,
        maxRedirects: 0,
      },
      {maxAttempts: 1, timeoutMs: 5_000},
    );
    const post = parseTwitterPost(response.data, id);
    if (undefined === post) {
      return {badge: undefined, retryable: true};
    }
    if (isClearlyNonFactualTeaser(post)) {
      return {badge: undefined, retryable: false};
    }
    const aiAvailable = dependencies.aiAvailableFn?.() ?? isAiProviderAvailable(dependencies);
    const reviewDependencies = {
      ...dependencies, logger: {log: (_level, message) => { dependencies.logger.log("debug", message); }},
    } satisfies AiProviderDependencies;
    // Start all three evaluations together. Wording is local; the two web
    // requests can finish in either order without holding up one another.
    const wordingPromise = Promise.resolve().then(() => scoreTwitterPost(post));
    const checkPromise = Promise.resolve().then(() => aiAvailable
      ? (dependencies.crossCheckFn ?? crossCheckTwitterPost)(post, reviewDependencies) : undefined)
      .catch(() => {
        dependencies.logger.log("debug", "Twitter/X web cross-check skipped; keeping the link preview.");
        return undefined;
      });
    let sourceSettled = false;
    const credibilityPromise = Promise.resolve().then(() => aiAvailable
      ? (dependencies.credibilityFn ?? researchTwitterSource)(post, reviewDependencies)
      : unresearchedTwitterSource(post, dependencies.nowMs?.() ?? Date.now()))
      .catch((): TwitterSourceCredibility => ({target: "unidentified", label: "source not identified", verdict: "unverified"}))
      .then(value => { sourceSettled = true; return value; });
    const assessment = await wordingPromise;
    const pending = buildTwitterBadge(url, id, post, assessment, undefined, undefined, aiAvailable);
    if (undefined !== pending) publish(pending);
    const check = await checkPromise;
    if (!sourceSettled) {
      const interim = buildTwitterBadge(url, id, post, assessment, check);
      if (undefined !== interim) publish(interim);
    }
    const credibility = await credibilityPromise;
    const final = buildTwitterBadge(url, id, post, assessment, check, credibility);
    if (undefined !== final) publish(final);
    return {badge: final, retryable: undefined === check};
  } catch {
    // Never log provider bodies, tweet text or URLs from remote errors.
    dependencies.logger.log("debug", "Twitter/X introspection skipped; keeping the link preview.");
    return {badge: undefined, retryable: true};
  }
}

function buildTwitterBadge(
  url: string, id: string, post: TwitterPostContext, assessment: TwitterSanityScore,
  check: TwitterRealityCheck | undefined, credibility?: TwitterSourceCredibility, factPending = false,
): APIEmbed | undefined {
  // Missing reputation evidence is neutral. A documented concern can block
  // green, while account-only cautions need corroboration from each other or
  // mildly concerning wording. The posting account cannot rescue a linked
  // source: source research chooses the link before the account.
  const accountCautions = credibility?.target === "posting account" ? credibility.cautions?.length ?? 0 : 0;
  const posterCaution = accountCautions >= 2 || (accountCautions >= 1 && assessment.score >= 20);
  const greenStatus = undefined !== credibility && assessment.score < 30 && check?.verdict === "supported"
    && credibility.verdict !== "concerns" && !posterCaution;
  const redStatus = check?.verdict === "contradicted" && hasIndependentContradictionSources(check.sources);
  const tier = redStatus
    ? {icon: "🔴", label: "Claim contradicted", color: 0xe74c3c}
    : greenStatus
    ? {icon: "🟢", label: credibility?.target === "linked source" && credibility.verdict === "credible"
      ? "Supported claim, low spice, credible source" : "Supported claim, low spice", color: 0x2ecc71}
    : {icon: "🟡", label: check?.verdict === "contradicted" ? "Claim contradicted"
      : credibility?.verdict === "concerns" ? "Source credibility concerns"
        : assessment.score >= 30 ? "Wording caution"
          : factPending ? "Fact check pending"
            : undefined === check ? "Fact check unverified"
            : undefined === credibility ? "Source check pending" : "Account caution", color: 0xf1c40f};
  // Reserve the available required assessments before optional note/context
  // fields so a long note cannot remove their evidence from the badge.
  const fields: NonNullable<APIEmbed["fields"]> = [{
    name: `AI web cross-check: ${check?.verdict ?? (factPending ? "pending" : "unverified")} (review sources)`,
    value: check?.sources.map((source, index) => `[Source ${index + 1}](${source.replace(/\(/gu, "%28").replace(/\)/gu, "%29")})`).join(" · ")
      ?? (factPending ? "Review pending" : "Independent evidence unavailable"),
  }];
  if (undefined !== credibility) fields.push({
    name: `Source credibility: ${credibility.verdict} (${credibility.target === "linked source" ? "linked site" : credibility.label})`,
    value: [...(credibility.cautions ?? []), undefined === credibility.source
      ? "Independent evidence unavailable"
      : `[Evidence](${credibility.source.replace(/\(/gu, "%28").replace(/\)/gu, "%29")})`].join(" · "),
  });
  if (undefined !== post.communityNote) {
    fields.push(communityNoteField(post.communityNote, id));
  }
  if (assessment.signals.length > 0) {
    fields.push({name: "Signals", value: assessment.signals.join(" · ")});
  }
  const context = [
    ...post.media,
    ...(post.quotedText ? ["Quoted post present"] : []),
    ...(post.externalLinks.length ? [`${post.externalLinks.length} embedded link(s)`] : []),
    ...(recognisedSourceUrl(post.authorWebsite, true) ? ["Profile links to a recognised news/fact-check domain (identity unverified)"] : []),
  ];
  if (context.length > 0) {
    fields.push({name: "Context", value: context.join(" · ")});
  }
  const description = check?.sentence ?? (factPending ? "Factual check pending." : "Factual check inconclusive or unavailable.");
  const title = `${tier.icon} ${assessment.score}% Spiciness — ${tier.label}`;
  const footer = {text: "Heuristic index, not a truth probability · Media authenticity and bot activity unverified"};
  // Bound each assessment before delivery. The text formatter applies the
  // shared message budget and omits assessments that cannot fit completely.
  let remaining = 1_500 - title.length - description.length - footer.text.length;
  const boundedFields = fields.filter(field => {
    const length = field.name.length + field.value.length;
    if (length > remaining) {
      return false;
    }
    remaining -= length;
    return true;
  });
  if (boundedFields[0] !== fields[0] || (undefined !== credibility && boundedFields[1] !== fields[1])) {
    return undefined;
  }
  return {
    url,
    title,
    color: tier.color,
    description,
    fields: boundedFields,
    footer,
  };
}

export function parseTwitterPost(value: unknown, expectedId: string): TwitterPostContext | undefined {
  // API v2 uses HTTP status and a status envelope without the legacy code field.
  if (!isRecord(value) || (undefined !== value["code"] && value["code"] !== 200)) {
    return undefined;
  }
  const post = value["status"];
  if (!isRecord(post) || (undefined !== post["type"] && post["type"] !== "status")
    || post["id"] !== expectedId || "string" !== typeof post["text"]
    || !post["text"].trim() || post["text"].length > 8_000) {
    return undefined;
  }
  const author = recordOrEmpty(post["author"]);
  const media = recordOrEmpty(post["media"]);
  const links = extractPostLinks(post);
  const quote = recordOrEmpty(post["quote"]);
  const quotedLinks = extractPostLinks(quote);
  const handle = stringOrEmpty(author["screen_name"]);
  const authorHandle = /^[A-Za-z0-9_]{1,15}$/u.test(handle) ? handle : undefined;
  const followers = author["followers"];
  const authorFollowers = typeof followers === "number" && Number.isSafeInteger(followers) && followers >= 0
    ? followers : undefined;
  const mediaContext: string[] = [];
  for (const [key, label] of [["photos", "Photo(s)"], ["videos", "Video(s)"]] as const) {
    const items = media[key];
    if (Array.isArray(items) && items.length > 0) {
      mediaContext.push(`${items.length} ${label}; content not inspected`);
    }
  }
  if (isRecord(media["external"])) {
    mediaContext.push("External media; content not inspected");
  }
  const communityNote = parseTwitterCommunityNote(post["community_note"]);
  return {
    text: post["text"],
    quotedText: stringOrEmpty(quote["text"]).slice(0, 2_000),
    media: mediaContext,
    externalLinks: links.slice(0, 10),
    ...(quotedLinks.length > 0 ? {quotedExternalLinks: quotedLinks.slice(0, 5)} : {}),
    ...(undefined !== authorHandle ? {authorHandle} : {}),
    authorJoined: stringOrEmpty(author["joined"]),
    ...(undefined !== authorFollowers ? {authorFollowers} : {}),
    defaultAvatar: /\/default_profile_images\//u.test(stringOrEmpty(author["avatar_url"])),
    authorWebsite: stringOrEmpty(recordOrEmpty(author["website"])["url"]).slice(0, 350),
    ...(undefined !== communityNote ? {communityNote} : {}),
  };
}

function extractPostLinks(post: Record<string, unknown>): string[] {
  const rawText = recordOrEmpty(post["raw_text"]);
  const facets = Array.isArray(rawText["facets"]) ? rawText["facets"] : [];
  const links = new Set<string>();
  const expandedOriginals = new Set<string>();
  for (const facet of facets.slice(0, 50)) {
    if (isRecord(facet) && facet["type"] === "url") {
      if (addExternalLink(links, facet["replacement"])) {
        addExternalLink(expandedOriginals, facet["original"]);
      }
    }
  }
  const textLinks = new Set<string>();
  for (const match of stringOrEmpty(post["text"]).matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    addExternalLink(textLinks, match[0].replace(/[.,!?;:)\]}]+$/u, ""));
  }
  for (const link of textLinks) {
    if (!expandedOriginals.has(link)) {
      links.add(link);
    }
  }
  return [...links];
}

function addExternalLink(links: Set<string>, value: unknown): boolean {
  if ("string" !== typeof value || value.length > 350) {
    return false;
  }
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
      links.add(url.href);
      return true;
    }
  } catch {
    // Metadata links are only context; the bot does not fetch these URLs.
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && !Array.isArray(value);
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringOrEmpty(value: unknown): string {
  return "string" === typeof value ? value : "";
}
