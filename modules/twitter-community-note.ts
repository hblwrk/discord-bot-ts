import {escapeMarkdown, type APIEmbedField} from "discord.js";

export type TwitterCommunityNote = {text: string; sourceUrls: string[]};

// FxTwitter v2 exposes X's birdwatch_pivot subtitle, not a note ID or rating
// history. Preserve attribution rather than treating it as a verified verdict.
export function parseTwitterCommunityNote(value: unknown): TwitterCommunityNote | undefined {
  if (!isRecord(value) || "string" !== typeof value["text"]
    || !value["text"].replace(/[\p{Cc}\p{Cf}]/gu, " ").trim() || value["text"].length > 8_000) {
    return undefined;
  }
  const text = value["text"];
  const sources = new Set<string>();
  const replaced = new Set<string>();
  const facets = Array.isArray(value["facets"]) ? value["facets"] : [];
  for (const facet of facets.slice(0, 50)) {
    if (!isRecord(facet) || facet["type"] !== "url") {
      continue;
    }
    const indices = facet["indices"];
    if (!Array.isArray(indices) || indices.length !== 2) {
      continue;
    }
    const [start, end] = indices as unknown[];
    if ("number" !== typeof start || "number" !== typeof end
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= end || end > text.length) {
      continue;
    }
    const url = sourceUrl(facet["replacement"]);
    if (undefined !== url) {
      sources.add(url);
      replaced.add(text.slice(start, end));
    }
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    const original = match[0].replace(/[.,!?;:)\]}]+$/u, "");
    const url = sourceUrl(original);
    if (undefined !== url && !replaced.has(original)) {
      sources.add(url);
    }
  }
  return {text, sourceUrls: [...sources].slice(0, 10)};
}

export function communityNoteField(note: TwitterCommunityNote, postId: string): APIEmbedField {
  // Quote a bounded excerpt as plain text: remote content cannot create mentions
  // or disguised Markdown links. Sources remain separately attributed links.
  const plain = note.text.replace(/https?:\/\/\S+/giu, "[link]")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim()
    .replace(/@/gu, "@\u200b").replace(/</gu, "＜").replace(/>/gu, "＞");
  const escaped = escapeMarkdown(plain).replace(/[[\]()]/gu, char => `\\${char}`);
  const excerpt = escaped.length > 320 ? `${escaped.slice(0, 319).replace(/\\$/u, "")}…` : escaped;
  const source = note.sourceUrls[0];
  const links = [`[Read post on X](https://x.com/i/status/${postId})`];
  if (undefined !== source) {
    links.push(`[Note source](${source})`);
  }
  return {
    name: "Community Note via FxTwitter (excerpt)",
    value: `> ${excerpt}\n${links.join(" · ")}\nRating status and cited evidence are unverified.`,
  };
}

function sourceUrl(value: unknown): string | undefined {
  if ("string" !== typeof value || value.length > 350) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port) {
      const href = url.href.replace(/[()[\]<>\\]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      return href.length <= 350 ? href : undefined;
    }
  } catch {
    // Note citations are displayed without fetching their destinations.
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && !Array.isArray(value);
}
