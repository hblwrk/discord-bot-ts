import {type ChatInputCommandInteraction, PermissionFlagsBits} from "discord.js";
import {getLogger} from "./logging.ts";
import {readSecret} from "./secrets.ts";
import {type SlashCommandClient} from "./slash-commands-interact-shared.ts";

const logger = getLogger();
const islandboiCooldownMs = 60_000;
const islandboiCooldownByUser = new Map<string, number>();
const islandboiUnmuteTimers = new Map<string, ReturnType<typeof setTimeout>>();

export async function handleIslandboiSlashCommand(
  client: SlashCommandClient,
  interaction: ChatInputCommandInteraction,
  commandName: string,
  guildId: string,
): Promise<boolean> {
  if ("islandboi" !== commandName) {
    return false;
  }

  const now = Date.now();
  const currentCooldownUntil = islandboiCooldownByUser.get(interaction.user.id) ?? 0;
  if (currentCooldownUntil > now) {
    const remainingSeconds = Math.ceil((currentCooldownUntil - now) / 1000);
    await interaction.reply({
      content: `Please wait ${remainingSeconds} more seconds.`,
      ephemeral: true,
    }).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to islandboi slashcommand: ${error}`,
      );
    });
    return true;
  }

  const mutedRole = readSecret("hblwrk_role_muted_ID").trim();
  if ("" === mutedRole) {
    await interaction.reply({
      content: "Muted role is not configured.",
      ephemeral: true,
    }).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to islandboi slashcommand: ${error}`,
      );
    });
    return true;
  }

  const guild = client.guilds?.cache.get(guildId) ?? await client.guilds?.fetch(guildId).catch((error: unknown) => {
    logger.log(
      "error",
      `Error fetching guild for islandboi slashcommand: ${error}`,
    );
  });
  if (!guild) {
    await interaction.reply({
      content: "Guild is currently unavailable.",
      ephemeral: true,
    }).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to islandboi slashcommand: ${error}`,
      );
    });
    return true;
  }

  const botMember = guild.members.me ?? await guild.members.fetchMe().catch((error: unknown) => {
    logger.log(
      "error",
      `Error fetching bot member for islandboi slashcommand: ${error}`,
    );
  });
  if (!botMember || true !== botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: "No permissions to manage roles.",
      ephemeral: true,
    }).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to islandboi slashcommand: ${error}`,
      );
    });
    return true;
  }

  const guildUser = await guild.members.fetch(interaction.user.id).catch((error: unknown) => {
    logger.log(
      "error",
      `Error fetching user for islandboi slashcommand: ${error}`,
    );
  });
  if (!guildUser) {
    await interaction.reply({
      content: "Konnte Benutzer nicht laden.",
      ephemeral: true,
    }).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to islandboi slashcommand: ${error}`,
      );
    });
    return true;
  }

  const addRoleSuccess = await guildUser.roles.add(mutedRole).then(() => true).catch((error: unknown) => {
    logger.log(
      "error",
      `Error muting user for islandboi slashcommand: ${error}`,
    );
    return false;
  });
  if (false === addRoleSuccess) {
    await interaction.reply({
      content: "Unable to assign muted role.",
      ephemeral: true,
    }).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to islandboi slashcommand: ${error}`,
      );
    });
    return true;
  }

  const cooldownUntil = now + islandboiCooldownMs;
  islandboiCooldownByUser.set(interaction.user.id, cooldownUntil);
  const existingTimer = islandboiUnmuteTimers.get(interaction.user.id);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  await interaction.reply({
    content: "You are now muted for 60 seconds.",
    ephemeral: true,
  }).catch((error: unknown) => {
    logger.log(
      "error",
      `Error replying to islandboi slashcommand: ${error}`,
    );
  });

  logger.log(
    "info",
    `Muted ${interaction.user.username} for 60 seconds.`,
  );

  const timer = setTimeout(() => {
    guildUser.roles.remove(mutedRole).catch((error: unknown) => {
      logger.log(
        "error",
        `Error unmuting user for islandboi slashcommand: ${error}`,
      );
    }).finally(() => {
      islandboiUnmuteTimers.delete(interaction.user.id);
      islandboiCooldownByUser.delete(interaction.user.id);
    });
    logger.log(
      "info",
      `Unmuted ${interaction.user.username} after 60 seconds.`,
    );
  }, islandboiCooldownMs);
  timer.unref();
  islandboiUnmuteTimers.set(interaction.user.id, timer);

  return true;
}
