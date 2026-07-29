import type { AppPrismaClient } from '../prismaClient.js'
import type { AppStorage } from './appStorage.js'

// The AWS-side counterpart to appSqlStorage.ts's createAppSqlStorage —
// same AppStorage contract, backed by a real Prisma/Postgres client
// instead of DO SQLite. Exists so services/*.ts can depend on one
// shared interface (AppStorage) and run unmodified on both platforms:
// this branch's Worker/DO uses createAppSqlStorage, while
// routes/*.ts and backendClient.ts (the two places that construct
// service deps from a real AppPrismaClient) adapt via this function —
// app.ts/server.ts themselves need no changes at all, since they only
// ever construct/pass a plain AppPrismaClient, exactly as before.
//
// Prisma itself has no equivalent to AppStorage's concretely-named
// methods (each maps to one real caller's use — see appStorage.ts's own
// comments) — every method below is a thin wrapper translating one
// concrete operation into the generic Prisma call it always used to be.
export function createPrismaAppStorage(prisma: AppPrismaClient): AppStorage {
  return {
    organizer: {
      findExpiringBefore: (cutoff) => prisma.organizer.findMany({ where: { expiresAt: { lt: cutoff } } }),
      incrementNextRoundNumber: (args) =>
        prisma.organizer.update({ where: args.where, data: { nextRoundNumber: { increment: args.data.increment } } }),
      updateToken: (args) => prisma.organizer.update({ where: args.where, data: args.data }),
      linkOrganizer: (args) => prisma.organizer.upsert(args),
    },

    guildSubscription: {
      findActiveByGuildIds: (guildIds) =>
        guildIds.length === 0
          ? Promise.resolve([])
          : prisma.guildSubscription.findMany({ where: { guildId: { in: guildIds }, unsubscribedAt: null } }),
      findEligibleForOrigin: (originGuildId) =>
        prisma.guildSubscription.findMany({
          where: {
            unsubscribedAt: null,
            OR: [{ postingPolicy: 'OPEN' }, { originAllowlist: { some: { allowedOriginGuildId: originGuildId } } }],
          },
        }),
      findByGuildId: (guildId) => prisma.guildSubscription.findUnique({ where: { guildId } }),
      createSubscription: (args) => prisma.guildSubscription.create(args),
      updateSettings: (args) => prisma.guildSubscription.update(args),
      markUnsubscribed: (guildId) =>
        prisma.guildSubscription.update({ where: { guildId }, data: { unsubscribedAt: new Date() } }),
      countActiveSubscriptions: () => prisma.guildSubscription.count({ where: { unsubscribedAt: null } }),
    },

    guildOrganizerAllowlist: {
      approveOrganizer: (args) => prisma.guildOrganizerAllowlist.upsert(args),
    },

    guildOriginAllowlist: {
      approveOriginGuild: (args) => prisma.guildOriginAllowlist.upsert(args),
    },

    podRound: {
      createRoundWithTargets: (args) => prisma.podRound.create(args),
      findRoundById: (id) => prisma.podRound.findUnique({ where: { id } }),
      findRoundWithOrganizerById: (id) => prisma.podRound.findUnique({ where: { id }, include: { organizer: true } }),
      findRoundByOrganizerAndNumber: (organizerDiscordId, organizerRoundNumber) =>
        prisma.podRound.findFirst({ where: { organizerDiscordId, organizerRoundNumber } }),
      findLatestRoundForOrganizer: (organizerDiscordId) =>
        prisma.podRound.findFirst({ where: { organizerDiscordId }, orderBy: { createdAt: 'desc' } }),
      findActiveRoundsForOrganizer: (organizerDiscordId, statuses) =>
        prisma.podRound.findMany({
          where: { organizerDiscordId, status: { in: statuses } },
          orderBy: { organizerRoundNumber: 'asc' },
        }),
      findOverdueRounds: (scheduledBefore) =>
        prisma.podRound.findMany({
          where: { status: 'COLLECTING', scheduledFor: { lte: scheduledBefore } },
          include: { organizer: true },
        }),
      findStuckThresholdReachedRounds: () =>
        prisma.podRound.findMany({
          where: { status: 'THRESHOLD_REACHED', fireFailureNotified: false },
          include: { organizer: true },
        }),
      // !== undefined, not truthy — see appSqlStorage.ts's matching comment.
      markPodCreated: (id, data) =>
        prisma.podRound.update({
          where: { id },
          data: {
            status: 'POD_CREATED',
            ptpPodShareId: data.ptpPodShareId,
            ...(data.chatChannelId !== undefined ? { chatChannelId: data.chatChannelId } : {}),
          },
        }),
      markCancelled: (id) => prisma.podRound.update({ where: { id }, data: { status: 'CANCELLED' } }),
      markConcluded: (id) => prisma.podRound.update({ where: { id }, data: { status: 'CONCLUDED' } }),
      markFireFailureNotified: (id) => prisma.podRound.update({ where: { id }, data: { fireFailureNotified: true } }),
      claimForFiring: (id, thresholdReachedAt) =>
        prisma.podRound.updateMany({
          where: { id, status: 'COLLECTING' },
          data: { status: 'THRESHOLD_REACHED', thresholdReachedAt },
        }),
      claimExpired: (id) => prisma.podRound.updateMany({ where: { id, status: 'COLLECTING' }, data: { status: 'EXPIRED' } }),
    },

    podRoundTarget: {
      findByRoundId: (podRoundId) => prisma.podRoundTarget.findMany({ where: { podRoundId } }),
      findByRoundAndGuild: (podRoundId, guildId) =>
        prisma.podRoundTarget.findUnique({ where: { podRoundId_guildId: { podRoundId, guildId } } }),
      setMessageId: (podRoundId, guildId, messageId) =>
        prisma.podRoundTarget.update({ where: { podRoundId_guildId: { podRoundId, guildId } }, data: { messageId } }),
    },

    podRoundSignup: {
      countSignedUp: (podRoundId) => prisma.podRoundSignup.count({ where: { podRoundId, status: 'IN' } }),
      recordSignup: (args) => prisma.podRoundSignup.upsert(args),
      findSignedUp: (podRoundId) => prisma.podRoundSignup.findMany({ where: { podRoundId, status: 'IN' } }),
    },
  }
}
