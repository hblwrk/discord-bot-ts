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
import {isPotentialPrimaryStatement, researchTwitterPrimaryStatement, type TwitterPrimaryStatement} from "./twitter-primary-statement.ts";
import {checkTwitterPriceClaims, priceClaimInPost, type TwitterPriceCheck} from "./twitter-price-check.ts";

type TwitterSanityDependencies = AiProviderDependencies & {
  getWithRetryFn?: typeof getWithRetry;
  crossCheckFn?: typeof crossCheckTwitterPost;
  credibilityFn?: typeof researchTwitterSource;
  primaryStatementFn?: typeof researchTwitterPrimaryStatement;
  priceCheckFn?: typeof checkTwitterPriceClaims;
  aiAvailableFn?: () => boolean;
  primaryRetryDelayMs?: number;
};

export type TwitterIntrospector = ((url: string) => Promise<APIEmbed | undefined>) & {
  observe?: (url: string, onBadge: (badge: APIEmbed) => void) => Promise<APIEmbed | undefined>;
};

type CacheEntry = {
  expiresAt: number;
  result: Promise<APIEmbed | undefined>;
  latest: APIEmbed | undefined;
  listeners: Set<(badge: APIEmbed) => void>;
  retryPending: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
};

type AssessmentResult = {badge: APIEmbed | undefined; retryable: boolean;
  retry?: () => Promise<APIEmbed | undefined>};

export function createTwitterIntrospector(dependencies: TwitterSanityDependencies): TwitterIntrospector {
  const cache = new Map<string, CacheEntry>();
  let inFlight = 0;
  const discard = (id: string, entry: CacheEntry) => {
    if (undefined !== entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryPending = false;
    entry.listeners.clear();
    cache.delete(id);
  };
  const start = (link: string, onBadge?: (badge: APIEmbed) => void): Promise<APIEmbed | undefined> => {
    const id = getTwitterStatusId(link);
    if (undefined === id) {
      return Promise.resolve(undefined);
    }
    const url = `https://fxtwitter.com/i/status/${id}`;
    const nowMs = dependencies.nowMs?.() ?? Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= nowMs) {
        discard(key, entry);
      }
    }
    const cached = cache.get(id);
    if (undefined !== cached) {
      if (undefined !== onBadge) {
        cached.listeners.add(onBadge);
        if (undefined !== cached.latest) onBadge(cached.latest);
        void cached.result.then(() => {
          if (!cached.retryPending) cached.listeners.delete(onBadge);
        }, () => { cached.listeners.delete(onBadge); });
      }
      return cached.result;
    }
    if (inFlight >= 4) {
      return Promise.resolve(undefined);
    }
    if (cache.size >= 100) {
      const oldest = cache.keys().next().value;
      if (undefined !== oldest) {
        const oldestEntry = cache.get(oldest);
        if (undefined !== oldestEntry) discard(oldest, oldestEntry);
      }
    }
    inFlight++;
    const entry: CacheEntry = {expiresAt: nowMs + 10 * 60_000, result: Promise.resolve(undefined),
      latest: undefined, listeners: new Set(), retryPending: false};
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
    const startedAt = Date.now();
    const result: Promise<APIEmbed | undefined> = assessTwitterPost(id, url, dependencies, publish).then(({badge, retryable, retry}) => {
      // Retry failed optional reviews on the next paste; cache conclusive
      // assessments, including posts that need no badge.
      if (retryable && cache.get(id) === entry) discard(id, entry);
      entry.latest = badge;
      if (undefined !== retry && cache.get(id) === entry) {
        entry.retryPending = true;
        entry.retryTimer = setTimeout(() => {
          delete entry.retryTimer;
          if (cache.get(id) !== entry || Date.now() - startedAt > 3 * 60_000 || inFlight >= 4) {
            if (cache.get(id) === entry) discard(id, entry);
            return;
          }
          inFlight++;
          void retry().then(updated => {
            if (cache.get(id) !== entry) return;
            if (undefined === updated) {
              discard(id, entry);
              return;
            }
            publish(updated);
            entry.result = Promise.resolve(updated);
          }).catch(() => {
            dependencies.logger.log("debug", "Twitter/X short disclosure retry skipped.");
            if (cache.get(id) === entry) discard(id, entry);
          }).finally(() => {
            inFlight--;
            entry.retryPending = false;
            entry.listeners.clear();
          });
        }, Math.max(0, (dependencies.primaryRetryDelayMs ?? 45_000) - (Date.now() - startedAt)));
        entry.retryTimer.unref();
      }
      return badge;
    }).finally(() => {
      inFlight--;
      if (!entry.retryPending) entry.listeners.clear();
    });
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
    // Wording, factual research, source reputation, issuer attribution and
    // deterministic stock prices run without waiting on one another.
    const assessment = scoreTwitterPost(post);
    if (aiAvailable) publish({url, title: "🔎 Checking", description: "Review in progress."});
    let checkReady = false;
    let settledCheck: TwitterRealityCheck | undefined;
    let credibilityReady = false;
    let settledCredibility: TwitterSourceCredibility | undefined;
    let primaryReady = false;
    let settledPrimary: TwitterPrimaryStatement | undefined;
    let priceReady = false;
    let settledPrice: TwitterPriceCheck | undefined;
    const primaryCandidate = aiAvailable && isPotentialPrimaryStatement(post);
    const priceCandidate = undefined !== priceClaimInPost(post);
    const publishSettled = () => {
      let badge: APIEmbed | undefined;
      if (checkReady) {
        badge = credibilityReady && undefined !== settledCredibility
          ? buildFinalTwitterBadge(url, id, post, assessment, settledCheck, settledCredibility,
            primaryReady ? settledPrimary : undefined, primaryCandidate, settledPrice, priceCandidate && !priceReady)
          : buildTwitterBadge(url, id, post, assessment, settledCheck, undefined, false, settledPrice,
            priceCandidate && !priceReady);
      } else if (credibilityReady && undefined !== settledCredibility && primaryReady && undefined !== settledPrimary) {
        badge = buildFinalTwitterBadge(url, id, post, assessment, undefined, settledCredibility,
          settledPrimary, primaryCandidate, settledPrice, priceCandidate && !priceReady);
      } else if (priceReady && undefined !== settledPrice) {
        badge = buildTwitterBadge(url, id, post, assessment, undefined,
          credibilityReady ? settledCredibility : undefined, false, settledPrice);
      }
      if (undefined !== badge) publish(badge);
    };
    const checkPromise = Promise.resolve().then(() => aiAvailable
      ? (dependencies.crossCheckFn ?? crossCheckTwitterPost)(post, reviewDependencies) : undefined)
      .catch(() => {
        dependencies.logger.log("debug", "Twitter/X web cross-check skipped; keeping the link preview.");
        return undefined;
      }).then(value => { checkReady = true; settledCheck = value; publishSettled(); return value; });
    const credibilityPromise = Promise.resolve().then(() => aiAvailable
      ? (dependencies.credibilityFn ?? researchTwitterSource)(post, reviewDependencies)
      : unresearchedTwitterSource(post, dependencies.nowMs?.() ?? Date.now()))
      .catch((): TwitterSourceCredibility => ({target: "unidentified", label: "source not identified", verdict: "unverified"}))
      .then(value => { credibilityReady = true; settledCredibility = value; publishSettled(); return value; });
    const primaryPromise = Promise.resolve().then(() => primaryCandidate
      ? (dependencies.primaryStatementFn ?? researchTwitterPrimaryStatement)(post, reviewDependencies) : undefined)
      .catch(() => {
        dependencies.logger.log("debug", "Twitter/X primary statement check skipped.");
        return undefined;
      }).then(value => { primaryReady = true; settledPrimary = value; publishSettled(); return value; });
    const pricePromise = Promise.resolve().then(() => priceCandidate
      ? (dependencies.priceCheckFn ?? checkTwitterPriceClaims)(post, id, dependencies) : undefined)
      .catch(() => {
        dependencies.logger.log("debug", "Twitter/X stock quote check skipped.");
        return undefined;
      }).then(value => { priceReady = true; settledPrice = value; publishSettled(); return value; });
    const [check, credibility, primary, price] = await Promise.all([checkPromise, credibilityPromise, primaryPromise, pricePromise]);
    const final = buildFinalTwitterBadge(url, id, post, assessment, check, credibility, primary, primaryCandidate, price);
    if (undefined !== final) publish(final);
    const retry = aiAvailable && primaryCandidate && undefined === primary
      && (undefined === check || (check.verdict === "supported" && check.sources.length === 1))
      && assessment.score < 30 && credibility.verdict !== "concerns" && price?.verdict !== "contradicted"
      ? async () => {
        const later = await (dependencies.primaryStatementFn ?? researchTwitterPrimaryStatement)(post, reviewDependencies);
        return undefined === later ? undefined
          : buildFinalTwitterBadge(url, id, post, assessment, check, credibility, later, primaryCandidate, price);
      } : undefined;
    return {badge: final, retryable: undefined === check && undefined === primary && undefined === retry,
      ...(undefined === retry ? {} : {retry})};
  } catch {
    // Never log provider bodies, tweet text or URLs from remote errors.
    dependencies.logger.log("debug", "Twitter/X introspection skipped; keeping the link preview.");
    return {badge: undefined, retryable: true};
  }
}

function buildFinalTwitterBadge(
  url: string, id: string, post: TwitterPostContext, assessment: TwitterSanityScore,
  check: TwitterRealityCheck | undefined, credibility: TwitterSourceCredibility,
  primary: TwitterPrimaryStatement | undefined, primaryCandidate: boolean,
  price?: TwitterPriceCheck, pricePending = false,
): APIEmbed | undefined {
  if (undefined !== primary && !pricePending && assessment.score < 30 && check?.verdict !== "contradicted"
    && price?.verdict !== "contradicted"
    && !(credibility.target === "linked source" && credibility.verdict === "concerns")) {
    return {
      url,
      title: "ℹ️ Company statement",
      description: "The organization published these claims; this is source attribution, not independent verification.",
      fields: [{name: `Primary source: ${primary.organization}`,
        value: `[Source](${primary.source.replace(/\(/gu, "%28").replace(/\)/gu, "%29")})`}],
    };
  }
  if (primaryCandidate && !pricePending && assessment.score < 30 && check?.verdict === "supported"
    && check.sources.length === 1 && credibility.verdict !== "concerns" && price?.verdict !== "contradicted") {
    return {url, title: "ℹ️ Reported claim", description: "An accepted source reports this claim; issuer confirmation is not established.",
      fields: [{name: "Report source", value: `[Source](${check.sources[0]!.replace(/\(/gu, "%28").replace(/\)/gu, "%29")})`}]};
  }
  return buildTwitterBadge(url, id, post, assessment, check, credibility, false, price, pricePending);
}

function buildTwitterBadge(
  url: string, id: string, post: TwitterPostContext, assessment: TwitterSanityScore,
  check: TwitterRealityCheck | undefined, credibility?: TwitterSourceCredibility, factPending = false,
  price?: TwitterPriceCheck, pricePending = false,
): APIEmbed | undefined {
  // Missing reputation evidence is neutral. A documented concern can block
  // green, while account-only cautions need corroboration from each other or
  // mildly concerning wording. The posting account cannot rescue a linked
  // source: source research chooses the link before the account.
  const accountCautions = credibility?.target === "posting account" ? credibility.cautions?.length ?? 0 : 0;
  const posterCaution = accountCautions >= 2 || (accountCautions >= 1 && assessment.score >= 20);
  const greenStatus = undefined !== credibility && assessment.score < 30 && check?.verdict === "supported"
    && credibility.verdict !== "concerns" && !posterCaution && price?.verdict !== "contradicted" && !pricePending;
  const redStatus = check?.verdict === "contradicted" && hasIndependentContradictionSources(check.sources);
  const tier = redStatus
    ? {icon: "🔴", label: "Claim contradicted", color: 0xe74c3c}
    : price?.verdict === "contradicted"
    ? {icon: "🟡", label: "Price figure differs", color: 0xf1c40f}
    : greenStatus
    ? {icon: "🟢", label: credibility?.target === "linked source" && credibility.verdict === "credible"
      ? "Supported claim, low spice, credible source" : "Supported claim, low spice", color: 0x2ecc71}
    : {icon: "🟡", label: check?.verdict === "contradicted" ? "Claim contradicted"
      : credibility?.verdict === "concerns" ? "Source credibility concerns"
        : assessment.score >= 30 ? "Wording caution"
          : price?.verdict === "supported" && undefined === check ? "Price move checked"
          : pricePending && check?.verdict === "supported" ? "Price check pending"
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
  const priceField = undefined === price ? undefined : {
    name: `Stock quote: ${price.verdict}`,
    value: `[Source](${price.source.replace(/\(/gu, "%28").replace(/\)/gu, "%29")})`,
  };
  if (undefined !== priceField) fields.push(priceField);
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
  const description = price?.verdict === "contradicted" ? price.sentence
    : check?.sentence ?? price?.sentence ?? (factPending ? "Factual check pending." : "Factual check inconclusive or unavailable.");
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
  if (boundedFields[0] !== fields[0] || (undefined !== credibility && boundedFields[1] !== fields[1])
    || (undefined !== priceField && !boundedFields.includes(priceField))) {
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
    ...(typeof post["created_at"] === "string" ? {createdAt: post["created_at"].slice(0, 80)} : {}),
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
