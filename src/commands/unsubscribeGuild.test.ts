import { describe, expect, it } from 'vitest'
import { unsubscribeGuild } from './unsubscribeGuild.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'

describe('unsubscribeGuild', () => {
  it('unsubscribes the guild and confirms it', async () => {
    const unsubscribeGuildMock = stub(async (guildId: string) => {
      if (guildId !== 'guild-1') throw new Error(`unexpected unsubscribeGuild arg: ${guildId}`)
      return { wasSubscribed: true }
    })
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction(),
      backend: createFakeBackendClient({ unsubscribeGuild: unsubscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await unsubscribeGuild(ctx)

    expect(unsubscribeGuildMock.calls).toHaveLength(1)
    expect(responseData(response).content).toMatch(/no longer receive draft pod broadcasts/i)
    expect(responseData(response).content).toMatch(/\/subscribe-guild/)
  })

  it('tells the admin it was already unsubscribed rather than implying anything just changed', async () => {
    const unsubscribeGuildMock = stub(async (_guildId: string) => ({ wasSubscribed: false }))
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction(),
      backend: createFakeBackendClient({ unsubscribeGuild: unsubscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await unsubscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/wasn't subscribed/i)
  })

  it('rejects when run outside a server (no guild_id)', async () => {
    const unsubscribeGuildMock = stub(async (_guildId: string) => {
      throw new Error('unsubscribeGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ guild_id: undefined, member: undefined }),
      backend: createFakeBackendClient({ unsubscribeGuild: unsubscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await unsubscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })
})
