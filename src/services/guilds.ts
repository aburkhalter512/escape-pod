import type { AppPrismaClient } from '../prismaClient.js'

export interface GuildServiceDeps {
  prisma: AppPrismaClient
}

export interface SubscribeGuildParams {
  guildId: string
  channelId: string
  installedBy: string
}

// INTEGRATIONS.md §7.2/§7.4 — a guild's own admin opts their server in,
// independent of any organizer. Defaults to ALLOWLIST per §7.2's safer-
// default reasoning.
export async function subscribeGuild(deps: GuildServiceDeps, params: SubscribeGuildParams): Promise<void> {
  const { guildId, channelId, installedBy } = params

  await deps.prisma.guildSubscription.upsert({
    where: { guildId },
    create: {
      guildId,
      broadcastChannelId: channelId,
      installedByDiscordId: installedBy,
    },
    update: {
      broadcastChannelId: channelId,
    },
  })
}

export interface AllowOrganizerParams {
  guildId: string
  organizerDiscordId: string
  approvedBy: string
}

// INTEGRATIONS.md §7.2/§7.4 — guild admin approves a specific organizer.
// Only consulted when the guild's policy is ALLOWLIST.
export async function allowOrganizer(deps: GuildServiceDeps, params: AllowOrganizerParams): Promise<void> {
  const { guildId, organizerDiscordId, approvedBy } = params

  await deps.prisma.guildOrganizerAllowlist.upsert({
    where: { guildId_organizerDiscordId: { guildId, organizerDiscordId } },
    create: { guildId, organizerDiscordId, approvedBy },
    update: { approvedBy },
  })
}
