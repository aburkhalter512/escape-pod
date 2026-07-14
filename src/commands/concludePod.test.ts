import { describe, expect, it } from 'vitest'
import { concludePod } from './concludePod.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction, fakeMember, fakeUser } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'
import type { ConcludeActiveRoundResult } from '../services/pods.js'
import type { Result } from '../services/errors.js'

function okResult(overrides: Partial<ConcludeActiveRoundResult> = {}): Result<ConcludeActiveRoundResult> {
  return {
    ok: true,
    value: {
      podRoundId: 'round-1',
      setCode: 'JTL',
      organizerRoundNumber: 1,
      originGuildName: null,
      chatChannelId: null,
      targets: [{ channelId: 'channel-1', messageId: 'msg-1' }],
      ...overrides,
    },
  }
}

describe('concludePod', () => {
  it('rejects when neither member nor user is present', async () => {
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ guild_id: undefined, member: undefined }),
      backend: createFakeBackendClient(),
      discordRest: createFakeDiscordRest(),
    }

    const response = await concludePod(ctx)

    expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
  })

  it("tells the organizer there's nothing to conclude when they have no round at all", async () => {
    const concludeActiveRound = stub(async (_organizerDiscordId: string) =>
      ({ ok: false, error: { kind: 'not_found', message: "You don't have a pod round to conclude." } }) as const
    )
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ concludeActiveRound }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await concludePod(ctx)

    expect(concludeActiveRound.calls).toEqual([['organizer-1']])
    expect(responseData(response).content).toMatch(/don't have a pod round to conclude/i)
  })

  it.each([
    "This round hasn't fired yet — nothing to conclude. Did you mean `/cancel-pod`?",
    'This round was already cancelled.',
    'This round already expired.',
    'This round has already been concluded.',
  ])('surfaces the validation error message %s verbatim as the ephemeral reply', async (message) => {
    const concludeActiveRound = stub(async (_organizerDiscordId: string) =>
      ({ ok: false, error: { kind: 'validation', message } }) as const
    )
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ concludeActiveRound }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await concludePod(ctx)

    expect(responseData(response).content).toBe(message)
  })

  it('concludes the round, edits every target guild message with a messageId, deletes the chat channel, and replies ephemeral success', async () => {
    const concludeActiveRound = stub(async (_organizerDiscordId: string) =>
      okResult({
        chatChannelId: 'chat-channel-1',
        targets: [
          { channelId: 'channel-1', messageId: 'msg-1' },
          { channelId: 'channel-2', messageId: null }, // never got a message posted — nothing to edit
          { channelId: 'channel-3', messageId: 'msg-3' },
        ],
      })
    )
    const editMessage = stub(async (_channelId: string, _messageId: string, _body: unknown) => ({}) as never)
    const deleteChannel = stub(async (_channelId: string) => undefined)
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ concludeActiveRound }),
      discordRest: createFakeDiscordRest({ editMessage, deleteChannel }),
    }

    const response = await concludePod(ctx)

    expect(editMessage.calls).toHaveLength(2)
    expect(editMessage.calls.map((call) => call[0])).toEqual(['channel-1', 'channel-3'])
    expect(deleteChannel.calls).toEqual([['chat-channel-1']])
    expect(responseData(response).content).toMatch(/concluded your jtl round/i)
  })

  it('does not attempt to delete a channel when chatChannelId is null', async () => {
    const concludeActiveRound = stub(async (_organizerDiscordId: string) => okResult({ chatChannelId: null }))
    const deleteChannel = stub(async (_channelId: string) => undefined)
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ concludeActiveRound }),
      discordRest: createFakeDiscordRest({ editMessage: stub(async () => ({}) as never), deleteChannel }),
    }

    await concludePod(ctx)

    expect(deleteChannel.calls).toHaveLength(0)
  })

  it('swallows (logs, does not throw) a deleteChannel failure and still replies with ephemeral success', async () => {
    const concludeActiveRound = stub(async (_organizerDiscordId: string) => okResult({ chatChannelId: 'chat-channel-1' }))
    const editMessage = stub(async (_channelId: string, _messageId: string, _body: unknown) => ({}) as never)
    const deleteChannel = stub(async (_channelId: string) => {
      throw new Error('404 Unknown Channel')
    })
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ concludeActiveRound }),
      discordRest: createFakeDiscordRest({ editMessage, deleteChannel }),
    }

    const response = await concludePod(ctx)

    expect(deleteChannel.calls).toEqual([['chat-channel-1']])
    expect(responseData(response).content).toMatch(/concluded your jtl round/i)
  })

  it("includes the origin guild's name in the concluded message's footer", async () => {
    const concludeActiveRound = stub(async (_organizerDiscordId: string) =>
      okResult({ originGuildName: 'Sister Community', targets: [{ channelId: 'channel-1', messageId: 'msg-1' }] })
    )
    const editMessage = stub(
      async (_channelId: string, _messageId: string, body: { embeds: Array<{ footer?: { text: string } }> }) => {
        expect(body.embeds[0].footer?.text).toContain('Sister Community')
        return {} as never
      }
    )
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ concludeActiveRound }),
      discordRest: createFakeDiscordRest({ editMessage }),
    }

    await concludePod(ctx)

    expect(editMessage.calls).toHaveLength(1)
  })

  it('resolves the organizer id from user.id when member is absent (DM-style interaction)', async () => {
    const concludeActiveRound = stub(async (_organizerDiscordId: string) =>
      ({ ok: false, error: { kind: 'not_found', message: "You don't have a pod round to conclude." } }) as const
    )
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: undefined, user: fakeUser({ id: 'organizer-2' }) }),
      backend: createFakeBackendClient({ concludeActiveRound }),
      discordRest: createFakeDiscordRest(),
    }

    await concludePod(ctx)

    expect(concludeActiveRound.calls).toEqual([['organizer-2']])
  })
})
