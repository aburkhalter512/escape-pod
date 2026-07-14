-- CreateTable
-- Replaces GuildOrganizerAllowlist as the source of ALLOWLIST-policy
-- eligibility — that table is left untouched (no data migrated; an
-- organizer-based approval can't be mechanically translated into
-- guild-based trust, that's a real decision each admin makes once via
-- the new /allow-guild command).
CREATE TABLE "guild_origin_allowlist" (
    "guild_id" TEXT NOT NULL,
    "allowed_origin_guild_id" TEXT NOT NULL,
    "approved_by" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guild_origin_allowlist_pkey" PRIMARY KEY ("guild_id","allowed_origin_guild_id")
);

-- AddForeignKey
ALTER TABLE "guild_origin_allowlist" ADD CONSTRAINT "guild_origin_allowlist_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_subscriptions"("guild_id") ON DELETE CASCADE ON UPDATE CASCADE;
