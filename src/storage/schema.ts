// Fresh SQLite schema for this branch's Durable Object storage — the
// current, final shape of prisma/schema.prisma (7 tables), not a literal
// replay of its 10 incremental Postgres migrations (those included one
// Postgres-only backfill using a window function, irrelevant here since
// this branch starts with empty storage, no data to migrate — confirmed
// with the project owner). AWS/main keeps using prisma/schema.prisma and
// its migrations unmodified; this is a separate, parallel schema.
//
// SQLite has no enum type — status/policy columns are TEXT with a CHECK
// constraint standing in for Prisma's enums. Dates are stored as ISO8601
// TEXT (see rowMappers.ts) rather than SQLite's INTEGER-epoch convention,
// chosen for debuggability at this data volume (a handful of guilds/
// organizers) — reversible if it ever mattered. Booleans are INTEGER
// (0/1), SQLite's own convention.
//
// No indexes beyond what PRIMARY KEY/UNIQUE already provide — at this
// app's scale (a handful of rows per table) a full table scan is
// effectively free; adding indexes now would be complexity with no
// measurable benefit, revisit only if that stops being true.
export interface Migration {
  id: number
  statements: string[]
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS organizers (
        discord_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        encrypted_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        next_round_number INTEGER NOT NULL DEFAULT 1
      )`,

      `CREATE TABLE IF NOT EXISTS guild_subscriptions (
        guild_id TEXT PRIMARY KEY,
        installed_by_discord_id TEXT NOT NULL,
        broadcast_channel_id TEXT NOT NULL,
        posting_policy TEXT NOT NULL DEFAULT 'ALLOWLIST' CHECK (posting_policy IN ('ALLOWLIST', 'OPEN')),
        installed_at TEXT NOT NULL,
        unsubscribed_at TEXT
      )`,

      // Deprecated on the AWS side (see services/guilds.ts's
      // allowOrganizer doc comment) — kept here for shape-parity with
      // prisma/schema.prisma even though nothing on this branch ever
      // reads from it; allowOrganizer still writes to it (soft
      // deprecation, matches the AWS side's own behavior).
      `CREATE TABLE IF NOT EXISTS guild_organizer_allowlist (
        guild_id TEXT NOT NULL,
        organizer_discord_id TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, organizer_discord_id),
        FOREIGN KEY (guild_id) REFERENCES guild_subscriptions(guild_id) ON DELETE CASCADE
      )`,

      `CREATE TABLE IF NOT EXISTS guild_origin_allowlist (
        guild_id TEXT NOT NULL,
        allowed_origin_guild_id TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, allowed_origin_guild_id),
        FOREIGN KEY (guild_id) REFERENCES guild_subscriptions(guild_id) ON DELETE CASCADE
      )`,

      `CREATE TABLE IF NOT EXISTS pod_rounds (
        id TEXT PRIMARY KEY,
        organizer_discord_id TEXT NOT NULL,
        organizer_round_number INTEGER NOT NULL,
        set_code TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'COLLECTING' CHECK (
          status IN ('COLLECTING', 'THRESHOLD_REACHED', 'POD_CREATED', 'CANCELLED', 'EXPIRED', 'CONCLUDED')
        ),
        scheduled_for TEXT,
        ptp_pod_share_id TEXT,
        created_at TEXT NOT NULL,
        origin_guild_name TEXT,
        origin_guild_id TEXT,
        chat_channel_id TEXT,
        threshold_reached_at TEXT,
        fire_failure_notified INTEGER NOT NULL DEFAULT 0,
        UNIQUE (organizer_discord_id, organizer_round_number),
        FOREIGN KEY (organizer_discord_id) REFERENCES organizers(discord_id) ON DELETE RESTRICT
      )`,

      `CREATE TABLE IF NOT EXISTS pod_round_targets (
        pod_round_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        approval_status TEXT CHECK (approval_status IS NULL OR approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
        posted_at TEXT NOT NULL,
        PRIMARY KEY (pod_round_id, guild_id),
        FOREIGN KEY (pod_round_id) REFERENCES pod_rounds(id) ON DELETE CASCADE,
        FOREIGN KEY (guild_id) REFERENCES guild_subscriptions(guild_id) ON DELETE RESTRICT
      )`,

      `CREATE TABLE IF NOT EXISTS pod_round_signups (
        pod_round_id TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        username_snapshot TEXT NOT NULL,
        source_guild_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'IN' CHECK (status IN ('IN', 'LEFT')),
        signed_up_at TEXT NOT NULL,
        PRIMARY KEY (pod_round_id, discord_id),
        FOREIGN KEY (pod_round_id) REFERENCES pod_rounds(id) ON DELETE CASCADE
      )`,
    ],
  },
]
