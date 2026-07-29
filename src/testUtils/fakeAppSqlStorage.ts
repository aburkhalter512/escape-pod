import { unimplemented } from './stub.js'
import type { AppStorage } from '../storage/appStorage.js'

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
// testUtils/fakePrismaClient.ts. Each AppStorage method is now its own
// concretely-named, non-overloaded signature (per PR review), so plain
// unimplemented() works everywhere — no more unimplementedOverloaded
// workaround for guildSubscription.findMany/podRound.findMany, since
// those generic overloaded methods no longer exist.
export function createFakeAppSqlStorage(overrides: FakeAppStorageOverrides = {}): AppStorage {
  return {
    organizer: {
      findExpiringBefore: unimplemented('organizer.findExpiringBefore'),
      incrementNextRoundNumber: unimplemented('organizer.incrementNextRoundNumber'),
      updateToken: unimplemented('organizer.updateToken'),
      linkOrganizer: unimplemented('organizer.linkOrganizer'),
      ...overrides.organizer,
    },
    guildSubscription: {
      findActiveByGuildIds: unimplemented('guildSubscription.findActiveByGuildIds'),
      findEligibleForOrigin: unimplemented('guildSubscription.findEligibleForOrigin'),
      findByGuildId: unimplemented('guildSubscription.findByGuildId'),
      createSubscription: unimplemented('guildSubscription.createSubscription'),
      updateSettings: unimplemented('guildSubscription.updateSettings'),
      markUnsubscribed: unimplemented('guildSubscription.markUnsubscribed'),
      countActiveSubscriptions: unimplemented('guildSubscription.countActiveSubscriptions'),
      ...overrides.guildSubscription,
    },
    guildOrganizerAllowlist: {
      approveOrganizer: unimplemented('guildOrganizerAllowlist.approveOrganizer'),
      ...overrides.guildOrganizerAllowlist,
    },
    guildOriginAllowlist: {
      approveOriginGuild: unimplemented('guildOriginAllowlist.approveOriginGuild'),
      ...overrides.guildOriginAllowlist,
    },
    podRound: {
      createRoundWithTargets: unimplemented('podRound.createRoundWithTargets'),
      findRoundById: unimplemented('podRound.findRoundById'),
      findRoundWithOrganizerById: unimplemented('podRound.findRoundWithOrganizerById'),
      findRoundByOrganizerAndNumber: unimplemented('podRound.findRoundByOrganizerAndNumber'),
      findLatestRoundForOrganizer: unimplemented('podRound.findLatestRoundForOrganizer'),
      findActiveRoundsForOrganizer: unimplemented('podRound.findActiveRoundsForOrganizer'),
      findOverdueRounds: unimplemented('podRound.findOverdueRounds'),
      findStuckThresholdReachedRounds: unimplemented('podRound.findStuckThresholdReachedRounds'),
      markPodCreated: unimplemented('podRound.markPodCreated'),
      markCancelled: unimplemented('podRound.markCancelled'),
      markConcluded: unimplemented('podRound.markConcluded'),
      markFireFailureNotified: unimplemented('podRound.markFireFailureNotified'),
      claimForFiring: unimplemented('podRound.claimForFiring'),
      claimExpired: unimplemented('podRound.claimExpired'),
      ...overrides.podRound,
    },
    podRoundTarget: {
      findByRoundId: unimplemented('podRoundTarget.findByRoundId'),
      findByRoundAndGuild: unimplemented('podRoundTarget.findByRoundAndGuild'),
      setMessageId: unimplemented('podRoundTarget.setMessageId'),
      ...overrides.podRoundTarget,
    },
    podRoundSignup: {
      countSignedUp: unimplemented('podRoundSignup.countSignedUp'),
      recordSignup: unimplemented('podRoundSignup.recordSignup'),
      findSignedUp: unimplemented('podRoundSignup.findSignedUp'),
      ...overrides.podRoundSignup,
    },
  }
}
