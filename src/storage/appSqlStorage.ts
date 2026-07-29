import type { Organizer, PodRoundStatus } from '@prisma/client'
import type { AppStorage } from './appStorage.js'
import {
  one,
  maybeOne,
  all,
  toIso,
  mapOrganizerRow,
  mapGuildSubscriptionRow,
  mapGuildOrganizerAllowlistRow,
  mapGuildOriginAllowlistRow,
  mapPodRoundRow,
  mapPodRoundTargetRow,
  mapPodRoundSignupRow,
} from './rowMappers.js'

// The Durable Object SQLite implementation of appStorage.ts's AppStorage
// contract — hand-written parameterized SQL instead of a generated
// client or query-builder dialect (no Prisma driver adapter exists for
// DO's synchronous, non-network SqlStorage object, and a 7-table schema
// with this bounded a query surface doesn't need one).
export type { AppStorage }

// Each entity's methods are built by their own function below (per PR
// review), then combined into one object by createAppSqlStorage at the
// bottom — instead of one giant object literal, so each table's query
// surface can be read (and reviewed) on its own.

function createOrganizerStorage(sql: SqlStorage): AppStorage['organizer'] {
  return {
    async findExpiringBefore(cutoff) {
      const rows = all(sql, 'SELECT * FROM organizers WHERE expires_at < ?', toIso(cutoff))
      return rows.map(mapOrganizerRow)
    },
    async incrementNextRoundNumber(args) {
      const row = one(
        sql,
        'UPDATE organizers SET next_round_number = next_round_number + ? WHERE discord_id = ? RETURNING *',
        args.data.increment,
        args.where.discordId
      )
      return mapOrganizerRow(row)
    },
    async updateToken(args) {
      const row = one(
        sql,
        'UPDATE organizers SET encrypted_token = ?, expires_at = ? WHERE discord_id = ? RETURNING *',
        args.data.encryptedToken,
        toIso(args.data.expiresAt),
        args.where.discordId
      )
      return mapOrganizerRow(row)
    },
    async linkOrganizer(args) {
      // ON CONFLICT SET binds args.update.*'s own values explicitly
      // rather than referencing excluded.* (which would silently reuse
      // args.create.*'s values instead) — the two objects are allowed
      // to differ per the interface's own contract, even though every
      // real caller today happens to pass matching values for both.
      const row = one(
        sql,
        `INSERT INTO organizers (discord_id, username, encrypted_token, expires_at, linked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (discord_id) DO UPDATE SET
           username = ?,
           encrypted_token = ?,
           expires_at = ?
         RETURNING *`,
        args.where.discordId,
        args.create.username,
        args.create.encryptedToken,
        toIso(args.create.expiresAt),
        toIso(new Date()),
        args.update.username,
        args.update.encryptedToken,
        toIso(args.update.expiresAt)
      )
      return mapOrganizerRow(row)
    },
  }
}

function createGuildSubscriptionStorage(sql: SqlStorage): AppStorage['guildSubscription'] {
  return {
    async findActiveByGuildIds(guildIds) {
      if (guildIds.length === 0) return []
      const placeholders = guildIds.map(() => '?').join(', ')
      const rows = all(
        sql,
        `SELECT * FROM guild_subscriptions WHERE unsubscribed_at IS NULL AND guild_id IN (${placeholders})`,
        ...guildIds
      )
      return rows.map(mapGuildSubscriptionRow)
    },
    async findEligibleForOrigin(originGuildId) {
      const rows = all(
        sql,
        `SELECT DISTINCT gs.* FROM guild_subscriptions gs
         LEFT JOIN guild_origin_allowlist goa ON goa.guild_id = gs.guild_id AND goa.allowed_origin_guild_id = ?
         WHERE gs.unsubscribed_at IS NULL AND (gs.posting_policy = 'OPEN' OR goa.guild_id IS NOT NULL)`,
        originGuildId
      )
      return rows.map(mapGuildSubscriptionRow)
    },
    async findByGuildId(guildId) {
      const row = maybeOne(sql, 'SELECT * FROM guild_subscriptions WHERE guild_id = ?', guildId)
      return row ? mapGuildSubscriptionRow(row) : null
    },
    async createSubscription(args) {
      const row = one(
        sql,
        `INSERT INTO guild_subscriptions (guild_id, installed_by_discord_id, broadcast_channel_id, posting_policy, installed_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`,
        args.data.guildId,
        args.data.installedByDiscordId,
        args.data.broadcastChannelId,
        args.data.postingPolicy ?? 'ALLOWLIST',
        toIso(new Date())
      )
      return mapGuildSubscriptionRow(row)
    },
    async updateSettings(args) {
      const sets: string[] = []
      const values: unknown[] = []
      if (args.data.broadcastChannelId !== undefined) {
        sets.push('broadcast_channel_id = ?')
        values.push(args.data.broadcastChannelId)
      }
      if (args.data.postingPolicy !== undefined) {
        sets.push('posting_policy = ?')
        values.push(args.data.postingPolicy)
      }
      if ('unsubscribedAt' in args.data) {
        sets.push('unsubscribed_at = ?')
        values.push(args.data.unsubscribedAt ? toIso(args.data.unsubscribedAt) : null)
      }
      values.push(args.where.guildId)
      const row = one(sql, `UPDATE guild_subscriptions SET ${sets.join(', ')} WHERE guild_id = ? RETURNING *`, ...values)
      return mapGuildSubscriptionRow(row)
    },
    async markUnsubscribed(guildId) {
      const row = one(
        sql,
        'UPDATE guild_subscriptions SET unsubscribed_at = ? WHERE guild_id = ? RETURNING *',
        toIso(new Date()),
        guildId
      )
      return mapGuildSubscriptionRow(row)
    },
    async countActiveSubscriptions() {
      const row = one<{ n: number }>(sql, 'SELECT COUNT(*) as n FROM guild_subscriptions WHERE unsubscribed_at IS NULL')
      return row.n
    },
  }
}

function createGuildOrganizerAllowlistStorage(sql: SqlStorage): AppStorage['guildOrganizerAllowlist'] {
  return {
    async approveOrganizer(args) {
      const row = one(
        sql,
        `INSERT INTO guild_organizer_allowlist (guild_id, organizer_discord_id, approved_by, approved_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, organizer_discord_id) DO UPDATE SET approved_by = ?
         RETURNING *`,
        args.where.guildId_organizerDiscordId.guildId,
        args.where.guildId_organizerDiscordId.organizerDiscordId,
        args.create.approvedBy,
        toIso(new Date()),
        args.update.approvedBy
      )
      return mapGuildOrganizerAllowlistRow(row)
    },
  }
}

function createGuildOriginAllowlistStorage(sql: SqlStorage): AppStorage['guildOriginAllowlist'] {
  return {
    async approveOriginGuild(args) {
      const row = one(
        sql,
        `INSERT INTO guild_origin_allowlist (guild_id, allowed_origin_guild_id, approved_by, approved_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, allowed_origin_guild_id) DO UPDATE SET approved_by = ?
         RETURNING *`,
        args.where.guildId_allowedOriginGuildId.guildId,
        args.where.guildId_allowedOriginGuildId.allowedOriginGuildId,
        args.create.approvedBy,
        toIso(new Date()),
        args.update.approvedBy
      )
      return mapGuildOriginAllowlistRow(row)
    },
  }
}

// Shared by findRoundWithOrganizerById/findOverdueRounds/
// findStuckThresholdReachedRounds below — one place for "fetch this
// round's organizer row and fold it in."
function findOrganizer(sql: SqlStorage, discordId: string): Organizer {
  return mapOrganizerRow(one(sql, 'SELECT * FROM organizers WHERE discord_id = ?', discordId))
}

function createPodRoundStorage(sql: SqlStorage): AppStorage['podRound'] {
  return {
    async createRoundWithTargets(args) {
      const id = crypto.randomUUID()
      const now = toIso(new Date())
      const row = one(
        sql,
        `INSERT INTO pod_rounds (
           id, organizer_discord_id, organizer_round_number, set_code, threshold,
           scheduled_for, origin_guild_name, origin_guild_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
        id,
        args.data.organizerDiscordId,
        args.data.organizerRoundNumber,
        args.data.setCode,
        args.data.threshold,
        args.data.scheduledFor ? toIso(args.data.scheduledFor) : null,
        args.data.originGuildName ?? null,
        args.data.originGuildId ?? null,
        now
      )
      for (const target of args.data.targets.create) {
        sql.exec(
          `INSERT INTO pod_round_targets (pod_round_id, guild_id, channel_id, posted_at) VALUES (?, ?, ?, ?)`,
          id,
          target.guildId,
          target.channelId,
          now
        )
      }
      return mapPodRoundRow(row)
    },
    async findRoundById(id) {
      const row = maybeOne(sql, 'SELECT * FROM pod_rounds WHERE id = ?', id)
      return row ? mapPodRoundRow(row) : null
    },
    async findRoundWithOrganizerById(id) {
      const row = maybeOne(sql, 'SELECT * FROM pod_rounds WHERE id = ?', id)
      if (!row) return null
      const round = mapPodRoundRow(row)
      return { ...round, organizer: findOrganizer(sql, round.organizerDiscordId) }
    },
    async findRoundByOrganizerAndNumber(organizerDiscordId, organizerRoundNumber) {
      const row = maybeOne(
        sql,
        'SELECT * FROM pod_rounds WHERE organizer_discord_id = ? AND organizer_round_number = ?',
        organizerDiscordId,
        organizerRoundNumber
      )
      return row ? mapPodRoundRow(row) : null
    },
    async findLatestRoundForOrganizer(organizerDiscordId) {
      const row = maybeOne(
        sql,
        'SELECT * FROM pod_rounds WHERE organizer_discord_id = ? ORDER BY created_at DESC LIMIT 1',
        organizerDiscordId
      )
      return row ? mapPodRoundRow(row) : null
    },
    async findActiveRoundsForOrganizer(organizerDiscordId, statuses) {
      const placeholders = statuses.map(() => '?').join(', ')
      const rows = all(
        sql,
        `SELECT * FROM pod_rounds WHERE organizer_discord_id = ? AND status IN (${placeholders}) ORDER BY organizer_round_number ASC`,
        organizerDiscordId,
        ...statuses
      )
      return rows.map(mapPodRoundRow)
    },
    async findOverdueRounds(scheduledBefore) {
      const rows = all(
        sql,
        'SELECT * FROM pod_rounds WHERE status = ? AND scheduled_for IS NOT NULL AND scheduled_for <= ?',
        'COLLECTING' satisfies PodRoundStatus,
        toIso(scheduledBefore)
      )
      return rows.map(mapPodRoundRow).map((round) => ({ ...round, organizer: findOrganizer(sql, round.organizerDiscordId) }))
    },
    async findStuckThresholdReachedRounds() {
      const rows = all(
        sql,
        'SELECT * FROM pod_rounds WHERE status = ? AND fire_failure_notified = 0',
        'THRESHOLD_REACHED' satisfies PodRoundStatus
      )
      return rows.map(mapPodRoundRow).map((round) => ({ ...round, organizer: findOrganizer(sql, round.organizerDiscordId) }))
    },
    async markPodCreated(id, data) {
      // !== undefined, not truthy — chatChannelId is always either a real
      // Discord channel snowflake (never '') or undefined in practice (see
      // discord/podChat.ts's createPodChatSpace), but matching the old
      // update()'s exact semantics here isn't worth relying on that
      // invariant holding forever for free.
      const row = data.chatChannelId !== undefined
        ? one(
            sql,
            `UPDATE pod_rounds SET status = 'POD_CREATED', ptp_pod_share_id = ?, chat_channel_id = ? WHERE id = ? RETURNING *`,
            data.ptpPodShareId,
            data.chatChannelId,
            id
          )
        : one(
            sql,
            `UPDATE pod_rounds SET status = 'POD_CREATED', ptp_pod_share_id = ? WHERE id = ? RETURNING *`,
            data.ptpPodShareId,
            id
          )
      return mapPodRoundRow(row)
    },
    async markCancelled(id) {
      const row = one(sql, `UPDATE pod_rounds SET status = 'CANCELLED' WHERE id = ? RETURNING *`, id)
      return mapPodRoundRow(row)
    },
    async markConcluded(id) {
      const row = one(sql, `UPDATE pod_rounds SET status = 'CONCLUDED' WHERE id = ? RETURNING *`, id)
      return mapPodRoundRow(row)
    },
    async markFireFailureNotified(id) {
      const row = one(sql, `UPDATE pod_rounds SET fire_failure_notified = 1 WHERE id = ? RETURNING *`, id)
      return mapPodRoundRow(row)
    },
    async claimForFiring(id, thresholdReachedAt) {
      // This is the actual compare-and-swap: 0 means some other caller's
      // WHERE already changed the status first (see fireRound's doc
      // comment in services/pods.ts), 1 means this call won the claim.
      const cursor = sql.exec(
        `UPDATE pod_rounds SET status = 'THRESHOLD_REACHED', threshold_reached_at = ? WHERE id = ? AND status = 'COLLECTING'`,
        toIso(thresholdReachedAt),
        id
      )
      return { count: cursor.rowsWritten }
    },
    async claimExpired(id) {
      // Same compare-and-swap shape as claimForFiring above.
      const cursor = sql.exec(`UPDATE pod_rounds SET status = 'EXPIRED' WHERE id = ? AND status = 'COLLECTING'`, id)
      return { count: cursor.rowsWritten }
    },
  }
}

function createPodRoundTargetStorage(sql: SqlStorage): AppStorage['podRoundTarget'] {
  return {
    async findByRoundId(podRoundId) {
      const rows = all(sql, 'SELECT * FROM pod_round_targets WHERE pod_round_id = ?', podRoundId)
      return rows.map(mapPodRoundTargetRow)
    },
    async findByRoundAndGuild(podRoundId, guildId) {
      const row = maybeOne(sql, 'SELECT * FROM pod_round_targets WHERE pod_round_id = ? AND guild_id = ?', podRoundId, guildId)
      return row ? mapPodRoundTargetRow(row) : null
    },
    async setMessageId(podRoundId, guildId, messageId) {
      const row = one(
        sql,
        'UPDATE pod_round_targets SET message_id = ? WHERE pod_round_id = ? AND guild_id = ? RETURNING *',
        messageId,
        podRoundId,
        guildId
      )
      return mapPodRoundTargetRow(row)
    },
  }
}

function createPodRoundSignupStorage(sql: SqlStorage): AppStorage['podRoundSignup'] {
  return {
    async countSignedUp(podRoundId) {
      const row = one<{ n: number }>(
        sql,
        `SELECT COUNT(*) as n FROM pod_round_signups WHERE pod_round_id = ? AND status = 'IN'`,
        podRoundId
      )
      return row.n
    },
    async recordSignup(args) {
      const row = one(
        sql,
        `INSERT INTO pod_round_signups (pod_round_id, discord_id, username_snapshot, source_guild_id, status, signed_up_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (pod_round_id, discord_id) DO UPDATE SET status = ?
         RETURNING *`,
        args.where.podRoundId_discordId.podRoundId,
        args.where.podRoundId_discordId.discordId,
        args.create.usernameSnapshot,
        args.create.sourceGuildId,
        args.create.status,
        toIso(new Date()),
        args.update.status
      )
      return mapPodRoundSignupRow(row)
    },
    async findSignedUp(podRoundId) {
      const rows = all(sql, `SELECT * FROM pod_round_signups WHERE pod_round_id = ? AND status = 'IN'`, podRoundId)
      return rows.map(mapPodRoundSignupRow)
    },
  }
}

export function createAppSqlStorage(sql: SqlStorage): AppStorage {
  return {
    organizer: createOrganizerStorage(sql),
    guildSubscription: createGuildSubscriptionStorage(sql),
    guildOrganizerAllowlist: createGuildOrganizerAllowlistStorage(sql),
    guildOriginAllowlist: createGuildOriginAllowlistStorage(sql),
    podRound: createPodRoundStorage(sql),
    podRoundTarget: createPodRoundTargetStorage(sql),
    podRoundSignup: createPodRoundSignupStorage(sql),
  }
}
