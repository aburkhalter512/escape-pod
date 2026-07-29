import { unimplemented } from './stub.js'
import type { AppStorage } from '../storage/appStorage.js'

// unimplemented()'s generic Args/Result inference can only pick one
// concrete signature when the target property is a real TS overload
// (guildSubscription.findMany, podRound.findMany both have two distinct
// call shapes — see appStorage.ts) — the single inferred stub then
// fails to structurally satisfy the *other* overload branch. This never
// needs .calls tracking (its whole point is to throw if ever called; a
// real test override replacing it via `Partial<...>` gets full stub()
// tracking as normal), so a plain cast to the overloaded type is the
// pragmatic fix, scoped to just these two methods.
function unimplementedOverloaded<T>(name: string): T {
  return ((..._args: unknown[]) => {
    throw new Error(`${name} was called without a test override`)
  }) as T
}

export interface FakeAppStorageOverrides {
  organizer?: Partial<AppStorage['organizer']>
  guildSubscription?: Partial<AppStorage['guildSubscription']>
  guildOrganizerAllowlist?: Partial<AppStorage['guildOrganizerAllowlist']>
  guildOriginAllowlist?: Partial<AppStorage['guildOriginAllowlist']>
  podRound?: Partial<AppStorage['podRound']>
  podRoundTarget?: Partial<AppStorage['podRoundTarget']>
  podRoundSignup?: Partial<AppStorage['podRoundSignup']>
}

// Fully satisfies AppStorage (every method it declares gets a default
// stub that throws if called), so callers never need `as unknown as
// AppStorage`. Pass overrides for the specific methods a given test
// cares about — same hand-curated-structural-fake convention as
// testUtils/fakePrismaClient.ts, which this mirrors 1:1 (same method
// names, same table namespacing) since AppStorage's whole point is
// being a drop-in-shaped sibling of AppPrismaClient.
export function createFakeAppSqlStorage(overrides: FakeAppStorageOverrides = {}): AppStorage {
  return {
    organizer: {
      findMany: unimplemented('organizer.findMany'),
      incrementNextRoundNumber: unimplemented('organizer.incrementNextRoundNumber'),
      updateToken: unimplemented('organizer.updateToken'),
      upsert: unimplemented('organizer.upsert'),
      ...overrides.organizer,
    },
    guildSubscription: {
      findMany: unimplementedOverloaded<AppStorage['guildSubscription']['findMany']>('guildSubscription.findMany'),
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
      findMany: unimplementedOverloaded<AppStorage['podRound']['findMany']>('podRound.findMany'),
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
