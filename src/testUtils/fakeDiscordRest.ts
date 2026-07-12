import { unimplemented } from './stub.js'
import type { DiscordRestClient } from '../discord/rest.js'

// Fully satisfies the DiscordRestClient interface, so callers never need
// `as unknown as REST` — postMessage/editMessage each default to throwing
// if called; pass overrides for the ones a given test cares about.
export function createFakeDiscordRest(overrides: Partial<DiscordRestClient> = {}): DiscordRestClient {
  return {
    postMessage: unimplemented('postMessage'),
    editMessage: unimplemented('editMessage'),
    getGuild: unimplemented('getGuild'),
    createChannel: unimplemented('createChannel'),
    createInvite: unimplemented('createInvite'),
    createDmChannel: unimplemented('createDmChannel'),
    ...overrides,
  }
}
