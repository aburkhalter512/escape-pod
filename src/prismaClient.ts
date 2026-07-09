import type { Prisma, PrismaClient } from '@prisma/client'

// Prisma's generated delegate methods are generic and return a chainable
// `PrismaPromise`, not a plain `Promise` — great for real usage, but that
// shape can't be satisfied by a hand-written test stub without falling
// back to a mocking library's untyped `vi.fn()`. This flattens each method
// to a plain (args) => Promise<result> signature, with the argument/return
// *types* still derived from Prisma's generated types (via Parameters/
// ReturnType) so they stay in sync with prisma/schema.prisma with zero
// hand-duplication — only the generic/chainable machinery is stripped.
// Real PrismaClient instances still satisfy this structurally with no cast
// (see server.ts); testUtils/fakePrismaClient.ts hand-satisfies it too.
type Method<M extends (...args: never[]) => unknown> = (args: Parameters<M>[0]) => Promise<Awaited<ReturnType<M>>>

export interface AppPrismaClient {
  organizer: {
    findMany: Method<PrismaClient['organizer']['findMany']>
    update: Method<PrismaClient['organizer']['update']>
    upsert: Method<PrismaClient['organizer']['upsert']>
  }
  guildSubscription: {
    findMany: Method<PrismaClient['guildSubscription']['findMany']>
    upsert: Method<PrismaClient['guildSubscription']['upsert']>
  }
  guildOrganizerAllowlist: {
    upsert: Method<PrismaClient['guildOrganizerAllowlist']['upsert']>
  }
  podRound: {
    create: Method<PrismaClient['podRound']['create']>
    // Called both with and without `include: { organizer: true }` (see
    // routes/pods.ts), so unlike the other methods here this one stays
    // generic per call — same as Prisma's own signature — instead of
    // collapsing to one fixed return shape.
    findUnique<T extends Prisma.PodRoundFindUniqueArgs>(
      args: Prisma.SelectSubset<T, Prisma.PodRoundFindUniqueArgs>
    ): Promise<Prisma.PodRoundGetPayload<T> | null>
    update: Method<PrismaClient['podRound']['update']>
    // Used as an atomic compare-and-swap (WHERE status: 'COLLECTING') to
    // claim the right to create the PTP pod — see tasks/001. A plain
    // findUnique-then-update is racy under concurrent signups; Postgres
    // serializes conditional UPDATEs, so only one concurrent caller ever
    // sees count: 1.
    updateMany: Method<PrismaClient['podRound']['updateMany']>
  }
  podRoundTarget: {
    findMany: Method<PrismaClient['podRoundTarget']['findMany']>
    findUnique: Method<PrismaClient['podRoundTarget']['findUnique']>
    update: Method<PrismaClient['podRoundTarget']['update']>
  }
  podRoundSignup: {
    count: Method<PrismaClient['podRoundSignup']['count']>
    upsert: Method<PrismaClient['podRoundSignup']['upsert']>
  }
}
