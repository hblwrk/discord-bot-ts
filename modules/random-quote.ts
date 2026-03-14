import {UserQuoteAsset} from "./assets.js";
import {getRandomAsset} from "./random-asset.js";

export function getRandomQuote(username: string, assets: unknown[]): UserQuoteAsset | undefined {
  const randomQuotePool: UserQuoteAsset[] = [];

  for (const asset of assets) {
    if (asset instanceof UserQuoteAsset && (asset.user === username || "any" === username)) {
      randomQuotePool.push(asset);
    }
  }

  if (0 === randomQuotePool.length) {
    return undefined;
  }

  return getRandomAsset(randomQuotePool);
}
