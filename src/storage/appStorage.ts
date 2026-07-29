import type {
  Prisma,
  Organizer,
  GuildSubscription,
  GuildOrganizerAllowlist,
  GuildOriginAllowlist,
  PodRound,
  PodRoundTarget,
  PodRoundSignup,
  PodRoundStatus,
  PostingPolicy,
} from '@prisma/client'

// The shared data-access contract services/*.ts depends on — split out
// from appSqlStorage.ts specifically so this pure type declaration (zero
// Cloudflare-specific ambient globals) can be imported from files that
// compile under either type universe (this branch's plain tsconfig.json,
// used by AWS-reachable code like server.ts/backendClient.ts/routes/*.ts,
// and tsconfig.cloudflare.json, used by the Worker/DO side) — unlike
// appSqlStorage.ts's createAppSqlStorage implementation, which uses
// SqlStorage/SqlStorageValue (only ambient under tsconfig.cloudflare.json)
// and would fail to type-check under the plain config even via a
// type-only import, since TypeScript still processes a whole source
// file's types regardless of how it's imported elsewhere.
//
// Same table-namespaced method shape as prismaClient.ts's
// AppPrismaClient (so the services/*.ts diff against it was mechanical),
// with two concrete implementations: appSqlStorage.ts's
// createAppSqlStorage (Durable Object SQLite, this branch's Worker) and
// prismaAppStorage.ts's createPrismaAppStorage (real Prisma/Postgres,
// this branch's AWS-compatible path — routes/*.ts and backendClient.ts
// adapt a real AppPrismaClient into this shape, so server.ts/app.ts
// never need to change what they construct/pass in at all).
export interface AppStorage {
  organizer: {
    findMany(args: { where: { expiresAt: { lt: Date } } }): Promise<Organizer[]>
    // Split from one overloaded `update` (silently branching on which
    // data field was present) into two concretely-named methods per PR
    // review — each is its own real operation, not a generic update.
    // Atomic increment (see services/pods.ts's startPod doc comment on
    // why this alone, not a transaction, is what guarantees distinct
    // round numbers under concurrent callers).
    incrementNextRoundNumber(args: { where: { discordId: string }; data: { increment: number } }): Promise<Organizer>
    // jobs/refreshTokens.ts's only use — stores a freshly-rotated PTP
    // token + its new expiry.
    updateToken(args: { where: { discordId: string }; data: { encryptedToken: string; expiresAt: Date } }): Promise<Organizer>
    upsert(args: {
      where: { discordId: string }
      create: { discordId: string; username: string; encryptedToken: string; expiresAt: Date }
      update: { username: string; encryptedToken: string; expiresAt: Date }
    }): Promise<Organizer>
  }
  guildSubscription: {
    // Two distinct call shapes exist (startPod's guildId-in-list filter,
    // listEligibleGuilds's OPEN/trust OR-clause) — overloaded rather than
    // one loosely-typed signature, so each is exact instead of needing an
    // unsafe cast in the implementation below.
    findMany(args: { where: { guildId: { in: string[] }; unsubscribedAt: null } }): Promise<GuildSubscription[]>
    findMany(args: {
      where: {
        unsubscribedAt: null
        OR: [{ postingPolicy: 'OPEN' }, { originAllowlist: { some: { allowedOriginGuildId: string } } }]
      }
    }): Promise<GuildSubscription[]>
    findUnique(args: { where: { guildId: string } }): Promise<GuildSubscription | null>
    create(args: {
      data: { guildId: string; broadcastChannelId: string; installedByDiscordId: string; postingPolicy?: PostingPolicy }
    }): Promise<GuildSubscription>
    update(args: {
      where: { guildId: string }
      data: Partial<{ broadcastChannelId: string; postingPolicy: PostingPolicy; unsubscribedAt: Date | null }>
    }): Promise<GuildSubscription>
    count(args: { where: { unsubscribedAt: null } }): Promise<number>
  }
  guildOrganizerAllowlist: {
    upsert(args: {
      where: { guildId_organizerDiscordId: { guildId: string; organizerDiscordId: string } }
      create: { guildId: string; organizerDiscordId: string; approvedBy: string }
      update: { approvedBy: string }
    }): Promise<GuildOrganizerAllowlist>
  }
  guildOriginAllowlist: {
    upsert(args: {
      where: { guildId_allowedOriginGuildId: { guildId: string; allowedOriginGuildId: string } }
      create: { guildId: string; allowedOriginGuildId: string; approvedBy: string }
      update: { approvedBy: string }
    }): Promise<GuildOriginAllowlist>
  }
  podRound: {
    create(args: {
      data: {
        organizerDiscordId: string
        organizerRoundNumber: number
        setCode: string
        threshold: number
        scheduledFor?: Date
        originGuildName?: string
        originGuildId?: string
        targets: { create: Array<{ guildId: string; channelId: string }> }
      }
    }): Promise<PodRound>
    findUnique(args: { where: { id: string } }): Promise<PodRound | null>
    findUnique(
      args: { where: { id: string }; include: { organizer: true } }
    ): Promise<Prisma.PodRoundGetPayload<{ include: { organizer: true } }> | null>
    findFirst(
      args:
        | { where: { organizerDiscordId: string; organizerRoundNumber: number } }
        | { where: { organizerDiscordId: string }; orderBy: { createdAt: 'desc' } }
    ): Promise<PodRound | null>
    findMany(args: {
      where: { organizerDiscordId: string; status: { in: PodRoundStatus[] } }
      orderBy: { organizerRoundNumber: 'asc' }
    }): Promise<PodRound[]>
    findMany(
      args: { where: Record<string, unknown>; include: { organizer: true } }
    ): Promise<Array<Prisma.PodRoundGetPayload<{ include: { organizer: true } }>>>
    update(args: {
      where: { id: string }
      data: Partial<{
        status: PodRoundStatus
        ptpPodShareId: string
        chatChannelId: string
        fireFailureNotified: boolean
      }>
    }): Promise<PodRound>
    updateMany(args: {
      where: { id: string; status: PodRoundStatus }
      data: Partial<{ status: PodRoundStatus; thresholdReachedAt: Date }>
    }): Promise<{ count: number }>
  }
  podRoundTarget: {
    findMany(args: { where: { podRoundId: string } }): Promise<PodRoundTarget[]>
    findUnique(args: { where: { podRoundId_guildId: { podRoundId: string; guildId: string } } }): Promise<PodRoundTarget | null>
    update(args: {
      where: { podRoundId_guildId: { podRoundId: string; guildId: string } }
      data: { messageId: string }
    }): Promise<PodRoundTarget>
  }
  podRoundSignup: {
    count(args: { where: { podRoundId: string; status: 'IN' } }): Promise<number>
    upsert(args: {
      where: { podRoundId_discordId: { podRoundId: string; discordId: string } }
      create: { podRoundId: string; discordId: string; usernameSnapshot: string; sourceGuildId: string; status: 'IN' | 'LEFT' }
      update: { status: 'IN' | 'LEFT' }
    }): Promise<PodRoundSignup>
    findMany(args: { where: { podRoundId: string; status: 'IN' } }): Promise<PodRoundSignup[]>
  }
}
