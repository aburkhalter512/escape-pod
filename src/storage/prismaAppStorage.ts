import type { Prisma, PodRound, PodRoundStatus } from '@prisma/client'
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
// Almost every AppPrismaClient method already satisfies AppStorage's
// narrower shape directly (TypeScript's bivariant method-parameter
// checking allows a wider real Prisma method where a narrower call
// shape is declared) — confirmed empirically, not just assumed. The one
// exception is podRound.findUnique/findMany: Prisma's real methods are
// fully generic (`<T extends Prisma.PodRoundFindUniqueArgs>`), and a
// generic function is not assignable to a concrete overloaded type no
// matter how compatible its instantiations are (a hard TypeScript
// limitation, confirmed via a scratch typecheck, not a design choice) —
// so those two are wrapped in real overloaded function declarations
// that just forward to the same generic Prisma call.
export function createPrismaAppStorage(prisma: AppPrismaClient): AppStorage {
  return {
    // Prisma itself has no separate methods for these two — both are
    // thin wrappers over the same prisma.organizer.update, just shaped
    // to match AppStorage's two concretely-named methods (split from one
    // overloaded `update` per PR review; see appStorage.ts's comment).
    organizer: {
      findMany: prisma.organizer.findMany,
      incrementNextRoundNumber: (args) =>
        prisma.organizer.update({ where: args.where, data: { nextRoundNumber: { increment: args.data.increment } } }),
      updateToken: (args) => prisma.organizer.update({ where: args.where, data: args.data }),
      upsert: prisma.organizer.upsert,
    },
    guildSubscription: prisma.guildSubscription,
    guildOrganizerAllowlist: prisma.guildOrganizerAllowlist,
    guildOriginAllowlist: prisma.guildOriginAllowlist,
    podRound: {
      create: prisma.podRound.create,
      findUnique: podRoundFindUnique,
      findFirst: prisma.podRound.findFirst,
      findMany: podRoundFindMany,
      update: prisma.podRound.update,
      updateMany: prisma.podRound.updateMany,
    },
    podRoundTarget: prisma.podRoundTarget,
    podRoundSignup: prisma.podRoundSignup,
  }

  function podRoundFindUnique(args: { where: { id: string } }): Promise<PodRound | null>
  function podRoundFindUnique(
    args: { where: { id: string }; include: { organizer: true } }
  ): Promise<Prisma.PodRoundGetPayload<{ include: { organizer: true } }> | null>
  function podRoundFindUnique(args: { where: { id: string }; include?: { organizer: true } }) {
    return prisma.podRound.findUnique(args)
  }

  function podRoundFindMany(args: {
    where: { organizerDiscordId: string; status: { in: PodRoundStatus[] } }
    orderBy: { organizerRoundNumber: 'asc' }
  }): Promise<PodRound[]>
  function podRoundFindMany(
    args: { where: Record<string, unknown>; include: { organizer: true } }
  ): Promise<Array<Prisma.PodRoundGetPayload<{ include: { organizer: true } }>>>
  function podRoundFindMany(args: {
    where: Record<string, unknown>
    include?: { organizer: true }
    orderBy?: { organizerRoundNumber: 'asc' }
  }) {
    return prisma.podRound.findMany(args)
  }
}
