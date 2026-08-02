import { describe, expect, it } from 'vitest'
import { ApplicationCommandOptionType, ComponentType, type APIInteractionGuildMember } from 'discord-api-types/v10'
import { escapePodSetup } from './escapePodSetup.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction, fakeMember } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'

// Discord's own type guarantees member.user is always present — this
// simulates the malformed payload that guarantee rules out, mirroring
// the old subscribeGuild.test.ts's same check.
function memberWithoutUser(): APIInteractionGuildMember {
  return { ...fakeMember(), user: undefined } as unknown as APIInteractionGuildMember
}

function interaction(overrides: Parameters<typeof fakeChatInputInteraction>[0] = {}) {
  return fakeChatInputInteraction({
    options: [{ name: 'channel', type: ApplicationCommandOptionType.Channel, value: 'channel-1' }],
    ...overrides,
  })
}

type SubscribeGuildParams = { channelId?: string }

function findButtonComponent(response: Awaited<ReturnType<typeof escapePodSetup>>) {
  const row = responseData(response).components?.[0] as { components: Array<{ custom_id: string; label: string }> } | undefined
  return row?.components[0]
}

describe('escapePodSetup', () => {
  it('subscribes a brand-new guild, confirms the channel, and includes the Niamos-link button', async () => {
    const subscribeGuildMock = stub(async (guildId: string, installedBy: string, params: SubscribeGuildParams) => {
      if (guildId !== 'guild-1' || params.channelId !== 'channel-1' || installedBy !== 'user-1') {
        throw new Error(`unexpected subscribeGuild args: ${guildId} ${JSON.stringify(params)} ${installedBy}`)
      }
      return { ok: true as const, value: { subscribed: true, broadcastChannelId: 'channel-1', isNewSubscription: true } }
    })
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await escapePodSetup(ctx)

    expect(responseData(response).content).toContain('<#channel-1>')
    expect(responseData(response).content).toMatch(/link this server's niamos token/i)
    const button = findButtonComponent(response)
    expect(button).toMatchObject({ custom_id: 'connect-niamos:open-modal', label: 'Paste your token' })
  })

  it('does not include the Niamos-link button when reconfiguring an already-subscribed guild', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, params: SubscribeGuildParams) => {
      expect(params.channelId).toBe('channel-1')
      return { ok: true as const, value: { subscribed: true, broadcastChannelId: 'channel-1', isNewSubscription: false } }
    })
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await escapePodSetup(ctx)

    expect(responseData(response).content).toMatch(/^updated/i)
    expect(responseData(response).content).toContain('<#channel-1>')
    expect(responseData(response).content).not.toMatch(/niamos/i)
    expect(responseData(response).components).toBeUndefined()
  })

  it('shows current settings without a button when no options are given', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, params: SubscribeGuildParams) => {
      expect(params).toEqual({ channelId: undefined })
      return { ok: true as const, value: { subscribed: true, broadcastChannelId: 'channel-1', isNewSubscription: false } }
    })
    const ctx: CommandContext = {
      interaction: interaction({ options: [] }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await escapePodSetup(ctx)

    expect(responseData(response).content).toMatch(/current settings/i)
    expect(responseData(response).content).not.toMatch(/^updated/i)
    expect(responseData(response).components).toBeUndefined()
  })

  it('tells the admin how to resume (no button) when the guild is currently unsubscribed and no channel is given', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, _params: SubscribeGuildParams) => ({
      ok: true as const,
      value: { subscribed: false, broadcastChannelId: 'channel-1', isNewSubscription: false },
    }))
    const ctx: CommandContext = {
      interaction: interaction({ options: [] }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await escapePodSetup(ctx)

    expect(responseData(response).content).toMatch(/isn't currently subscribed/i)
    expect(responseData(response).content).toMatch(/run this command again with a channel/i)
    expect(responseData(response).components).toBeUndefined()
  })

  it('reactivates a previously-unsubscribed guild when a channel is given (no button — not a new subscription)', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, params: SubscribeGuildParams) => {
      expect(params.channelId).toBe('channel-1')
      return { ok: true as const, value: { subscribed: true, broadcastChannelId: 'channel-1', isNewSubscription: false } }
    })
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await escapePodSetup(ctx)

    expect(responseData(response).content).toMatch(/^updated/i)
    expect(responseData(response).content).toContain('<#channel-1>')
    expect(responseData(response).components).toBeUndefined()
  })

  it("surfaces the service's validation error (e.g. first-time subscribe with no channel) as an ephemeral message, no button", async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, _params: SubscribeGuildParams) => ({
      ok: false as const,
      error: { kind: 'validation' as const, message: 'A channel is required the first time this server subscribes.' },
    }))
    const ctx: CommandContext = {
      interaction: interaction({ options: [] }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await escapePodSetup(ctx)

    expect(responseData(response).content).toMatch(/channel is required/i)
    expect(responseData(response).components).toBeUndefined()
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

    const response = await escapePodSetup(ctx)

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

    const response = await escapePodSetup(ctx)

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

    const response = await escapePodSetup(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('treats a channel option with an unexpected type the same as no channel at all', async () => {
    const subscribeGuildMock = stub(async (_guildId: string, _installedBy: string, params: SubscribeGuildParams) => {
      expect(params.channelId).toBeUndefined()
      return { ok: true as const, value: { subscribed: true, broadcastChannelId: 'channel-1', isNewSubscription: false } }
    })
    const ctx: CommandContext = {
      interaction: interaction({
        options: [{ name: 'channel', type: ApplicationCommandOptionType.String, value: 'oops' }],
      }),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    await escapePodSetup(ctx)

    expect(subscribeGuildMock.calls).toHaveLength(1)
  })

  it('the button component is a single-item ActionRow, matching connect-niamos\'s own shape', async () => {
    const subscribeGuildMock = stub(async () => ({
      ok: true as const,
      value: { subscribed: true, broadcastChannelId: 'channel-1', isNewSubscription: true },
    }))
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ subscribeGuild: subscribeGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await escapePodSetup(ctx)

    expect(responseData(response).components).toEqual([
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: expect.any(Number),
            custom_id: 'connect-niamos:open-modal',
            label: 'Paste your token',
          },
        ],
      },
    ])
  })
})
