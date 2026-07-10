import { describe, expect, it } from 'vitest'
import { cancelPod } from './cancelPod.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction, fakeMember, fakeUser } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'

describe('cancelPod', () => {
  it('rejects when neither member nor user is present', async () => {
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ guild_id: undefined, member: undefined }),
      backend: createFakeBackendClient(),
      discordRest: createFakeDiscordRest(),
    }

    const response = await cancelPod(ctx)

    expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
  })

  it("tells the organizer there's nothing to cancel when they have no active round", async () => {
    const cancelActiveRound = stub(async (_organizerDiscordId: string) => null)
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ cancelActiveRound }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await cancelPod(ctx)

    expect(cancelActiveRound.calls).toEqual([['organizer-1']])
    expect(responseData(response).content).toMatch(/don't have an active pod round/i)
  })

  it('cancels the round and edits every target guild message with a messageId', async () => {
    const cancelActiveRound = stub(async (_organizerDiscordId: string) => ({
      podRoundId: 'round-1',
      setCode: 'JTL',
      originGuildName: null,
      targets: [
        { channelId: 'channel-1', messageId: 'msg-1' },
        { channelId: 'channel-2', messageId: null }, // never got a message posted — nothing to edit
        { channelId: 'channel-3', messageId: 'msg-3' },
      ],
    }))
    const editMessage = stub(async (_channelId: string, _messageId: string, _body: unknown) => ({}) as never)
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ cancelActiveRound }),
      discordRest: createFakeDiscordRest({ editMessage }),
    }

    const response = await cancelPod(ctx)

    expect(editMessage.calls).toHaveLength(2)
    expect(editMessage.calls.map((call) => call[0])).toEqual(['channel-1', 'channel-3'])
    expect(responseData(response).content).toMatch(/cancelled your jtl round/i)
  })

  it("includes the origin guild's name in the cancelled message's footer", async () => {
    const cancelActiveRound = stub(async (_organizerDiscordId: string) => ({
      podRoundId: 'round-1',
      setCode: 'JTL',
      originGuildName: 'Sister Community',
      targets: [{ channelId: 'channel-1', messageId: 'msg-1' }],
    }))
    const editMessage = stub(async (_channelId: string, _messageId: string, body: { embeds: Array<{ footer?: { text: string } }> }) => {
      expect(body.embeds[0].footer?.text).toContain('Sister Community')
      return {} as never
    })
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ cancelActiveRound }),
      discordRest: createFakeDiscordRest({ editMessage }),
    }

    await cancelPod(ctx)

    expect(editMessage.calls).toHaveLength(1)
  })

  it('resolves the organizer id from user.id when member is absent (DM-style interaction)', async () => {
    const cancelActiveRound = stub(async (_organizerDiscordId: string) => null)
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: undefined, user: fakeUser({ id: 'organizer-2' }) }),
      backend: createFakeBackendClient({ cancelActiveRound }),
      discordRest: createFakeDiscordRest(),
    }

    await cancelPod(ctx)

    expect(cancelActiveRound.calls).toEqual([['organizer-2']])
  })
})
