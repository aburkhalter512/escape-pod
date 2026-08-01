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
  {
    // Added post-launch (PR review) — a new migration, not a change to
    // migration 1's own statements, since the real deployed DO already
    // has migration 1 marked applied in _schema_migrations; modifying it
    // in place would mean this table silently never gets created there.
    // Backs pendingStartPods.ts's DO-storage implementation, replacing an
    // in-memory Map that didn't survive a DO's idle-eviction/restart
    // cycle between the /start-pod select-guilds and confirm steps (a
    // real, higher-frequency risk on this platform than the equivalent
    // AWS in-memory store ever had, since a DO's JS memory — unlike its
    // storage — is routinely evicted, not just restarted on deploys).
    id: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS pending_start_pods (
        token TEXT PRIMARY KEY,
        organizer_discord_id TEXT NOT NULL,
        set_code TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        scheduled_for TEXT,
        origin_guild_name TEXT,
        origin_guild_id TEXT,
        guild_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    // PTP -> Niamos hard cutover (dropped entirely, no dual support —
    // see the migration plan). Niamos tokens are scoped per-guild, not
    // per-organizer like PTP's were, so organizers' PTP-specific
    // columns become dead and a new guild-keyed token table replaces
    // them. DROP COLUMN isn't just cosmetic here: the new
    // incrementNextRoundNumber upsert (see appSqlStorage.ts) INSERTs
    // only (discord_id, next_round_number) — these NOT NULL,
    // no-default columns would otherwise reject that INSERT outright,
    // and SQLite has no ALTER COLUMN to relax NOT NULL in place.
    // organizers.next_round_number and every pod_rounds row are
    // untouched — round-numbering continuity and full round history
    // survive this migration unchanged.
    id: 3,
    statements: [
      `ALTER TABLE organizers DROP COLUMN username`,
      `ALTER TABLE organizers DROP COLUMN encrypted_token`,
      `ALTER TABLE organizers DROP COLUMN expires_at`,
      `ALTER TABLE organizers DROP COLUMN linked_at`,

      // One Niamos bearer token per Discord guild (confirmed with
      // Niamos's author) — linked once by any guild admin via
      // /connect-niamos, then usable by any eligible organizer's
      // /start-pod from that guild. No FK to guild_subscriptions: a
      // guild can link a token independent of its broadcast-
      // subscription status, same non-FK reasoning as
      // pod_rounds.origin_guild_id below.
      `CREATE TABLE IF NOT EXISTS guild_niamos_tokens (
        guild_id TEXT PRIMARY KEY,
        encrypted_token TEXT NOT NULL,
        linked_by_discord_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        display_name TEXT NOT NULL
      )`,
    ],
  },
]
