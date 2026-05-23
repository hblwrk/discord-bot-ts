import {type MarketDataAsset, type MarketDataSource} from "./market-data-types.ts";

export type MarketDataBotSymbol = "ES" | "NQ" | "RTY" | "VIX";

export type MarketDataSnapshot = {
  assetName: string;
  botName: string;
  lastNumeric: number;
  marketDataPid: number;
  marketDataSource: MarketDataSource;
  percentageChange: number;
  priceChange: number;
  symbol: MarketDataBotSymbol;
  unit: string;
  updatedAt: Date;
};

const marketCloseAssetSymbols = new Map<string, MarketDataBotSymbol>([
  ["es", "ES"],
  ["nq", "NQ"],
  ["rty", "RTY"],
  ["vix", "VIX"],
]);
const marketDataSnapshotsBySymbol = new Map<MarketDataBotSymbol, MarketDataSnapshot>();

export function recordMarketDataSnapshot(
  marketDataAsset: MarketDataAsset,
  lastNumeric: number,
  priceChange: number,
  percentageChange: number,
  marketDataSource: MarketDataSource,
  updatedAt = new Date(),
) {
  const symbol = getMarketDataBotSymbol(marketDataAsset);
  if (undefined === symbol) {
    return;
  }

  marketDataSnapshotsBySymbol.set(symbol, {
    assetName: marketDataAsset.name ?? "",
    botName: marketDataAsset.botName,
    lastNumeric,
    marketDataPid: marketDataAsset.id,
    marketDataSource,
    percentageChange,
    priceChange,
    symbol,
    unit: marketDataAsset.unit,
    updatedAt,
  });
}

export function getMarketDataSnapshots(options: {
  maxAgeMs?: number | undefined;
  referenceTime?: Date | undefined;
} = {}): MarketDataSnapshot[] {
  const referenceTime = options.referenceTime ?? new Date();
  const maxAgeMs = options.maxAgeMs;

  return Array.from(marketDataSnapshotsBySymbol.values())
    .filter(snapshot => {
      if (undefined === maxAgeMs) {
        return true;
      }

      return Math.abs(referenceTime.getTime() - snapshot.updatedAt.getTime()) <= maxAgeMs;
    })
    .sort((left, right) => getSymbolOrder(left.symbol) - getSymbolOrder(right.symbol));
}

export function clearMarketDataSnapshots() {
  marketDataSnapshotsBySymbol.clear();
}

export function getMarketDataBotSymbol(marketDataAsset: Pick<MarketDataAsset, "name">): MarketDataBotSymbol | undefined {
  const assetName = marketDataAsset.name?.trim().toLowerCase();
  if (undefined === assetName || "" === assetName) {
    return undefined;
  }

  return marketCloseAssetSymbols.get(assetName);
}

function getSymbolOrder(symbol: MarketDataBotSymbol): number {
  switch (symbol) {
    case "ES": {
      return 0;
    }

    case "NQ": {
      return 1;
    }

    case "RTY": {
      return 2;
    }

    case "VIX": {
      return 3;
    }
  }
}
