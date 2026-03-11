import {Options, type CacheWithLimitsOptions} from "discord.js";

const baseCacheSettings: CacheWithLimitsOptions = {
  ...Options.DefaultMakeCacheSettings,
  MessageManager: 0,
  PresenceManager: 0,
  ReactionManager: 0,
  ReactionUserManager: 0,
};

const interactiveClientCacheFactory = Options.cacheWithLimits({
  ...baseCacheSettings,
  GuildMemberManager: 200,
  UserManager: 200,
});

const marketDataClientCacheFactory = Options.cacheWithLimits({
  ...baseCacheSettings,
  GuildMemberManager: 5,
  UserManager: 5,
});

export function getInteractiveClientCacheFactory() {
  return interactiveClientCacheFactory;
}

export function getMarketDataClientCacheFactory() {
  return marketDataClientCacheFactory;
}
