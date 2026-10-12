import type {TwitterPostContext} from "./twitter-sanity-score.ts";

const teaserCue = /\b(?:teaser|coming soon|stay tuned|save the date|premiere|debut|first look|reveal|unveil(?:ing)?|launch(?:ing)?|countdown|watch live|tune in)\b/iu;
const factualPredicate = /\b(?:is|are|was|were|has|have|had|can|could|did|does|will|report(?:s|ed)?|confirm(?:s|ed)?|found|shows?|showed|announced?|approved|banned|recalled|sold|shipped|delivered|built|produced|launched|released|published|halted|started|ended|won|lost|costs?|contains?|uses?|runs?|features?|fell|rose|increased|decreased|discovered|killed|injured|charged|canceled|cancelled|postponed|delayed)\b/iu;
const quantifiedClaim = /(?:\d[\d.,]*\s?%|\d[\d.,]*\s?(?:percent|hp|horsepower|kW|kWh|km|kilomet(?:er|re)s?|miles?|mph|million|billion|cars?|vehicles?|jobs?|people|units?|deaths?|injuries)\b|[$€£]\s?\d)/iu;

// Only suppress short promotional fragments with an explicit teaser cue and
// no apparent factual assertion. Ambiguous posts continue through review.
export function isClearlyNonFactualTeaser(post: TwitterPostContext): boolean {
  if (post.quotedText.trim() || post.externalLinks.length > 0 || (post.quotedExternalLinks?.length ?? 0) > 0
    || undefined !== post.communityNote) {
    return false;
  }
  const text = post.text.trim();
  if (text.length > 240 || (text.match(/\p{L}+/gu)?.length ?? 0) > 32 || /https?:\/\//iu.test(text)
    || !teaserCue.test(text) || quantifiedClaim.test(text)) {
    return false;
  }
  const withoutGenericHook = text
    .replace(/\b(?:something(?: big)?|the future|more) is coming(?: soon)?\b/giu, "")
    .replace(/\bthis is (?:just )?a teaser\b/giu, "")
    .replace(/\bwe will reveal more soon\b/giu, "")
    .replace(/\bjust announced\b/giu, "");
  return !factualPredicate.test(withoutGenericHook);
}
