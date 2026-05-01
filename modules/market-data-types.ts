export type MarketHoursProfile = "crypto" | "eu_cash" | "forex" | "us_cash" | "us_futures";
export type DiscordPresenceStatus = "dnd" | "idle" | "invisible" | "online";

export type MarketDataAsset = {
  name?: string;
  botToken: string;
  botClientId: string;
  botName: string;
  id: number;
  suffix: string;
  unit: string;
  marketHours?: MarketHoursProfile;
  decimals: number;
  lastUpdate: number;
  order: number;
};

export type MarketStreamEvent = {
  pid: number;
  lastNumeric: number;
  priceChange: number;
  percentageChange: number;
};

export type ClientStatusState = {
  nickname?: string;
  presence?: string;
  presenceStatus?: DiscordPresenceStatus;
};

export type PendingClientStatusUpdate = {
  marketDataAsset: MarketDataAsset;
  nickname: string;
  openPresence: string;
  lastNumeric: number;
  priceChange: number;
  percentageChange: number;
  applying?: boolean;
};

export type MarketPresenceData = {
  nickname: string;
  presence: string;
  presenceStatus: DiscordPresenceStatus;
};

export type AppliedMarketDataUpdateLog = {
  source: "market-close-reconciler" | "stream-flush";
  marketDataAsset: MarketDataAsset;
  nickname?: string | null;
  presence: string;
  presenceStatus: DiscordPresenceStatus;
  lastNumeric?: number;
  priceChange?: number;
  percentageChange?: number;
};

export type IncomingMarketDataUpdateLog = {
  marketDataAsset: MarketDataAsset;
  botReady: boolean;
  nickname: string;
  presence: string;
  lastNumeric: number;
  priceChange: number;
  percentageChange: number;
};
