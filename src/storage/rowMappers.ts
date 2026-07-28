import type {
  Organizer,
  GuildSubscription,
  GuildOrganizerAllowlist,
  GuildOriginAllowlist,
  PodRound,
  PodRoundTarget,
  PodRoundSignup,
} from '@prisma/client'

// Prisma's @map(...) did snake_case<->camelCase conversion and Date
// (de)serialization for free; DO SQLite storage returns plain row objects
// (SqlStorageValue = ArrayBuffer | string | number | null, an ambient
// global from @cloudflare/workers-types) keyed by the raw column name,
// with dates stored as ISO8601 TEXT (chosen for debuggability at this
// data volume — reversible if it ever mattered) — these mappers are the
// replacement. Row shapes below intentionally reuse Prisma's own
// generated model types (Organizer, GuildSubscription, etc., imported
// type-only so nothing Prisma-runtime ships in the Worker bundle) so
// services/*.ts needs zero changes to what it expects back.

type RawRow = Record<string, SqlStorageValue>

export function toIso(date: Date): string {
  return date.toISOString()
}

export function fromIso(text: SqlStorageValue): Date {
  return new Date(text as string)
}

export function fromIsoNullable(text: SqlStorageValue): Date | null {
  return text === null ? null : new Date(text as string)
}

export function mapOrganizerRow(row: RawRow): Organizer {
  return {
    discordId: row.discord_id as string,
    username: row.username as string,
    encryptedToken: row.encrypted_token as string,
    expiresAt: fromIso(row.expires_at),
    linkedAt: fromIso(row.linked_at),
    nextRoundNumber: row.next_round_number as number,
  }
}

export function mapGuildSubscriptionRow(row: RawRow): GuildSubscription {
  return {
    guildId: row.guild_id as string,
    installedByDiscordId: row.installed_by_discord_id as string,
    broadcastChannelId: row.broadcast_channel_id as string,
    postingPolicy: row.posting_policy as GuildSubscription['postingPolicy'],
    installedAt: fromIso(row.installed_at),
    unsubscribedAt: fromIsoNullable(row.unsubscribed_at),
  }
}

export function mapGuildOrganizerAllowlistRow(row: RawRow): GuildOrganizerAllowlist {
  return {
    guildId: row.guild_id as string,
    organizerDiscordId: row.organizer_discord_id as string,
    approvedBy: row.approved_by as string,
    approvedAt: fromIso(row.approved_at),
  }
}

export function mapGuildOriginAllowlistRow(row: RawRow): GuildOriginAllowlist {
  return {
    guildId: row.guild_id as string,
    allowedOriginGuildId: row.allowed_origin_guild_id as string,
    approvedBy: row.approved_by as string,
    approvedAt: fromIso(row.approved_at),
  }
}

export function mapPodRoundRow(row: RawRow): PodRound {
  return {
    id: row.id as string,
    organizerDiscordId: row.organizer_discord_id as string,
    organizerRoundNumber: row.organizer_round_number as number,
    setCode: row.set_code as string,
    threshold: row.threshold as number,
    status: row.status as PodRound['status'],
    scheduledFor: fromIsoNullable(row.scheduled_for),
    ptpPodShareId: row.ptp_pod_share_id as string | null,
    createdAt: fromIso(row.created_at),
    originGuildName: row.origin_guild_name as string | null,
    originGuildId: row.origin_guild_id as string | null,
    chatChannelId: row.chat_channel_id as string | null,
    thresholdReachedAt: fromIsoNullable(row.threshold_reached_at),
    fireFailureNotified: row.fire_failure_notified !== 0,
  }
}

export function mapPodRoundTargetRow(row: RawRow): PodRoundTarget {
  return {
    podRoundId: row.pod_round_id as string,
    guildId: row.guild_id as string,
    channelId: row.channel_id as string,
    messageId: row.message_id as string | null,
    approvalStatus: row.approval_status as PodRoundTarget['approvalStatus'],
    postedAt: fromIso(row.posted_at),
  }
}

export function mapPodRoundSignupRow(row: RawRow): PodRoundSignup {
  return {
    podRoundId: row.pod_round_id as string,
    discordId: row.discord_id as string,
    usernameSnapshot: row.username_snapshot as string,
    sourceGuildId: row.source_guild_id as string,
    status: row.status as PodRoundSignup['status'],
    signedUpAt: fromIso(row.signed_up_at),
  }
}
