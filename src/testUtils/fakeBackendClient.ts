import { vi } from 'vitest'
import type { BackendClient } from '../backendClient.js'

// Fully satisfies the BackendClient interface, so callers never need
// `as unknown as BackendClient` — every method has a default vi.fn() stub;
// pass overrides for the ones a given test cares about.
export function createFakeBackendClient(overrides: Partial<BackendClient> = {}): BackendClient {
  return {
    linkOrganizer: vi.fn(),
    subscribeGuild: vi.fn(),
    allowOrganizer: vi.fn(),
    listEligibleGuilds: vi.fn(),
    startPod: vi.fn(),
    recordMessagePosted: vi.fn(),
    recordSignup: vi.fn(),
    cancelPod: vi.fn(),
    ...overrides,
  }
}
