import {ImageAsset, TextAsset, UserQuoteAsset} from "./assets.ts";
import {getSecureRandomIndex} from "./secure-random.ts";

type RandomTriggerAsset = ImageAsset | TextAsset | UserQuoteAsset;
type RandomIndexFn = (length: number) => number;

function isRandomTriggerMatch(baseTrigger: string, trigger: string): boolean {
  if (false === trigger.startsWith(`${baseTrigger} `)) {
    return false;
  }

  const suffix = trigger.slice(baseTrigger.length + 1).trim();
  return /^\d+$/.test(suffix);
}

function isRandomTriggerAsset(asset: unknown): asset is RandomTriggerAsset {
  return asset instanceof ImageAsset || asset instanceof TextAsset || asset instanceof UserQuoteAsset;
}

export function getRandomAsset<T>(assets: T[], randomIndex: RandomIndexFn = getSecureRandomIndex): T | undefined {
  if (0 === assets.length) {
    return undefined;
  }

  return assets[randomIndex(assets.length)];
}

export function getRandomAssetByTriggerGroup(
  baseTrigger: string,
  assets: unknown[],
  randomIndex: RandomIndexFn = getSecureRandomIndex,
): RandomTriggerAsset | undefined {
  const normalizedBaseTrigger = baseTrigger.trim();
  if ("" === normalizedBaseTrigger) {
    return undefined;
  }

  const randomAssetPool: RandomTriggerAsset[] = [];
  for (const asset of assets) {
    if (false === isRandomTriggerAsset(asset)) {
      continue;
    }

    if (false === Array.isArray(asset.trigger)) {
      continue;
    }

    if (true === asset.trigger.some(trigger => "string" === typeof trigger && true === isRandomTriggerMatch(normalizedBaseTrigger, trigger))) {
      randomAssetPool.push(asset);
    }
  }

  return getRandomAsset(randomAssetPool, randomIndex);
}
