import {EventEmitter} from "node:events";
import {PermissionFlagsBits} from "discord.js";
import {vi} from "vitest";
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

export function sleep(delayMs: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, delayMs);
  });
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
  pollIntervalMs = 5,
): Promise<void> {
  const timeoutAt = Date.now() + timeoutMs;
  while (Date.now() < timeoutAt) {
    if (true === predicate()) {
      return;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Condition not met within ${timeoutMs}ms.`);
}

export function createMockClient(options: {
  channelPermissionsById?: Record<string, bigint[]>;
  highestRolePosition?: number;
  manageRoles?: boolean;
  missingChannelIds?: string[];
  roleById?: Record<string, {managed?: boolean; position: number;}>;
  userId?: string;
} = {}) {
  const {
    channelPermissionsById = {},
    highestRolePosition = 100,
    manageRoles = true,
    missingChannelIds = [],
    roleById = {},
    userId = "bot-client-id",
  } = options;
  const emitter = new EventEmitter();
  const defaultChannelPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AddReactions,
  ];
  const missingChannelIdSet = new Set(missingChannelIds);
  const channelIds = ["nyse", "breaking-news", "mnc", "other", "clownboard", ...Object.keys(channelPermissionsById)];
  const channelsById = new Map<string, any>();
  for (const channelId of channelIds) {
    if (true === missingChannelIdSet.has(channelId)) {
      continue;
    }

    const permissions = new Set(channelPermissionsById[channelId] ?? defaultChannelPermissions);
    channelsById.set(channelId, {
      id: channelId,
      send: vi.fn(),
      permissionsFor: vi.fn(() => ({
        has: vi.fn((permission: bigint) => permissions.has(permission)),
      })),
      messages: {
        fetch: vi.fn(async messageId => ({id: messageId})),
      },
    });
  }

  const rolesById = new Map<string, any>(Object.entries(roleById).map(([roleId, role]) => [roleId, {id: roleId, ...role}]));
  const botMember = {
    permissions: {
      has: vi.fn((permission: bigint) => {
        return PermissionFlagsBits.ManageRoles === permission
          ? manageRoles
          : false;
      }),
    },
    roles: {
      highest: {
        position: highestRolePosition,
      },
    },
  };
  const guild = {
    channels: {
      cache: {
        get: vi.fn((channelId: string) => channelsById.get(channelId)),
      },
      fetch: vi.fn(async (channelId: string) => channelsById.get(channelId)),
    },
    members: {
      me: botMember,
      fetch: vi.fn(async () => ({})),
      fetchMe: vi.fn(async () => botMember),
    },
    roles: {
      cache: {
        get: vi.fn((roleId: string) => rolesById.get(roleId)),
      },
      fetch: vi.fn(async (roleId: string) => rolesById.get(roleId)),
    },
  };
  const client: any = {
    user: {
      id: userId,
    },
    channels: {
      cache: {
        get: vi.fn((channelId: string) => channelsById.get(channelId)),
      },
      fetch: vi.fn(async (channelId: string) => channelsById.get(channelId)),
    },
    guilds: {
      cache: {
        get: vi.fn((guildId: string) => "guild-id" === guildId ? guild : undefined),
      },
      fetch: vi.fn(async (guildId: string) => "guild-id" === guildId ? guild : undefined),
    },
    on: vi.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
      emitter.on(eventName, handler as any);
      return client;
    }),
    once: vi.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
      emitter.once(eventName, handler as any);
      return client;
    }),
    login: vi.fn(async () => {
      setImmediate(() => {
        emitter.emit("clientReady");
      });

      return "token";
    }),
  };

  return {
    client,
    guild,
  };
}

export function createDependencies(overrides = {}) {
  const {client} = createMockClient();
  const events: string[] = [];
  const logger = {
    level: "info",
    log: vi.fn(),
  };
  const readSecret = vi.fn((secretName: string) => {
    const defaults: Record<string, string> = {
      environment: "staging",
      discord_token: "token",
      hblwrk_channel_NYSEAnnouncement_ID: "nyse",
      hblwrk_gainslosses_thread_ID: "gains-losses-thread",
      hblwrk_channel_BreakingNews_ID: "breaking-news",
      hblwrk_channel_MNCAnnouncement_ID: "mnc",
      hblwrk_channel_OtherAnnouncement_ID: "other",
      hblwrk_channel_clownboard_ID: "clownboard",
      discord_client_ID: "bot-client-id",
      discord_guild_ID: "guild-id",
      hblwrk_role_assignment_channel_ID: "",
      hblwrk_role_assignment_broker_message_ID: "",
      hblwrk_role_assignment_special_message_ID: "",
      hblwrk_role_muted_ID: "",
      hblwrk_role_broker_yes_ID: "",
    };

    return defaults[secretName] ?? "";
  });
  const runHealthCheck = vi.fn(() => {
    events.push("health");
    return {} as any;
  });
  const addInlineResponses = vi.fn(() => {
    events.push("inline");
  });
  const addTriggerResponses = vi.fn(() => {
    events.push("trigger");
  });
  const interactSlashCommands = vi.fn(() => {
    events.push("slash-interact");
  });
  const clownboard = vi.fn(() => {
    events.push("clownboard");
  });
  const startNyseTimers = vi.fn(() => {
    events.push("nyse");
  });
  const startMncTimers = vi.fn(() => {
    events.push("mnc");
  });
  const startEarningsResultWatcher = vi.fn(() => {
    events.push("earnings-results");
    return {
      runOnce: vi.fn(),
      stop: vi.fn(),
    };
  });
  const startOtherTimers = vi.fn(() => {
    events.push("other-timers");
  });
  const defineSlashCommands = vi.fn(async () => {
    events.push("slash-define");
  });
  const roleManager = vi.fn(async () => {
    events.push("role-manager");
  });
  const getGenericAssets = vi.fn(async () => {
    events.push("generic-assets");
    return [];
  });
  const getTickers = vi.fn(async () => {
    events.push("tickers");
    return [];
  });
  const getAssets = vi.fn(async (type: string) => {
    events.push(`${type}-assets`);
    return [];
  });
  const updateMarketData = vi.fn(async () => {
    events.push("market-data");
  });

  return {
    dependencies: {
      logger,
      createClient: () => client,
      readSecret,
      runHealthCheck,
      addInlineResponses,
      addTriggerResponses,
      interactSlashCommands,
      clownboard,
      startNyseTimers,
      startMncTimers,
      startEarningsResultWatcher,
      startOtherTimers,
      defineSlashCommands,
      roleManager,
      getGenericAssets,
      getTickers,
      getAssets,
      updateMarketData,
      loginTimeoutMs: 200,
      warmupMaxAttempts: 3,
      warmupInitialRetryDelayMs: 1,
      warmupMaxRetryDelayMs: 5,
      slashCommandDebounceMs: 5,
      assetRecoveryRetryMs: 10,
      ...overrides,
    },
    events,
    mocks: {
      logger,
      readSecret,
      runHealthCheck,
      addInlineResponses,
      addTriggerResponses,
      interactSlashCommands,
      clownboard,
      startNyseTimers,
      startMncTimers,
      startEarningsResultWatcher,
      startOtherTimers,
      defineSlashCommands,
      roleManager,
      getGenericAssets,
      getTickers,
      getAssets,
      updateMarketData,
    },
  };
}
