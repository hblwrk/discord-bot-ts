/* eslint-disable import/extensions */
import {Client, PermissionFlagsBits} from "discord.js";
import {type Logger} from "./startup-types.js";

type ErrorLogDetails = {
  discord_error_message?: string;
  error_name?: string;
  error_message: string;
  error_stack?: string;
};

type StartupPreflightFailure = {
  detail: string;
  label: string;
  reference: string;
  requiredPermission?: string;
  scope: "channel" | "config" | "guild" | "message" | "permission" | "role";
};

type StartupPreflightOptions = {
  brokerYesRoleId: string;
  channelClownboardId: string;
  channelBreakingNewsId: string;
  channelMncId: string;
  channelNyseId: string;
  channelOtherId: string;
  configuredDiscordGuildId: string;
  mutedRoleId: string;
  roleAssignmentBrokerMessageId: string;
  roleAssignmentChannelId: string;
  roleAssignmentSpecialMessageId: string;
};

class StartupPreflightError extends Error {
  public readonly failures: StartupPreflightFailure[];

  constructor(failures: StartupPreflightFailure[]) {
    super(`Startup preflight failed with ${failures.length} issue(s).`);
    this.name = "StartupPreflightError";
    this.failures = failures;
  }
}

function toPermissionName(permission: bigint): string {
  const permissionName = Object.entries(PermissionFlagsBits)
    .find(([, value]) => value === permission)?.[0];
  return permissionName ?? String(permission);
}

async function getClientGuild(client: Client, guildId: string) {
  const cachedGuild = client.guilds.cache.get(guildId);
  if (cachedGuild) {
    return cachedGuild;
  }

  if ("function" !== typeof client.guilds.fetch) {
    return undefined;
  }

  return client.guilds.fetch(guildId).catch(() => undefined);
}

async function getClientChannel(client: Client, channelId: string) {
  const cachedChannel = client.channels.cache.get(channelId);
  if (cachedChannel) {
    return cachedChannel;
  }

  if ("function" !== typeof client.channels.fetch) {
    return undefined;
  }

  return client.channels.fetch(channelId).catch(() => undefined);
}

async function getGuildRole(guild: any, roleId: string) {
  const cachedRole = guild?.roles?.cache?.get?.(roleId);
  if (cachedRole) {
    return cachedRole;
  }

  if ("function" !== typeof guild?.roles?.fetch) {
    return undefined;
  }

  return guild.roles.fetch(roleId).catch(() => undefined);
}

function getChannelPermissions(channel: any, member: any) {
  if ("function" !== typeof channel?.permissionsFor) {
    return undefined;
  }

  return channel.permissionsFor(member);
}

export async function runStartupPreflight(
  client: Client,
  logger: Logger,
  options: StartupPreflightOptions,
) {
  const failures: StartupPreflightFailure[] = [];
  let checkedChannels = 0;
  let checkedRoleAssignmentMessages = 0;
  let checkedRoles = 0;

  const addFailure = (failure: StartupPreflightFailure) => {
    failures.push(failure);
  };

  if ("" === options.configuredDiscordGuildId) {
    addFailure({
      scope: "config",
      label: "discord guild",
      reference: "discord_guild_ID",
      detail: "Missing Discord guild ID configuration.",
    });
  }

  const guild = "" !== options.configuredDiscordGuildId
    ? await getClientGuild(client, options.configuredDiscordGuildId)
    : undefined;
  if (!guild) {
    addFailure({
      scope: "guild",
      label: "discord guild",
      reference: options.configuredDiscordGuildId || "discord_guild_ID",
      detail: "Configured Discord guild is unavailable.",
    });
  }

  const botMember = guild
    ? guild.members.me ?? await guild.members.fetchMe?.().catch(() => undefined)
    : undefined;
  if (!botMember) {
    addFailure({
      scope: "guild",
      label: "bot member",
      reference: options.configuredDiscordGuildId || "discord_guild_ID",
      detail: "Unable to resolve the bot member in the configured guild.",
    });
  }

  const checkChannel = async ({
    channelId,
    label,
    requireMessageFetch,
    requireSendCapability,
    requiredPermissions,
  }: {
    channelId: string;
    label: string;
    requireMessageFetch?: boolean;
    requireSendCapability?: boolean;
    requiredPermissions: bigint[];
  }) => {
    if ("" === channelId) {
      addFailure({
        scope: "config",
        label,
        reference: label,
        detail: "Missing configuration for critical channel.",
      });
      return undefined;
    }

    const channel = await getClientChannel(client, channelId);
    if (!channel) {
      addFailure({
        scope: "channel",
        label,
        reference: channelId,
        detail: "Critical channel is unavailable.",
      });
      return undefined;
    }

    checkedChannels += 1;

    if (true === requireSendCapability && "function" !== typeof (channel as any).send) {
      addFailure({
        scope: "channel",
        label,
        reference: channelId,
        detail: "Critical channel is not send-capable.",
      });
    }

    if (true === requireMessageFetch && "function" !== typeof (channel as any).messages?.fetch) {
      addFailure({
        scope: "channel",
        label,
        reference: channelId,
        detail: "Critical channel does not support message fetch operations.",
      });
    }

    if (!botMember) {
      return channel;
    }

    const permissions = getChannelPermissions(channel, botMember);
    if (!permissions || "function" !== typeof permissions.has) {
      addFailure({
        scope: "permission",
        label,
        reference: channelId,
        detail: "Unable to determine channel permissions for the bot member.",
      });
      return channel;
    }

    for (const permission of requiredPermissions) {
      if (true !== permissions.has(permission)) {
        addFailure({
          scope: "permission",
          label,
          reference: channelId,
          requiredPermission: toPermissionName(permission),
          detail: "Missing required channel permission.",
        });
      }
    }

    return channel;
  };

  await checkChannel({
    channelId: options.channelNyseId,
    label: "NYSE announcements",
    requireSendCapability: true,
    requiredPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ],
  });
  await checkChannel({
    channelId: options.channelBreakingNewsId,
    label: "Breaking news",
    requireSendCapability: true,
    requiredPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ],
  });
  await checkChannel({
    channelId: options.channelMncId,
    label: "MNC announcements",
    requireSendCapability: true,
    requiredPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AttachFiles,
    ],
  });
  await checkChannel({
    channelId: options.channelOtherId,
    label: "Other announcements",
    requireSendCapability: true,
    requiredPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AttachFiles,
    ],
  });
  await checkChannel({
    channelId: options.channelClownboardId,
    label: "clownboard",
    requireMessageFetch: true,
    requireSendCapability: true,
    requiredPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ],
  });

  const roleAssignmentConfigured = "" !== options.roleAssignmentChannelId
    && "" !== options.roleAssignmentBrokerMessageId
    && "" !== options.roleAssignmentSpecialMessageId;
  if (roleAssignmentConfigured) {
    const roleAssignmentChannel = await checkChannel({
      channelId: options.roleAssignmentChannelId,
      label: "role assignment",
      requireMessageFetch: true,
      requiredPermissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
      ],
    });

    if ("function" === typeof (roleAssignmentChannel as any)?.messages?.fetch) {
      const brokerMessage = await roleAssignmentChannel.messages.fetch(options.roleAssignmentBrokerMessageId).catch(() => undefined);
      if (!brokerMessage) {
        addFailure({
          scope: "message",
          label: "role assignment broker message",
          reference: options.roleAssignmentBrokerMessageId,
          detail: "Configured role-assignment broker message is unavailable.",
        });
      } else {
        checkedRoleAssignmentMessages += 1;
      }

      const specialMessage = await roleAssignmentChannel.messages.fetch(options.roleAssignmentSpecialMessageId).catch(() => undefined);
      if (!specialMessage) {
        addFailure({
          scope: "message",
          label: "role assignment special message",
          reference: options.roleAssignmentSpecialMessageId,
          detail: "Configured role-assignment special message is unavailable.",
        });
      } else {
        checkedRoleAssignmentMessages += 1;
      }
    }
  }

  const roleManagementConfigured = [options.brokerYesRoleId, options.mutedRoleId].some(roleId => "" !== roleId)
    || roleAssignmentConfigured;
  const botHighestRolePosition = Number(botMember?.roles?.highest?.position);
  if (roleManagementConfigured) {
    if (true !== botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
      addFailure({
        scope: "permission",
        label: "role management",
        reference: "ManageRoles",
        requiredPermission: "ManageRoles",
        detail: "Bot lacks ManageRoles permission required for role-management features.",
      });
    }

    if (false === Number.isFinite(botHighestRolePosition)) {
      addFailure({
        scope: "role",
        label: "bot highest role",
        reference: "guild.members.me.roles.highest",
        detail: "Unable to determine the bot's highest role position.",
      });
    }
  }

  const checkRole = async (label: string, roleId: string) => {
    if ("" === roleId || !guild) {
      return;
    }

    checkedRoles += 1;
    const role = await getGuildRole(guild, roleId);
    if (!role) {
      addFailure({
        scope: "role",
        label,
        reference: roleId,
        detail: "Configured role is unavailable.",
      });
      return;
    }

    if (true === role.managed) {
      addFailure({
        scope: "role",
        label,
        reference: roleId,
        detail: "Configured role is managed externally and cannot be assigned by the bot.",
      });
    }

    if (true === Number.isFinite(botHighestRolePosition) && botHighestRolePosition <= Number(role.position)) {
      addFailure({
        scope: "role",
        label,
        reference: roleId,
        detail: "Configured role is not below the bot's highest role.",
      });
    }
  };

  await checkRole("muted role", options.mutedRoleId);
  await checkRole("broker yes role", options.brokerYesRoleId);

  if (0 < failures.length) {
    for (const failure of failures) {
      logger.log(
        "error",
        {
          startup_phase: "phase-a",
          task: "preflight",
          preflight_scope: failure.scope,
          preflight_label: failure.label,
          preflight_reference: failure.reference,
          ...(failure.requiredPermission ? {required_permission: failure.requiredPermission} : {}),
          message: failure.detail,
        },
      );
    }

    throw new StartupPreflightError(failures);
  }

  logger.log(
    "info",
    {
      startup_phase: "phase-a",
      task: "preflight",
      guild_id: options.configuredDiscordGuildId,
      checked_channels: checkedChannels,
      checked_roles: checkedRoles,
      checked_role_assignment_messages: checkedRoleAssignmentMessages,
      message: "Startup preflight passed.",
    },
  );
}
