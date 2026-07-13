import { unimplemented } from './stub.js'
import type { BackendClient } from '../backendClient.js'

// Fully satisfies the BackendClient interface, so callers never need
// `as unknown as BackendClient` — every method defaults to throwing if
// called; pass overrides for the ones a given test cares about.
export function createFakeBackendClient(overrides: Partial<BackendClient> = {}): BackendClient {
  return {
    linkOrganizer: unimplemented('linkOrganizer'),
    subscribeGuild: unimplemented('subscribeGuild'),
    unsubscribeGuild: unimplemented('unsubscribeGuild'),
    allowOrganizer: unimplemented('allowOrganizer'),
    listEligibleGuilds: unimplemented('listEligibleGuilds'),
    startPod: unimplemented('startPod'),
    recordMessagePosted: unimplemented('recordMessagePosted'),
    recordSignup: unimplemented('recordSignup'),
    cancelPod: unimplemented('cancelPod'),
    cancelActiveRound: unimplemented('cancelActiveRound'),
    concludeActiveRound: unimplemented('concludeActiveRound'),
    ...overrides,
  }
}
