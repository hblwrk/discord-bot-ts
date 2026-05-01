import {EventEmitter} from "node:events";
import {PermissionFlagsBits} from "discord.js";
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
  const channelIds = ["nyse", "mnc", "other", "clownboard", ...Object.keys(channelPermissionsById)];
  const channelsById = new Map<string, any>();
  for (const channelId of channelIds) {
    if (true === missingChannelIdSet.has(channelId)) {
      continue;
    }

    const permissions = new Set(channelPermissionsById[channelId] ?? defaultChannelPermissions);
    channelsById.set(channelId, {
      id: channelId,
      send: jest.fn(),
      permissionsFor: jest.fn(() => ({
        has: jest.fn((permission: bigint) => permissions.has(permission)),
      })),
      messages: {
        fetch: jest.fn(async messageId => ({id: messageId})),
      },
    });
  }

  const rolesById = new Map<string, any>(Object.entries(roleById).map(([roleId, role]) => [roleId, {id: roleId, ...role}]));
  const botMember = {
    permissions: {
      has: jest.fn((permission: bigint) => {
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
        get: jest.fn((channelId: string) => channelsById.get(channelId)),
      },
      fetch: jest.fn(async (channelId: string) => channelsById.get(channelId)),
    },
    members: {
      me: botMember,
      fetch: jest.fn(async () => ({})),
      fetchMe: jest.fn(async () => botMember),
    },
    roles: {
      cache: {
        get: jest.fn((roleId: string) => rolesById.get(roleId)),
      },
      fetch: jest.fn(async (roleId: string) => rolesById.get(roleId)),
    },
  };
  const client: any = {
    user: {
      id: userId,
    },
    channels: {
      cache: {
        get: jest.fn((channelId: string) => channelsById.get(channelId)),
      },
      fetch: jest.fn(async (channelId: string) => channelsById.get(channelId)),
    },
    guilds: {
      cache: {
        get: jest.fn((guildId: string) => "guild-id" === guildId ? guild : undefined),
      },
      fetch: jest.fn(async (guildId: string) => "guild-id" === guildId ? guild : undefined),
    },
    on: jest.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
      emitter.on(eventName, handler as any);
      return client;
    }),
    once: jest.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
      emitter.once(eventName, handler as any);
      return client;
    }),
    login: jest.fn(async () => {
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
    log: jest.fn(),
  };
  const readSecret = jest.fn((secretName: string) => {
    const defaults = {
      environment: "staging",
      discord_token: "token",
      hblwrk_channel_NYSEAnnouncement_ID: "nyse",
      hblwrk_gainslosses_thread_ID: "gains-losses-thread",
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
  const runHealthCheck = jest.fn(() => {
    events.push("health");
    return {} as any;
  });
  const addInlineResponses = jest.fn(() => {
    events.push("inline");
  });
  const addTriggerResponses = jest.fn(() => {
    events.push("trigger");
  });
  const interactSlashCommands = jest.fn(() => {
    events.push("slash-interact");
  });
  const clownboard = jest.fn(() => {
    events.push("clownboard");
  });
  const startNyseTimers = jest.fn(() => {
    events.push("nyse");
  });
  const startMncTimers = jest.fn(() => {
    events.push("mnc");
  });
  const startEarningsResultWatcher = jest.fn(() => {
    events.push("earnings-results");
    return {
      runOnce: jest.fn(),
      stop: jest.fn(),
    };
  });
  const startOtherTimers = jest.fn(() => {
    events.push("other-timers");
  });
  const defineSlashCommands = jest.fn(async () => {
    events.push("slash-define");
  });
  const roleManager = jest.fn(async () => {
    events.push("role-manager");
  });
  const getGenericAssets = jest.fn(async () => {
    events.push("generic-assets");
    return [];
  });
  const getTickers = jest.fn(async () => {
    events.push("tickers");
    return [];
  });
  const getAssets = jest.fn(async (type: string) => {
    events.push(`${type}-assets`);
    return [];
  });
  const updateMarketData = jest.fn(async () => {
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
