import { unimplemented } from './stub.js'
import type { AppPrismaClient } from '../prismaClient.js'

export interface FakePrismaOverrides {
  organizer?: Partial<AppPrismaClient['organizer']>
  guildSubscription?: Partial<AppPrismaClient['guildSubscription']>
  guildOrganizerAllowlist?: Partial<AppPrismaClient['guildOrganizerAllowlist']>
  guildOriginAllowlist?: Partial<AppPrismaClient['guildOriginAllowlist']>
  podRound?: Partial<AppPrismaClient['podRound']>
  podRoundTarget?: Partial<AppPrismaClient['podRoundTarget']>
  podRoundSignup?: Partial<AppPrismaClient['podRoundSignup']>
}

// Fully satisfies AppPrismaClient (every delegate/method it declares gets a
// default stub that throws if called), so callers never need
// `as unknown as PrismaClient`. Pass overrides for the specific delegate
// methods a given test cares about.
export function createFakePrismaClient(overrides: FakePrismaOverrides = {}): AppPrismaClient {
  return {
    organizer: {
      findMany: unimplemented('organizer.findMany'),
      update: unimplemented('organizer.update'),
      upsert: unimplemented('organizer.upsert'),
      ...overrides.organizer,
    },
    guildSubscription: {
      findMany: unimplemented('guildSubscription.findMany'),
      findUnique: unimplemented('guildSubscription.findUnique'),
      create: unimplemented('guildSubscription.create'),
      update: unimplemented('guildSubscription.update'),
      count: unimplemented('guildSubscription.count'),
      ...overrides.guildSubscription,
    },
    guildOrganizerAllowlist: {
      upsert: unimplemented('guildOrganizerAllowlist.upsert'),
      ...overrides.guildOrganizerAllowlist,
    },
    guildOriginAllowlist: {
      upsert: unimplemented('guildOriginAllowlist.upsert'),
      ...overrides.guildOriginAllowlist,
    },
    podRound: {
      create: unimplemented('podRound.create'),
      findUnique: unimplemented('podRound.findUnique'),
      findFirst: unimplemented('podRound.findFirst'),
      findMany: unimplemented('podRound.findMany'),
      update: unimplemented('podRound.update'),
      updateMany: unimplemented('podRound.updateMany'),
      ...overrides.podRound,
    },
    podRoundTarget: {
      findMany: unimplemented('podRoundTarget.findMany'),
      findUnique: unimplemented('podRoundTarget.findUnique'),
      update: unimplemented('podRoundTarget.update'),
      ...overrides.podRoundTarget,
    },
    podRoundSignup: {
      count: unimplemented('podRoundSignup.count'),
      upsert: unimplemented('podRoundSignup.upsert'),
      findMany: unimplemented('podRoundSignup.findMany'),
      ...overrides.podRoundSignup,
    },
  }
}
