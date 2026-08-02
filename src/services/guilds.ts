import type { AppStorage } from '../storage/appStorage.js'
import { ok, err, validationError, type Result } from './errors.js'

export interface GuildServiceDeps {
  storage: AppStorage
}

export interface SubscribeGuildParams {
  guildId: string
  installedBy: string
  // Optional so this same call doubles as "reconfigure the channel, or
  // (if omitted) simply read back current settings without writing
  // anything." Only required — and enforced below, not by the type —
  // the first time a guild subscribes, since there's no existing
  // channel to fall back to.
  channelId?: string
}

export interface SubscribeGuildResult {
  // False when the guild is currently unsubscribed and no channel was
  // given to reactivate it — broadcastChannelId still reflects its
  // last-known setting (the row is soft-deleted, not gone).
  subscribed: boolean
  broadcastChannelId: string
  // True only when this call created the GuildSubscription row for the
  // first time ever (vs. reconfiguring, reactivating, or a no-op
  // readback of an existing one) — lets a caller (commands/
  // escapePodSetup.ts) show first-time-only onboarding content (the
  // Niamos-token-linking prompt) without repeating it on every routine
  // reconfigure.
  isNewSubscription: boolean
}

// INTEGRATIONS.md §7.2/§7.4 — a guild's own admin opts their server in,
// independent of any organizer, and can reconfigure its channel
// afterward through this same entry point. ALLOWLIST is the only
// posting policy (see storage/schema.ts migration 4) — a guild's own
// organizers trust it automatically (self-trust, see
// services/organizers.ts's listEligibleGuilds), other origin guilds
// need an explicit /allow-guild grant.
export async function subscribeGuild(
  deps: GuildServiceDeps,
  params: SubscribeGuildParams
): Promise<Result<SubscribeGuildResult>> {
  const { guildId, installedBy, channelId } = params

  const existing = await deps.storage.guildSubscription.findByGuildId(guildId)
  const isActive = !!existing && existing.unsubscribedAt === null

  if (!isActive && !channelId) {
    if (!existing) {
      return err(validationError('A channel is required the first time this server subscribes.'))
    }
    // Previously unsubscribed and no channel given to reactivate — report
    // its last-known settings rather than writing anything or erroring;
    // the command layer tells the admin how to resume.
    return ok({ subscribed: false, broadcastChannelId: existing.broadcastChannelId, isNewSubscription: false })
  }

  if (!existing) {
    const created = await deps.storage.guildSubscription.createSubscription({
      data: { guildId, broadcastChannelId: channelId!, installedByDiscordId: installedBy },
    })
    return ok({ subscribed: true, broadcastChannelId: created.broadcastChannelId, isNewSubscription: true })
  }

  if (isActive && !channelId) {
    // Nothing to change — e.g. an admin running the command bare just to
    // see current settings. No write, so installedAt/installedBy are
    // untouched too.
    return ok({ subscribed: true, broadcastChannelId: existing.broadcastChannelId, isNewSubscription: false })
  }

  // installedByDiscordId is deliberately never part of this update —
  // §7.2 wants it set once, at creation, not silently reassigned to
  // whoever last reconfigured the subscription. unsubscribedAt is
  // cleared here since this branch is only reachable with a channel
  // given (reactivating or just changing it).
  const updated = await deps.storage.guildSubscription.updateSettings({
    where: { guildId },
    data: { broadcastChannelId: channelId, unsubscribedAt: null },
  })
  return ok({ subscribed: true, broadcastChannelId: updated.broadcastChannelId, isNewSubscription: false })
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
  const existing = await deps.storage.guildSubscription.findByGuildId(guildId)
  if (!existing || existing.unsubscribedAt !== null) {
    return { wasSubscribed: false }
  }

  await deps.storage.guildSubscription.markUnsubscribed(guildId)
  return { wasSubscribed: true }
}

export interface AllowOrganizerParams {
  guildId: string
  organizerDiscordId: string
  approvedBy: string
}

// Deprecated (see allowGuild below, which replaces this) — no longer
// consulted by listEligibleGuilds, so calling this has no effect on
// eligibility anymore. Still writes to GuildOrganizerAllowlist (harmless,
// just inert) rather than becoming a no-op function outright, since the
// command layer (commands/allowOrganizer.ts) still owns deciding what
// deprecated-command UX to show — this function's job is only ever "do
// the write," not "decide whether to."
export async function allowOrganizer(deps: GuildServiceDeps, params: AllowOrganizerParams): Promise<void> {
  const { guildId, organizerDiscordId, approvedBy } = params

  await deps.storage.guildOrganizerAllowlist.approveOrganizer({
    where: { guildId_organizerDiscordId: { guildId, organizerDiscordId } },
    create: { guildId, organizerDiscordId, approvedBy },
    update: { approvedBy },
  })
}

export interface AllowGuildParams {
  guildId: string
  allowedOriginGuildId: string
  approvedBy: string
}

// Replaces allowOrganizer above — trusts an entire origin guild (see
// GuildOriginAllowlist, schema.prisma; services/organizers.ts's
// listEligibleGuilds is what actually consults this) rather than
// approving individual organizers one at a time. Same upsert shape as
// allowOrganizer: re-running for an already-trusted origin guild just
// refreshes who approved it, not an error.
//
// Requires guildId (the server granting trust) to already have an
// active GuildSubscription — guild_origin_allowlist.guild_id has a real
// FK to guild_subscriptions(guild_id), so writing without checking first
// surfaces as a raw SQLite FOREIGN KEY constraint failure instead of a
// clear message (confirmed live in production).
export async function allowGuild(deps: GuildServiceDeps, params: AllowGuildParams): Promise<Result<void>> {
  const { guildId, allowedOriginGuildId, approvedBy } = params

  const subscription = await deps.storage.guildSubscription.findByGuildId(guildId)
  if (!subscription) {
    return err(validationError('This server needs to run /escape-pod-setup before it can trust other servers.'))
  }

  await deps.storage.guildOriginAllowlist.approveOriginGuild({
    where: { guildId_allowedOriginGuildId: { guildId, allowedOriginGuildId } },
    create: { guildId, allowedOriginGuildId, approvedBy },
    update: { approvedBy },
  })
  return ok(undefined)
}
