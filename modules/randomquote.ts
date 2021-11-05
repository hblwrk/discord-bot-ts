import {getAssets} from "./assets";

export function getRandomQuote(username: string) {
  const assets = getAssets("userquote");
  const randomQuotePool = [];

  for (const quote of assets) {
    if (quote.getUser() === username || "any" === username) {
      randomQuotePool.push(quote);
    }
  }

  return randomQuotePool[Math.floor(Math.random() * randomQuotePool.length)];
}
