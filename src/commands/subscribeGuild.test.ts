import { describe, expect, it } from 'vitest'
import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { subscribeGuild } from './subscribeGuild.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { fakeChatInputInteraction } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'

function interaction(overrides: Parameters<typeof fakeChatInputInteraction>[0] = {}) {
  return fakeChatInputInteraction({
    options: [{ name: 'channel', type: ApplicationCommandOptionType.Channel, value: 'channel-1' }],
    ...overrides,
  })
}

describe('subscribeGuild', () => {
  it('subscribes the guild and confirms the channel', async () => {
    const subscribeGuildMock = stub(async (guildId: string, channelId: string, installedBy: string) => {
      if (guildId !== 'guild-1' || channelId !== 'channel-1' || installedBy !== 'user-1') {
        throw new Error(`unexpected subscribeGuild args: ${guildId} ${channelId} ${installedBy}`)
      }
    })
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toContain('<#channel-1>')
    expect(responseData(response).content).toContain('allow-list')
  })

  it('rejects when run outside a server (no guild_id)', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _channelId: string, _installedBy: string) => {
      throw new Error('subscribeGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ guild_id: undefined, member: undefined }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('rejects when the invoking member is missing entirely', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _channelId: string, _installedBy: string) => {
      throw new Error('subscribeGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ member: undefined }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('rejects when no channel option is provided', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _channelId: string, _installedBy: string) => {
      throw new Error('subscribeGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ options: [] }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/channel is required/i)
  })

  it('rejects when the channel option has an unexpected type', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _channelId: string, _installedBy: string) => {
      throw new Error('subscribeGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({
        options: [{ name: 'channel', type: ApplicationCommandOptionType.String, value: 'oops' }],
      }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/channel is required/i)
  })
})
