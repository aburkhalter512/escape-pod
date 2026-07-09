import { describe, expect, it, vi } from 'vitest'
import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { subscribeGuild } from './subscribeGuild.js'
import type { CommandContext } from './types.js'
import type { BackendClient } from '../backendClient.js'
import { responseData } from '../testUtils/responseData.js'

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    guild_id: 'guild-1',
    member: { user: { id: 'admin-1' } },
    data: {
      options: [{ name: 'channel', type: ApplicationCommandOptionType.Channel, value: 'channel-1' }],
    },
    ...overrides,
  }
}

describe('subscribeGuild', () => {
  it('subscribes the guild and confirms the channel', async () => {
    const subscribeGuildMock = vi.fn().mockResolvedValue(undefined)
    const ctx = {
      interaction: makeInteraction(),
      backend: { subscribeGuild: subscribeGuildMock } as unknown as BackendClient,
    } as unknown as CommandContext

    const response = await subscribeGuild(ctx)

    expect(subscribeGuildMock).toHaveBeenCalledWith('guild-1', 'channel-1', 'admin-1')
    expect(responseData(response).content).toContain('<#channel-1>')
    expect(responseData(response).content).toContain('allow-list')
  })

  it('rejects when run outside a server (no guild_id)', async () => {
    const subscribeGuildMock = vi.fn()
    const ctx = {
      interaction: makeInteraction({ guild_id: undefined }),
      backend: { subscribeGuild: subscribeGuildMock } as unknown as BackendClient,
    } as unknown as CommandContext

    const response = await subscribeGuild(ctx)

    expect(subscribeGuildMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('rejects when the invoking member is missing entirely', async () => {
    const subscribeGuildMock = vi.fn()
    const ctx = {
      interaction: makeInteraction({ member: undefined }),
      backend: { subscribeGuild: subscribeGuildMock } as unknown as BackendClient,
    } as unknown as CommandContext

    const response = await subscribeGuild(ctx)

    expect(subscribeGuildMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('rejects when no channel option is provided', async () => {
    const subscribeGuildMock = vi.fn()
    const ctx = {
      interaction: makeInteraction({ data: { options: [] } }),
      backend: { subscribeGuild: subscribeGuildMock } as unknown as BackendClient,
    } as unknown as CommandContext

    const response = await subscribeGuild(ctx)

    expect(subscribeGuildMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/channel is required/i)
  })

  it('rejects when the channel option has an unexpected type', async () => {
    const subscribeGuildMock = vi.fn()
    const ctx = {
      interaction: makeInteraction({
        data: { options: [{ name: 'channel', type: ApplicationCommandOptionType.String, value: 'oops' }] },
      }),
      backend: { subscribeGuild: subscribeGuildMock } as unknown as BackendClient,
    } as unknown as CommandContext

    const response = await subscribeGuild(ctx)

    expect(subscribeGuildMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/channel is required/i)
  })
})
