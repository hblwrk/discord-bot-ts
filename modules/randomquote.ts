import {getAssets} from "./assets";

export function getRandomQuote(asset) {
  const assets = getAssets("userquote");
  const randomQuotePool = [];

  for (const quote of assets) {
    if (quote.getUser() === asset.getName()) {
      randomQuotePool.push(quote);
    }
  }

  return randomQuotePool[Math.floor(Math.random() * randomQuotePool.length)];
}
