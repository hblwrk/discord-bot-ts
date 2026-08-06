// Terms used to qualify a financial caption, defined once each.
//
// These are gathered here because the same mistake kept being rebuilt per call site: `\b`
// needs a word character on one side of the boundary, so it behaves unexpectedly for a term
// that begins or ends with punctuation. Each export below records the wording that defeated
// a naive `\b`, so a future edit can see what the guard is for rather than reintroducing it.
//
// Pattern sources are exported as strings for composing into a larger pattern; predicates are
// exported where a call site only asks a yes/no question.

// "Non-GAAP" ends a word at the hyphen, so `\bgaap` matches inside it and a non-GAAP caption
// reads as a GAAP one. Defeated by: "Non-GAAP EPS of $1.02", which was reported as both the
// adjusted and the reported per-share figure.
export const gaapTermSource = String.raw`(?<!non-)\bgaap\b`;

// "NT$" opens with letters and closes with a symbol, so `\b` cannot anchor the symbol end and
// an unanchored match lands inside ordinary words. Defeated by: "we spent $883 million", which
// reported a US filer's revenue in New Taiwan dollars.
const newTaiwanDollarBody = String.raw`NT\s*\$`;
export const newTaiwanDollarSource = String.raw`(?:^|[^A-Za-z])${newTaiwanDollarBody}`;

// The same term where a match must not consume the preceding character, for use in a replace.
export const newTaiwanDollarPrefixSource = String.raw`(?:^|(?<=[^A-Za-z]))${newTaiwanDollarBody}`;

// "U.S." ends in a full stop, so a trailing `\b` can never match before a space: a boundary
// there would need a word character next to the stop. Defeated by: "Jardiance revenue outside
// the U.S. included a sales-based milestone", where the qualifier went unseen and a single
// product's revenue was reported as the company's.
export const unitedStatesSource = String.raw`U\.S\.(?![A-Za-z])`;

// Case-insensitive, matching how filings are read elsewhere. That is also what makes the
// leading boundary load-bearing rather than incidental: without it, the lowercase "nt $" in
// "we spent $400 million" matches.
export function hasNewTaiwanDollarSymbol(text: string): boolean {
  return new RegExp(newTaiwanDollarSource, "i").test(text);
}

export function hasStandaloneGaapTerm(text: string): boolean {
  return new RegExp(gaapTermSource, "i").test(text);
}

// A three-letter currency code is also an ordinary acronym, so on its own it says nothing
// about the reporting currency. Defeated by: "typing the call into the CAD in another
// jurisdiction" — Computer-Aided Dispatch in a customer quote, which reported a US filer's
// revenue in Canadian dollars. A code counts only where it declares units or sits against an
// amount.
export function hasDeclaredIsoCode(text: string, codes: string[]): boolean {
  const alternatives = codes.join("|");
  return new RegExp(
    String.raw`\biso4217:(?:${alternatives})\b` +
    String.raw`|\bin\s+(?:${alternatives})\b` +
    String.raw`|\(\s*(?:${alternatives})\b` +
    String.raw`|\b(?:${alternatives})\s*(?:[$\d]|millions?|billions?|thousands?)`,
    "i",
  ).test(text);
}
