import { unimplemented } from './stub.js'
import type { PtpClient } from '../ptp/client.js'

// Fully satisfies the PtpClient interface, so callers never need
// `as unknown as PtpClient` — every method defaults to throwing if called;
// pass overrides for the ones a given test cares about.
export function createFakePtpClient(overrides: Partial<PtpClient> = {}): PtpClient {
  return {
    validateToken: unimplemented('validateToken'),
    createPod: unimplemented('createPod'),
    refreshToken: unimplemented('refreshToken'),
    ...overrides,
  }
}
