import type { PostingPolicy } from '@prisma/client'
import type { AppPrismaClient } from '../prismaClient.js'
import { ValidationError } from './errors.js'

export interface GuildServiceDeps {
  prisma: AppPrismaClient
}

export interface SubscribeGuildParams {
  guildId: string
  installedBy: string
  // Both optional so this same call doubles as "reconfigure whatever was
  // given, leave the rest alone" — a guild that's already subscribed can
  // change just its channel, just its policy, or (with neither) simply
  // read back its current settings without writing anything. Only
  // required — and enforced below, not by the type — the first time a
  // guild subscribes, since there's no existing channel to fall back to.
  channelId?: string
  policy?: PostingPolicy
}

export interface SubscribeGuildResult {
  // False when the guild is currently unsubscribed and no channel was
  // given to reactivate it — broadcastChannelId/postingPolicy still
  // reflect its last-known settings (the row is soft-deleted, not gone).
  subscribed: boolean
  broadcastChannelId: string
  postingPolicy: PostingPolicy
}

// INTEGRATIONS.md §7.2/§7.4 — a guild's own admin opts their server in,
// independent of any organizer, and can reconfigure it afterward (channel
// and/or posting policy) through this same entry point. Defaults to
// ALLOWLIST per §7.2's safer-default reasoning — the schema's own default,
// applied by omitting postingPolicy from `create` below when no policy was
// given.
export async function subscribeGuild(deps: GuildServiceDeps, params: SubscribeGuildParams): Promise<SubscribeGuildResult> {
  const { guildId, installedBy, channelId, policy } = params

  const existing = await deps.prisma.guildSubscription.findUnique({ where: { guildId } })
  const isActive = !!existing && existing.unsubscribedAt === null

  if (!isActive && !channelId) {
    if (!existing) {
      throw new ValidationError('A channel is required the first time this server subscribes.')
    }
    // Previously unsubscribed and no channel given to reactivate — report
    // its last-known settings rather than writing anything or erroring;
    // the command layer tells the admin how to resume.
    return { subscribed: false, broadcastChannelId: existing.broadcastChannelId, postingPolicy: existing.postingPolicy }
  }

  if (!existing) {
    const created = await deps.prisma.guildSubscription.create({
      data: {
        guildId,
        broadcastChannelId: channelId!,
        installedByDiscordId: installedBy,
        ...(policy ? { postingPolicy: policy } : {}),
      },
    })
    return { subscribed: true, broadcastChannelId: created.broadcastChannelId, postingPolicy: created.postingPolicy }
  }

  if (isActive && !channelId && !policy) {
    // Nothing to change — e.g. an admin running the command bare just to
    // see current settings. No write, so installedAt/installedBy are
    // untouched too.
    return { subscribed: true, broadcastChannelId: existing.broadcastChannelId, postingPolicy: existing.postingPolicy }
  }

  // installedByDiscordId is deliberately never part of this update —
  // §7.2 wants it set once, at creation, not silently reassigned to
  // whoever last reconfigured the subscription. unsubscribedAt is only
  // cleared when a channel is given (reactivating) — this branch is only
  // reachable with a channel unless already active, so a policy-only call
  // on an inactive subscription can't silently resurrect it.
  const updated = await deps.prisma.guildSubscription.update({
    where: { guildId },
    data: {
      ...(channelId ? { broadcastChannelId: channelId, unsubscribedAt: null } : {}),
      ...(policy ? { postingPolicy: policy } : {}),
    },
  })
  return { subscribed: true, broadcastChannelId: updated.broadcastChannelId, postingPolicy: updated.postingPolicy }
}

export interface UnsubscribeGuildResult {
  // False if the guild was never subscribed, or was already unsubscribed
  // — lets the command layer say "already not subscribed" instead of
  // implying it just changed something.
  wasSubscribed: boolean
}

// The inverse of subscribeGuild's (re)activation path — soft-deletes by
// setting unsubscribedAt rather than deleting the row, since
// pod_round_targets' FK to this table is ON DELETE RESTRICT (a guild with
// any round history can never actually be deleted). Existing round
// history and allow-list entries are untouched; only future eligibility
// checks (listEligibleGuilds, startPod) stop counting this guild.
export async function unsubscribeGuild(deps: GuildServiceDeps, guildId: string): Promise<UnsubscribeGuildResult> {
  const existing = await deps.prisma.guildSubscription.findUnique({ where: { guildId } })
  if (!existing || existing.unsubscribedAt !== null) {
    return { wasSubscribed: false }
  }

  await deps.prisma.guildSubscription.update({
    where: { guildId },
    data: { unsubscribedAt: new Date() },
  })
  return { wasSubscribed: true }
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
