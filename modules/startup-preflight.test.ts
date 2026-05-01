import {type Client, PermissionFlagsBits} from "discord.js";
import {describe, expect, test, vi} from "vitest";
import {runStartupPreflight} from "./startup-preflight.ts";

type StartupPreflightOptions = Parameters<typeof runStartupPreflight>[2];
type StartupPreflightLogger = Parameters<typeof runStartupPreflight>[1];

function createOptions(overrides: Partial<StartupPreflightOptions> = {}): StartupPreflightOptions {
  return {
    brokerYesRoleId: "broker-yes-role-id",
    channelClownboardId: "clownboard-channel-id",
    channelBreakingNewsId: "breaking-news-channel-id",
    channelMncId: "mnc-channel-id",
    channelNyseId: "nyse-channel-id",
    channelOtherId: "other-channel-id",
    configuredDiscordGuildId: "guild-id",
    mutedRoleId: "muted-role-id",
    roleAssignmentBrokerMessageId: "broker-message-id",
    roleAssignmentChannelId: "role-assignment-channel-id",
    roleAssignmentSpecialMessageId: "special-message-id",
    ...overrides,
  };
}

function createLogger(): StartupPreflightLogger {
  return {
    log: vi.fn(),
  };
}

function createFixture(options = createOptions()) {
  const channelPermissionHas = vi.fn((_permission: bigint) => true);
  const channel = {
    send: vi.fn(),
    messages: {
      fetch: vi.fn(async (messageId: string): Promise<{id: string} | undefined> => ({id: messageId})),
    },
    permissionsFor: vi.fn((_member: unknown) => ({
      has: channelPermissionHas,
    })),
  };
  const channelsById = new Map<string, typeof channel>([
    [options.channelNyseId, channel],
    [options.channelBreakingNewsId, channel],
    [options.channelMncId, channel],
    [options.channelOtherId, channel],
    [options.channelClownboardId, channel],
    [options.roleAssignmentChannelId, channel],
  ]);

  const botMember = {
    permissions: {
      has: vi.fn((_permission: bigint) => true),
    },
    roles: {
      highest: {
        position: 10,
      },
    },
  };
  const rolesById = new Map<string, {managed: boolean; position: number}>([
    [options.mutedRoleId, {managed: false, position: 1}],
    [options.brokerYesRoleId, {managed: false, position: 2}],
  ]);
  const guild = {
    members: {
      me: botMember,
      fetchMe: vi.fn(async () => botMember),
    },
    roles: {
      cache: {
        get: vi.fn((roleId: string) => rolesById.get(roleId)),
      },
      fetch: vi.fn(async (roleId: string) => rolesById.get(roleId) ?? null),
    },
  };
  const guildCacheGet = vi.fn((_guildId: string): typeof guild | undefined => guild);
  const guildFetch = vi.fn(async (_guildId: string) => guild);
  const channelCacheGet = vi.fn((channelId: string): typeof channel | undefined => channelsById.get(channelId));
  const channelFetch = vi.fn(async (channelId: string) => channelsById.get(channelId) ?? null);
  const client = {
    guilds: {
      cache: {
        get: guildCacheGet,
      },
      fetch: guildFetch,
    },
    channels: {
      cache: {
        get: channelCacheGet,
      },
      fetch: channelFetch,
    },
  } as unknown as Client;

  return {
    botMember,
    channel,
    channelCacheGet,
    channelFetch,
    channelPermissionHas,
    channelsById,
    client,
    guild,
    guildCacheGet,
    guildFetch,
    rolesById,
  };
}

describe("runStartupPreflight", () => {
  test("passes when critical channels, messages, roles, and permissions are available", async () => {
    const options = createOptions();
    const fixture = createFixture(options);
    const logger = createLogger();

    await runStartupPreflight(fixture.client, logger, options);

    expect(fixture.channel.messages.fetch).toHaveBeenCalledWith("broker-message-id");
    expect(fixture.channel.messages.fetch).toHaveBeenCalledWith("special-message-id");
    expect(logger.log).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({
        task: "preflight",
        checked_channels: 6,
        checked_roles: 2,
        checked_role_assignment_messages: 2,
        message: "Startup preflight passed.",
      }),
    );
  });

  test("uses Discord fetch fallbacks when guild, channel, and role caches miss", async () => {
    const options = createOptions();
    const fixture = createFixture(options);
    const logger = createLogger();
    fixture.guildCacheGet.mockReturnValueOnce(undefined);
    fixture.channelCacheGet.mockImplementation(channelId => {
      if (options.channelNyseId === channelId) {
        return undefined;
      }

      return fixture.channelsById.get(channelId);
    });
    fixture.guild.roles.cache.get.mockImplementation(roleId => {
      if (options.mutedRoleId === roleId) {
        return undefined;
      }

      return fixture.rolesById.get(roleId);
    });

    await runStartupPreflight(fixture.client, logger, options);

    expect(fixture.guildFetch).toHaveBeenCalledWith("guild-id");
    expect(fixture.channelFetch).toHaveBeenCalledWith("nyse-channel-id");
    expect(fixture.guild.roles.fetch).toHaveBeenCalledWith("muted-role-id");
  });

  test("fails with actionable errors for missing permissions, messages, and unsafe roles", async () => {
    const options = createOptions();
    const fixture = createFixture(options);
    const logger = createLogger();
    const roleAssignmentChannel = {
      ...fixture.channel,
      messages: {
        fetch: vi.fn(async (messageId: string) => {
          if ("broker-message-id" === messageId) {
            return undefined;
          }

          return {id: messageId};
        }),
      },
    };
    fixture.channelsById.set(options.roleAssignmentChannelId, roleAssignmentChannel);
    fixture.channelPermissionHas.mockImplementation(permission => permission !== PermissionFlagsBits.SendMessages);
    fixture.botMember.permissions.has.mockImplementation(permission => permission !== PermissionFlagsBits.ManageRoles);
    fixture.rolesById.set(options.mutedRoleId, {managed: true, position: 15});
    fixture.rolesById.delete(options.brokerYesRoleId);

    await expect(runStartupPreflight(fixture.client, logger, options)).rejects.toMatchObject({
      name: "StartupPreflightError",
      failures: expect.arrayContaining([
        expect.objectContaining({
          scope: "permission",
          label: "NYSE announcements",
          requiredPermission: "SendMessages",
        }),
        expect.objectContaining({
          scope: "message",
          label: "role assignment broker message",
        }),
        expect.objectContaining({
          scope: "permission",
          label: "role management",
          requiredPermission: "ManageRoles",
        }),
        expect.objectContaining({
          scope: "role",
          label: "muted role",
          detail: "Configured role is managed externally and cannot be assigned by the bot.",
        }),
        expect.objectContaining({
          scope: "role",
          label: "broker yes role",
          detail: "Configured role is unavailable.",
        }),
      ]),
    });

    expect(logger.log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        task: "preflight",
        preflight_scope: "permission",
        preflight_label: "NYSE announcements",
        required_permission: "SendMessages",
      }),
    );
  });
});
