import {createChatInputInteraction, createEventClient} from "./test-utils/discord-mocks.js";

type SetupOptions = {
  mutedRole?: string;
};

async function setupModule(options: SetupOptions = {}) {
  jest.resetModules();

  const loggerMock = {
    log: jest.fn(),
  };
  const discordLoggerMock = {
    log: jest.fn(),
  };
  const readSecretMock = jest.fn((secretName: string) => {
    if ("discord_guild_ID" === secretName) {
      return "guild-id";
    }

    if ("hblwrk_role_muted_ID" === secretName) {
      return options.mutedRole ?? "muted-role";
    }

    return "";
  });

  jest.doMock("./secrets.js", () => ({
    readSecret: readSecretMock,
  }));

  jest.doMock("./logging.js", () => ({
    getLogger: () => loggerMock,
    getDiscordLogger: () => discordLoggerMock,
  }));

  jest.doMock("./calendar.js", () => ({
    CALENDAR_MAX_MESSAGE_LENGTH: 1800,
    CALENDAR_MAX_MESSAGES_SLASH: 6,
    getCalendarEvents: jest.fn(async () => []),
    getCalendarMessages: jest.fn(() => ({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
      totalDays: 0,
      includedDays: 0,
    })),
  }));

  jest.doMock("./earnings.js", () => ({
    EARNINGS_BLOCKED_MESSAGE: "blocked",
    EARNINGS_MAX_MESSAGE_LENGTH: 1800,
    EARNINGS_MAX_MESSAGES_SLASH: 6,
    getEarningsResult: jest.fn(async () => ({
      events: [],
      status: "ok",
      watchlistFilterDropped: false,
    })),
    getEarningsMessages: jest.fn(() => ({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
    })),
  }));

  const slashCommandsModule = await import("./slash-commands.js");

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
  const addRoleMock = jest.fn().mockResolvedValue(undefined);
  const removeRoleMock = jest.fn().mockResolvedValue(undefined);

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
          has: jest.fn(() => canManageRoles),
        },
      },
      fetchMe: jest.fn().mockResolvedValue({
        permissions: {
          has: jest.fn(() => canManageRoles),
        },
      }),
      fetch: jest.fn().mockResolvedValue(guildUser),
    },
  };

  return {
    guild,
    guildUser,
    addRoleMock,
    removeRoleMock,
  };
}

describe("interactSlashCommands islandboi", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("applies cooldown and replies with remaining time", async () => {
    const {interactSlashCommands} = await setupModule();
    const {client, getHandler} = createEventClient();
    const {guild, addRoleMock} = createGuild({});

    (client as any).guilds = {
      cache: {
        get: jest.fn(() => guild),
      },
      fetch: jest.fn().mockResolvedValue(guild),
    };

    interactSlashCommands(client, [], [], [], []);

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

    (client as any).guilds = {
      cache: {
        get: jest.fn(),
      },
      fetch: jest.fn(),
    };

    interactSlashCommands(client, [], [], [], []);

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

    (client as any).guilds = {
      cache: {
        get: jest.fn(() => undefined),
      },
      fetch: jest.fn().mockRejectedValue(new Error("guild missing")),
    };

    interactSlashCommands(client, [], [], [], []);

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

    (client as any).guilds = {
      cache: {
        get: jest.fn(() => guild),
      },
      fetch: jest.fn().mockResolvedValue(guild),
    };

    interactSlashCommands(client, [], [], [], []);

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

    (client as any).guilds = {
      cache: {
        get: jest.fn(() => guild),
      },
      fetch: jest.fn().mockResolvedValue(guild),
    };

    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const firstInteraction = createChatInputInteraction("islandboi");
    await handler(firstInteraction);

    expect(addRoleMock).toHaveBeenCalledWith("muted-role");

    await jest.advanceTimersByTimeAsync(60_000);
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
