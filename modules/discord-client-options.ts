import {Options, type CacheFactory, type CacheWithLimitsOptions} from "discord.js";

function getCacheFactory(settings: CacheWithLimitsOptions): CacheFactory | undefined {
  if (!Options?.cacheWithLimits) {
    return undefined;
  }

  const defaultCacheSettings = Options.DefaultMakeCacheSettings ?? {};
  return Options.cacheWithLimits({
    ...defaultCacheSettings,
    MessageManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    ReactionUserManager: 0,
    ...settings,
  });
}

export function getInteractiveClientCacheFactory() {
  return getCacheFactory({
    GuildMemberManager: 200,
    UserManager: 200,
  });
}

export function getMarketDataClientCacheFactory() {
  return getCacheFactory({
    GuildMemberManager: 5,
    UserManager: 5,
  });
}
