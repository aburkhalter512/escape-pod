import { describe, expect, it } from 'vitest'
import type { RESTGetAPIGuildResult } from 'discord-api-types/v10'
import { requestTrust } from './requestTrust.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'

function interaction(overrides: Parameters<typeof fakeChatInputInteraction>[0] = {}) {
  return fakeChatInputInteraction({ options: [], ...overrides })
}

describe('requestTrust', () => {
  it('generates the /allow-guild invocation for this server, with its resolved name', async () => {
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient(),
      discordRest: createFakeDiscordRest({
        getGuild: stub(async (guildId: string) => {
          if (guildId !== 'guild-1') throw new Error(`unexpected getGuild id: ${guildId}`)
          return { name: 'My Cool Server' } as RESTGetAPIGuildResult
        }),
      }),
    }

    const response = await requestTrust(ctx)

    expect(responseData(response).content).toContain('/allow-guild origin-server-id:guild-1')
    expect(responseData(response).content).toContain('**My Cool Server**')
  })

  it('falls back to the raw ID when the bot cannot resolve this server (unexpected, but should not block the command)', async () => {
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient(),
      discordRest: createFakeDiscordRest({
        getGuild: stub(async (_guildId: string) => {
          throw new Error('lookup failed')
        }),
      }),
    }

    const response = await requestTrust(ctx)

    expect(responseData(response).content).toContain('/allow-guild origin-server-id:guild-1')
    expect(responseData(response).content).toContain('**guild-1**')
  })

  it('rejects when run outside a server', async () => {
    const ctx: CommandContext = {
      interaction: interaction({ guild_id: undefined }),
      backend: createFakeBackendClient(),
      discordRest: createFakeDiscordRest(),
    }

    const response = await requestTrust(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })
})
