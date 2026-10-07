import type {APIEmbed} from "discord.js";
import {getWithRetry} from "./http-retry.ts";
import {safeHttpsAgent} from "./safe-http.ts";
import {crossCheckTwitterPost, recognisedSourceUrl} from "./twitter-sanity-check.ts";
import {scoreTwitterPost, type TwitterPostContext} from "./twitter-sanity-score.ts";
import {communityNoteField, parseTwitterCommunityNote} from "./twitter-community-note.ts";
import {getTwitterStatusId} from "./twitter-status-url.ts";
import {isAiProviderAvailable, type AiProviderDependencies} from "./ai-provider.ts";

type TwitterSanityDependencies = AiProviderDependencies & {
  getWithRetryFn?: typeof getWithRetry;
  crossCheckFn?: typeof crossCheckTwitterPost;
  aiAvailableFn?: () => boolean;
};

export type TwitterIntrospector = (url: string) => Promise<APIEmbed | undefined>;

export function createTwitterIntrospector(dependencies: TwitterSanityDependencies): TwitterIntrospector {
  const cache = new Map<string, {expiresAt: number; result: Promise<APIEmbed | undefined>}>();
  let inFlight = 0;
  return async link => {
    const id = getTwitterStatusId(link);
    if (undefined === id) {
      return undefined;
    }
    if (!(dependencies.aiAvailableFn?.() ?? isAiProviderAvailable(dependencies))) {
      return undefined;
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
      return cached.result;
    }
    if (inFlight >= 4) {
      return undefined;
    }
    if (cache.size >= 100) {
      const oldest = cache.keys().next().value;
      if (undefined !== oldest) {
        cache.delete(oldest);
      }
    }
    inFlight++;
    const result: Promise<APIEmbed | undefined> = assessTwitterPost(id, url, dependencies).then(badge => {
      // Failed optional reviews can recover on the next paste; retain only
      // successful assessments and coalesce the requests already in flight.
      if (undefined === badge && cache.get(id)?.result === result) cache.delete(id);
      return badge;
    }).finally(() => { inFlight--; });
    cache.set(id, {expiresAt: nowMs + 10 * 60_000, result});
    return result;
  };
}

async function assessTwitterPost(id: string, url: string, dependencies: TwitterSanityDependencies): Promise<APIEmbed | undefined> {
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
      return undefined;
    }
    const assessment = scoreTwitterPost(post, dependencies.nowMs?.() ?? Date.now());
    const check = undefined === post.communityNote && assessment.score >= 30
      ? await (dependencies.crossCheckFn ?? crossCheckTwitterPost)(post, {
        ...dependencies, logger: {log: (_level, message) => { dependencies.logger.log("debug", message); }},
      })
      : undefined;
    if (undefined === post.communityNote && assessment.score >= 30 && undefined === check) {
      return undefined;
    }
    const tier = assessment.score >= 70
      ? {icon: "🔴", label: "High sensationalism", color: 0xe74c3c}
      : assessment.score >= 30
        ? {icon: "🟡", label: "Caution", color: 0xf1c40f}
        : {icon: "🟢", label: "Low sensationalism", color: 0x2ecc71};
    const fields: NonNullable<APIEmbed["fields"]> = [];
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
    if (undefined !== check) {
      fields.push({
        name: `AI web cross-check: ${check.verdict} (review sources)`,
        value: check.sources.map((source, index) => `[Source ${index + 1}](${source.replace(/\(/gu, "%28").replace(/\)/gu, "%29")})`).join(" · "),
      });
    }
    const description = undefined !== post.communityNote
      ? "A Community Note adds context to this post; read the note and its cited evidence before sharing."
      : check?.sentence ?? assessment.realityCheck;
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
    return {
      url,
      title,
      color: tier.color,
      description,
      fields: boundedFields,
      footer,
    };
  } catch {
    // Never log provider bodies, tweet text or URLs from remote errors.
    dependencies.logger.log("debug", "Twitter/X introspection skipped; keeping the link preview.");
    return undefined;
  }
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
  for (const match of post["text"].matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    addExternalLink(textLinks, match[0].replace(/[.,!?;:)\]}]+$/u, ""));
  }
  for (const link of textLinks) {
    if (!expandedOriginals.has(link)) {
      links.add(link);
    }
  }
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
  const quote = recordOrEmpty(post["quote"]);
  const communityNote = parseTwitterCommunityNote(post["community_note"]);
  return {
    text: post["text"],
    quotedText: stringOrEmpty(quote["text"]).slice(0, 2_000),
    media: mediaContext,
    externalLinks: [...links].slice(0, 10),
    authorJoined: stringOrEmpty(author["joined"]),
    defaultAvatar: /\/default_profile_images\//u.test(stringOrEmpty(author["avatar_url"])),
    authorWebsite: stringOrEmpty(recordOrEmpty(author["website"])["url"]).slice(0, 350),
    ...(undefined !== communityNote ? {communityNote} : {}),
  };
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
