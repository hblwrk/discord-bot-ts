import {UserQuoteAsset} from "./assets";

export function getRandomQuote(username: string, assets: any) {
  const randomQuotePool = [];

  for (const asset of assets) {
    if (asset instanceof UserQuoteAsset && (asset.user === username || "any" === username)) {
      randomQuotePool.push(asset);
    }
  }

  return randomQuotePool[Math.floor(Math.random() * randomQuotePool.length)];
}
