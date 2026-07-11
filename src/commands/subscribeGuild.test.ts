import { describe, expect, it } from 'vitest'
import { ApplicationCommandOptionType, type APIInteractionGuildMember } from 'discord-api-types/v10'
import { subscribeGuild } from './subscribeGuild.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction, fakeMember } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'
import { ValidationError } from '../services/errors.js'

// Discord's own type guarantees member.user is always present — this
// simulates the malformed payload that guarantee rules out, to prove the
// `?.` in subscribeGuild.ts actually degrades gracefully instead of
// throwing a TypeError (tasks/004).
function memberWithoutUser(): APIInteractionGuildMember {
  return { ...fakeMember(), user: undefined } as unknown as APIInteractionGuildMember
}

function interaction(overrides: Parameters<typeof fakeChatInputInteraction>[0] = {}) {
  return fakeChatInputInteraction({
    options: [{ name: 'channel', type: ApplicationCommandOptionType.Channel, value: 'channel-1' }],
    ...overrides,
  })
}

type SubscribeGuildParams = { channelId?: string; policy?: 'OPEN' | 'ALLOWLIST' }

describe('subscribeGuild', () => {
  it('subscribes the guild and confirms the channel and policy', async () => {
    const subscribeGuildMock = stub(async (guildId: string, installedBy: string, params: SubscribeGuildParams) => {
      if (guildId !== 'guild-1' || params.channelId !== 'channel-1' || installedBy !== 'user-1') {
        throw new Error(`unexpected subscribeGuild args: ${guildId} ${JSON.stringify(params)} ${installedBy}`)
      }
      return { subscribed: true, broadcastChannelId: 'channel-1', postingPolicy: 'ALLOWLIST' as const }
    })
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toContain('<#channel-1>')
    expect(responseData(response).content).toMatch(/allow-list/i)
  })

  it('passes the policy option through when provided', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, params: SubscribeGuildParams) => {
      expect(params.policy).toBe('OPEN')
      return { subscribed: true, broadcastChannelId: 'channel-1', postingPolicy: 'OPEN' as const }
    })
    const ctx: CommandContext = {
      interaction: interaction({
        options: [
          { name: 'channel', type: ApplicationCommandOptionType.Channel, value: 'channel-1' },
          { name: 'policy', type: ApplicationCommandOptionType.String, value: 'OPEN' },
        ],
      }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await subscribeGuild(ctx)

    expect(subscribeGuildMock.calls).toHaveLength(1)
    expect(responseData(response).content).toMatch(/open/i)
    // Open policy has no organizer allow-list to manage, unlike ALLOWLIST.
    expect(responseData(response).content).not.toMatch(/allow-organizer/i)
  })

  it('shows current settings without claiming anything changed when no options are given', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, params: SubscribeGuildParams) => {
      expect(params).toEqual({ channelId: undefined, policy: undefined })
      return { subscribed: true, broadcastChannelId: 'channel-1', postingPolicy: 'ALLOWLIST' as const }
    })
    const ctx: CommandContext = {
      interaction: interaction({ options: [] }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/current settings/i)
    expect(responseData(response).content).not.toMatch(/^updated/i)
  })

  it('tells the admin how to resume when the guild is currently unsubscribed and no channel is given', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, _params: SubscribeGuildParams) => ({
      subscribed: false,
      broadcastChannelId: 'channel-1',
      postingPolicy: 'ALLOWLIST' as const,
    }))
    const ctx: CommandContext = {
      interaction: interaction({ options: [] }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/isn't currently subscribed/i)
    expect(responseData(response).content).toMatch(/run this command again with a channel/i)
  })

  it('reactivates a previously-unsubscribed guild when a channel is given', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, params: SubscribeGuildParams) => {
      expect(params.channelId).toBe('channel-1')
      return { subscribed: true, broadcastChannelId: 'channel-1', postingPolicy: 'ALLOWLIST' as const }
    })
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/^updated/i)
    expect(responseData(response).content).toContain('<#channel-1>')
  })

  it("surfaces the service's validation error (e.g. first-time subscribe with no channel) as an ephemeral message", async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, _params: SubscribeGuildParams) => {
      throw new ValidationError('A channel is required the first time this server subscribes.')
    })
    const ctx: CommandContext = {
      interaction: interaction({ options: [] }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/channel is required/i)
  })

  it('rejects when run outside a server (no guild_id)', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, _params: SubscribeGuildParams) => {
      throw new Error('subscribeGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ guild_id: undefined, member: undefined }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('rejects when the invoking member is missing entirely', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, _params: SubscribeGuildParams) => {
      throw new Error('subscribeGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ member: undefined }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('degrades to the same response (not a thrown error) when member is present but member.user is missing', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, _params: SubscribeGuildParams) => {
      throw new Error('subscribeGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ member: memberWithoutUser() }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await subscribeGuild(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('treats a channel option with an unexpected type the same as no channel at all', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, params: SubscribeGuildParams) => {
      expect(params.channelId).toBeUndefined()
      return { subscribed: true, broadcastChannelId: 'channel-1', postingPolicy: 'ALLOWLIST' as const }
    })
    const ctx: CommandContext = {
      interaction: interaction({
        options: [{ name: 'channel', type: ApplicationCommandOptionType.String, value: 'oops' }],
      }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    await subscribeGuild(ctx)

    expect(subscribeGuildMock.calls).toHaveLength(1)
  })
})
