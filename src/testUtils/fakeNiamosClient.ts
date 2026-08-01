import { unimplemented } from './stub.js'
import type { NiamosClient } from '../niamos/client.js'

// Fully satisfies the NiamosClient interface, so callers never need
// `as unknown as NiamosClient` — every method defaults to throwing if
// called; pass overrides for the ones a given test cares about. Replaces
// fakePtpClient.ts.
export function createFakeNiamosClient(overrides: Partial<NiamosClient> = {}): NiamosClient {
  return {
    whoami: unimplemented('whoami'),
    createDraft: unimplemented('createDraft'),
    ...overrides,
  }
}
