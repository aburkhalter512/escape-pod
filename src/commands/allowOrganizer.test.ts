import { describe, expect, it } from 'vitest'
import { allowOrganizer } from './allowOrganizer.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'

function interaction(overrides: Parameters<typeof fakeChatInputInteraction>[0] = {}) {
  return fakeChatInputInteraction({ options: [], ...overrides })
}

describe('allowOrganizer (deprecated)', () => {
  it('points the admin at /allow-guild instead of granting anything', async () => {
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient(),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowOrganizer(ctx)

    expect(responseData(response).content).toMatch(/`\/allow-organizer` is deprecated/i)
    expect(responseData(response).content).toMatch(/`\/allow-guild`/i)
  })

  it('rejects when run outside a server, before producing the deprecation message', async () => {
    const ctx: CommandContext = {
      interaction: interaction({ guild_id: undefined, member: undefined }),
      backend: createFakeBackendClient(),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowOrganizer(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })
})
