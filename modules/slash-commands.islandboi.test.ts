import {createChatInputInteraction, createEventClient} from "./test-utils/discord-mocks.ts";
import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";

type SetupOptions = {
  mutedRole?: string;
};

async function setupModule(options: SetupOptions = {}) {
  vi.resetModules();

  const loggerMock = {
    log: vi.fn(),
  };
  const discordLoggerMock = {
    log: vi.fn(),
  };
  const readSecretMock = vi.fn((secretName: string) => {
    if ("discord_guild_ID" === secretName) {
      return "guild-id";
    }

    if ("hblwrk_role_muted_ID" === secretName) {
      return options.mutedRole ?? "muted-role";
    }

    return "";
  });

  vi.doMock("./secrets.ts", () => ({
    readSecret: readSecretMock,
  }));

  vi.doMock("./logging.ts", () => ({
    getLogger: () => loggerMock,
    getDiscordLogger: () => discordLoggerMock,
  }));

  vi.doMock("./calendar.ts", () => ({
    CALENDAR_MAX_MESSAGE_LENGTH: 1800,
    CALENDAR_MAX_MESSAGES_SLASH: 6,
    getCalendarEvents: vi.fn(async () => []),
    getCalendarMessages: vi.fn(() => ({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
      totalDays: 0,
      includedDays: 0,
    })),
  }));

  vi.doMock("./earnings.ts", () => ({
    EARNINGS_MAX_MESSAGE_LENGTH: 1800,
    EARNINGS_MAX_MESSAGES_SLASH: 6,
    getEarningsResult: vi.fn(async () => ({
      events: [],
      status: "ok",
    })),
    getEarningsMessages: vi.fn(() => ({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
    })),
  }));

  const slashCommandsModule = await import("./slash-commands.ts");

  return {
    interactSlashCommands: slashCommandsModule.interactSlashCommands,
    loggerMock,
    readSecretMock,
  };
}

function createGuild({
  canManageRoles = true,
}: {
  canManageRoles?: boolean;
}) {
  const addRoleMock = vi.fn().mockResolvedValue(undefined);
  const removeRoleMock = vi.fn().mockResolvedValue(undefined);

  const guildUser = {
    roles: {
      add: addRoleMock,
      remove: removeRoleMock,
    },
  };

  const guild = {
    members: {
      me: {
        permissions: {
          has: vi.fn(() => canManageRoles),
        },
        roles: {
          add: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      fetchMe: vi.fn().mockResolvedValue({
        permissions: {
          has: vi.fn(() => canManageRoles),
        },
        roles: {
          add: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      }),
      fetch: vi.fn().mockResolvedValue(guildUser),
    },
  };

  return {
    guild,
    guildUser,
    addRoleMock,
    removeRoleMock,
  };
}

type IslandboiGuild = ReturnType<typeof createGuild>["guild"];
type IslandboiClient = ReturnType<typeof createEventClient>["client"] & {
  guilds: {
    cache: {
      get: (guildId: string) => IslandboiGuild | undefined;
    };
    fetch: (guildId: string) => Promise<IslandboiGuild | undefined>;
  };
};

function withGuilds(
  client: ReturnType<typeof createEventClient>["client"],
  guilds: IslandboiClient["guilds"],
): IslandboiClient {
  return Object.assign(client, {guilds});
}

describe("interactSlashCommands islandboi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("applies cooldown and replies with remaining time", async () => {
    const {interactSlashCommands} = await setupModule();
    const {client, getHandler} = createEventClient();
    const {guild, addRoleMock} = createGuild({});

    const slashClient = withGuilds(client, {
      cache: {
        get: vi.fn(() => guild),
      },
      fetch: vi.fn().mockResolvedValue(guild),
    });

    interactSlashCommands(slashClient, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const firstInteraction = createChatInputInteraction("islandboi");
    await handler(firstInteraction);

    const secondInteraction = createChatInputInteraction("islandboi");
    await handler(secondInteraction);

    expect(addRoleMock).toHaveBeenCalledTimes(1);
    expect(firstInteraction.reply).toHaveBeenCalledWith({
      content: "You are now muted for 60 seconds.",
      ephemeral: true,
    });
    expect(secondInteraction.reply).toHaveBeenCalledWith({
      content: "Please wait 60 more seconds.",
      ephemeral: true,
    });
  });

  test("replies when muted role is not configured", async () => {
    const {interactSlashCommands} = await setupModule({
      mutedRole: "",
    });
    const {client, getHandler} = createEventClient();

    const slashClient = withGuilds(client, {
      cache: {
        get: vi.fn(() => undefined),
      },
      fetch: vi.fn(async () => undefined),
    });

    interactSlashCommands(slashClient, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("islandboi");
    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Muted role is not configured.",
      ephemeral: true,
    });
  });

  test("replies when guild cannot be loaded", async () => {
    const {interactSlashCommands} = await setupModule();
    const {client, getHandler} = createEventClient();

    const slashClient = withGuilds(client, {
      cache: {
        get: vi.fn(() => undefined),
      },
      fetch: vi.fn(async () => {
        throw new Error("guild missing");
      }),
    });

    interactSlashCommands(slashClient, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("islandboi");
    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Guild is currently unavailable.",
      ephemeral: true,
    });
  });

  test("replies when bot lacks manage-roles permissions", async () => {
    const {interactSlashCommands} = await setupModule();
    const {client, getHandler} = createEventClient();
    const {guild} = createGuild({
      canManageRoles: false,
    });

    const slashClient = withGuilds(client, {
      cache: {
        get: vi.fn(() => guild),
      },
      fetch: vi.fn().mockResolvedValue(guild),
    });

    interactSlashCommands(slashClient, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("islandboi");
    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "No permissions to manage roles.",
      ephemeral: true,
    });
  });

  test("unmutes after timer and clears cooldown for subsequent use", async () => {
    const {interactSlashCommands} = await setupModule();
    const {client, getHandler} = createEventClient();
    const {guild, addRoleMock, removeRoleMock} = createGuild({});

    const slashClient = withGuilds(client, {
      cache: {
        get: vi.fn(() => guild),
      },
      fetch: vi.fn().mockResolvedValue(guild),
    });

    interactSlashCommands(slashClient, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const firstInteraction = createChatInputInteraction("islandboi");
    await handler(firstInteraction);

    expect(addRoleMock).toHaveBeenCalledWith("muted-role");

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();

    expect(removeRoleMock).toHaveBeenCalledWith("muted-role");

    const secondInteraction = createChatInputInteraction("islandboi");
    await handler(secondInteraction);

    expect(addRoleMock).toHaveBeenCalledTimes(2);
    expect(secondInteraction.reply).toHaveBeenCalledWith({
      content: "You are now muted for 60 seconds.",
      ephemeral: true,
    });
  });
});
