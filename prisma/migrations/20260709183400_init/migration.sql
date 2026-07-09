-- CreateEnum
CREATE TYPE "PostingPolicy" AS ENUM ('ALLOWLIST', 'OPEN');

-- CreateEnum
CREATE TYPE "PodRoundStatus" AS ENUM ('COLLECTING', 'THRESHOLD_REACHED', 'POD_CREATED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SignupStatus" AS ENUM ('IN', 'LEFT');

-- CreateTable
CREATE TABLE "organizers" (
    "discord_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "encrypted_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizers_pkey" PRIMARY KEY ("discord_id")
);

-- CreateTable
CREATE TABLE "guild_subscriptions" (
    "guild_id" TEXT NOT NULL,
    "installed_by_discord_id" TEXT NOT NULL,
    "broadcast_channel_id" TEXT NOT NULL,
    "posting_policy" "PostingPolicy" NOT NULL DEFAULT 'ALLOWLIST',
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guild_subscriptions_pkey" PRIMARY KEY ("guild_id")
);

-- CreateTable
CREATE TABLE "guild_organizer_allowlist" (
    "guild_id" TEXT NOT NULL,
    "organizer_discord_id" TEXT NOT NULL,
    "approved_by" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guild_organizer_allowlist_pkey" PRIMARY KEY ("guild_id","organizer_discord_id")
);

-- CreateTable
CREATE TABLE "pod_rounds" (
    "id" TEXT NOT NULL,
    "organizer_discord_id" TEXT NOT NULL,
    "set_code" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "status" "PodRoundStatus" NOT NULL DEFAULT 'COLLECTING',
    "ptp_pod_share_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pod_round_targets" (
    "pod_round_id" TEXT NOT NULL,
    "guild_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "message_id" TEXT,
    "approval_status" "ApprovalStatus",
    "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_round_targets_pkey" PRIMARY KEY ("pod_round_id","guild_id")
);

-- CreateTable
CREATE TABLE "pod_round_signups" (
    "pod_round_id" TEXT NOT NULL,
    "discord_id" TEXT NOT NULL,
    "username_snapshot" TEXT NOT NULL,
    "source_guild_id" TEXT NOT NULL,
    "status" "SignupStatus" NOT NULL DEFAULT 'IN',
    "signed_up_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_round_signups_pkey" PRIMARY KEY ("pod_round_id","discord_id")
);

-- AddForeignKey
ALTER TABLE "guild_organizer_allowlist" ADD CONSTRAINT "guild_organizer_allowlist_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_subscriptions"("guild_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_rounds" ADD CONSTRAINT "pod_rounds_organizer_discord_id_fkey" FOREIGN KEY ("organizer_discord_id") REFERENCES "organizers"("discord_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_round_targets" ADD CONSTRAINT "pod_round_targets_pod_round_id_fkey" FOREIGN KEY ("pod_round_id") REFERENCES "pod_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_round_targets" ADD CONSTRAINT "pod_round_targets_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_subscriptions"("guild_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_round_signups" ADD CONSTRAINT "pod_round_signups_pod_round_id_fkey" FOREIGN KEY ("pod_round_id") REFERENCES "pod_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
