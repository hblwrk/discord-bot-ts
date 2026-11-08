import {type MarketCloseTickerFact} from "./market-close-ticker-facts.ts";

const bullishMove = /\b(?:stieg(?:en)?|zogen|zog|legte(?:n)?\s+zu|gewann(?:en)?|stiegen|gained|rose)\b/iu;
const bearishMove = /\b(?:fiel(?:en)?|sank(?:en)?|sanken|verlor(?:en)?|gab(?:en)?\s+nach|sackte(?:n)?\s+ab|fell|declined)\b/iu;
const closingVerb = /\b(?:schloss(?:en)?|schlossen|beendete(?:n)?|endete(?:n)?|closed)\b/iu;
const bullishClose = /\b(?:höher|hoeher|fester|stärker|staerker|im\s+Plus|higher)\b/iu;
const bearishClose = /\b(?:tiefer|schwächer|schwaecher|im\s+Minus|lower)\b/iu;
const equitySubject = /\b(?:US-Aktien|US-Indizes|Aktienmärkte|Aktienmaerkte|Indizes|Aktienindizes)\b/iu;
const tickerPattern = /\b(?:ES|NQ|RTY|VIX)\b/giu;
const tickerClaims = /\b((?:ES|NQ|RTY|VIX)(?:\s+(?:und|sowie|&)\s+(?:ES|NQ|RTY|VIX))*)\b((?:(?!\b(?:ES|NQ|RTY|VIX)\b).)*)/giu;

export function getMarketCloseDirectionValidationIssue(
  value: string,
  facts: MarketCloseTickerFact[],
): string | undefined {
  // Bound direction claims to clauses so a falling VIX or another ticker does
  // not turn a correct positive equity statement into a contradiction.
  const clauses = value.replace(/[*`]/gu, "").split(
    /[.!?](?=\s|$)|[\n;:]|,(?!\d)|\b(?:während|waehrend|aber|hingegen|dagegen)\b/iu,
  );
  for (const clause of clauses) {
    const symbols = clause.match(tickerPattern) ?? [];
    if (0 < symbols.length) {
      for (const match of clause.matchAll(tickerClaims)) {
        const claim = 1 === symbols.length ? clause : match[0];
        const direction = getClaimDirection(claim);
        const subjects = match[1]?.match(tickerPattern) ?? [];
        const contradictedFact = facts.find(fact =>
          subjects.some(symbol => symbol.toUpperCase() === fact.symbol) &&
          undefined !== direction && contradictsChange(claim, direction, fact));
        if (undefined !== contradictedFact) {
          return `output direction contradicted ticker facts for ${contradictedFact.symbol}`;
        }
      }
    } else if (equitySubject.test(clause)) {
      const direction = getClaimDirection(clause);
      const equities = facts.filter(fact => "VIX" !== fact.symbol);
      if (undefined !== direction && 3 === equities.length && equities.every(fact => contradictsChange(clause, direction, fact))) {
        return "output market direction contradicted ticker facts";
      }
    }
  }

  return undefined;
}

function getClaimDirection(clause: string): -1 | 1 | undefined {
  // Explicit intraday moves and moves from an extreme can coexist with a net
  // gain/loss. Closing claims still use the net change even in such a clause.
  const closing = closingVerb.test(clause);
  if (false === closing && /\b(?:intraday|zwischenzeitlich|zeitweise|früh|frueh|zunächst|zunaechst|vom\s+(?:Tageshoch|Hoch|Tagestief|Tief)|vom\s+Hoch\s+zum\s+Close)\b/iu.test(clause)) {
    return undefined;
  }

  if (/\b(?:nicht|kein(?:e|en)?)\s+(?:gefallen|gestiegen|höher|tiefer|schwächer|fester)\b|\b(?:fiel|stieg|schloss)\s+nicht\b/iu.test(clause)) {
    return undefined;
  }

  const bullish = bullishMove.test(clause) || (closing && bullishClose.test(clause));
  const bearish = bearishMove.test(clause) || (closing && bearishClose.test(clause));
  if (bullish === bearish) {
    return undefined;
  }

  return bullish ? 1 : -1;
}

function contradictsChange(clause: string, direction: -1 | 1, fact: MarketCloseTickerFact): boolean {
  // A claim explicitly measured from the open uses that baseline. Unqualified
  // day/session claims use the bot/close-to-close change printed in the recap.
  const fromOpen = /\b(?:vom|ab|seit(?:\s+dem)?|gegenüber(?:\s+dem)?|gegenueber(?:\s+dem)?|über(?:\s+dem)?|ueber(?:\s+dem)?|unter(?:\s+dem)?)\s+(?:Open|Eröffnung|Eroeffnung)|\bOpen-to-close\b/iu.test(clause);
  const change = fromOpen ? fact.openToCloseChangePercent : fact.closeChangePercent;
  if (undefined === change) {
    return false;
  }

  return direction * change <= -0.1;
}
