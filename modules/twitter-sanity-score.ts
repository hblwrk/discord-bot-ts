export type TwitterPostContext = {
  text: string;
  quotedText: string;
  media: string[];
  externalLinks: string[];
  authorJoined: string;
  defaultAvatar: boolean;
  authorWebsite: string;
};

export type TwitterSanityScore = {
  score: number;
  signals: string[];
  realityCheck: string;
};

// A small editorial index, not a calibrated probability of falsehood.
// Score only the poster's own text; quoting inflammatory words does not mean
// endorsing them, and engagement totals cannot establish coordinated bots.
export function scoreTwitterPost(post: TwitterPostContext, nowMs: number): TwitterSanityScore {
  const text = post.text.replace(/https?:\/\/\S+/giu, "");
  const signals: string[] = [];
  let score = 10;
  const rules: [RegExp, number, string][] = [
    [/\b(?:they (?:are )?hid(?:e|ing) (?:this|it) from you|(?:mainstream media|(?:the )?media|msm) (?:won['’]?t|will not|doesn['’]?t) (?:show|tell|report)|what they don['’]?t want you to know)\b/iu, 30, "Concealment framing"],
    [/\bbig if true\b/iu, 20, "Speculation presented as a hook"],
    [/\b(?:share (?:this )?before (?:it['’]?s|they)|wake up|spread (?:this|the truth)|must (?:watch|share|see))\b/iu, 20, "Pressure to react or re-share"],
    [/\b(?:traitors?|sheeple|enemies of the people|brainwashed|you are being lied to)\b/iu, 20, "Us-versus-them framing"],
    [/[!?]{3,}/u, 10, "Repeated alarm punctuation"],
  ];
  for (const [pattern, weight, signal] of rules) {
    if (pattern.test(text)) {
      score += weight;
      signals.push(signal);
    }
  }

  // Ignore short acronyms/tickers and require enough prose to measure shouting.
  const words = text.match(/\p{L}{4,}/gu) ?? [];
  const caps = words.filter(word => word === word.toLocaleUpperCase() && word !== word.toLocaleLowerCase());
  if (words.length >= 5 && caps.length / words.length >= 0.6) {
    score += 20;
    signals.push("Heavy ALL-CAPS wording");
  }
  if (signals.length > 0 && /[🧵👇]/u.test(text)) {
    score += 5;
    signals.push("Thread/click hook alongside sensational wording");
  }
  if (post.externalLinks.length > 0 && post.externalLinks.every(link => isSocialCitation(link))) {
    score += 10;
    signals.push("Links only to social posts; original evidence is unclear");
  }

  const ageMs = nowMs - Date.parse(post.authorJoined);
  if (post.defaultAvatar && ageMs >= 0 && ageMs <= 30 * 24 * 60 * 60_000) {
    score += 10;
    signals.push("Recent account with a default avatar; identity is unestablished");
  }

  return {
    score: Math.min(95, score),
    signals,
    realityCheck: signals.length > 0
      ? "These are caution signals, so check the original evidence before sharing; the claim and bot activity remain unverified."
      : "Few sensational wording signals appear, but calm wording does not verify the claim or the media context.",
  };
}

function isSocialCitation(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\./u, "");
    return ["x.com", "twitter.com", "fxtwitter.com", "mobile.twitter.com", "mobile.x.com", "m.twitter.com"].includes(host);
  } catch {
    return false;
  }
}
