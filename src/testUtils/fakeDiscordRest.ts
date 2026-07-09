import { vi } from 'vitest'
import type { DiscordRestClient } from '../discord/rest.js'

// Fully satisfies the DiscordRestClient interface, so callers never need
// `as unknown as REST` — post/patch each get a default vi.fn() stub;
// pass overrides for the ones a given test cares about.
export function createFakeDiscordRest(overrides: Partial<DiscordRestClient> = {}): DiscordRestClient {
  return {
    post: vi.fn(),
    patch: vi.fn(),
    ...overrides,
  }
}
