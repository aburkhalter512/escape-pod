import { describe, expect, it } from 'vitest'
import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { concludePod } from './concludePod.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction, fakeMember, fakeUser } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'
import type { ConcludeActiveRoundResult } from '../services/pods.js'
import type { Result } from '../services/errors.js'
import type { BackendClient } from '../backendClient.js'

// Every test below goes through concludePod's new ambiguity check, which
// calls backend.listActiveRounds whenever no `round` option was given —
// defaults to "no other active rounds" so existing single-round-flow
// tests don't all need to repeat this override.
function backend(overrides: Partial<BackendClient> = {}) {
  return createFakeBackendClient({ listActiveRounds: stub(async () => []), ...overrides })
}

function withRoundOption(value: number) {
  return fakeChatInputInteraction({
    member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
    options: [{ name: 'round', type: ApplicationCommandOptionType.Integer, value }],
  })
}

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
      backend: backend(),
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
      backend: backend({ concludeActiveRound }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await concludePod(ctx)

    expect(concludeActiveRound.calls).toEqual([['organizer-1', undefined]])
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
      backend: backend({ concludeActiveRound }),
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
      backend: backend({ concludeActiveRound }),
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
      backend: backend({ concludeActiveRound }),
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
      backend: backend({ concludeActiveRound }),
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
      backend: backend({ concludeActiveRound }),
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
      backend: backend({ concludeActiveRound }),
      discordRest: createFakeDiscordRest(),
    }

    await concludePod(ctx)

    expect(concludeActiveRound.calls).toEqual([['organizer-2', undefined]])
  })

  // GitHub issue #6 — an organizer with more than one concludable round
  // can't be resolved to a single one automatically; this asks them to
  // specify rather than guessing (and never touches any round while asking).
  it('asks the organizer to specify a round, and calls neither concludeActiveRound nor any edit, when 2+ candidates exist and round was omitted', async () => {
    const listActiveRounds = stub(async (_organizerDiscordId: string, _kind: 'cancellable' | 'concludable') => [
      { podRoundId: 'round-1', setCode: 'JTL', organizerRoundNumber: 1 },
      { podRoundId: 'round-3', setCode: 'SOR', organizerRoundNumber: 3 },
    ])
    const concludeActiveRound = stub(async (_organizerDiscordId: string) => {
      throw new Error('concludeActiveRound should not have been called while ambiguous')
    })
    const editMessage = stub(async (_channelId: string, _messageId: string, _body: unknown) => {
      throw new Error('editMessage should not have been called while ambiguous')
    })
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ listActiveRounds, concludeActiveRound }),
      discordRest: createFakeDiscordRest({ editMessage }),
    }

    const response = await concludePod(ctx)

    expect(listActiveRounds.calls).toEqual([['organizer-1', 'concludable']])
    expect(responseData(response).content).toMatch(/multiple rounds ready to conclude/i)
    expect(responseData(response).content).toContain('JTL #1')
    expect(responseData(response).content).toContain('SOR #3')
  })

  it('proceeds without asking when round is omitted but only one candidate exists (unchanged single-round behavior)', async () => {
    const listActiveRounds = stub(async (_organizerDiscordId: string, _kind: 'cancellable' | 'concludable') => [
      { podRoundId: 'round-1', setCode: 'JTL', organizerRoundNumber: 1 },
    ])
    const concludeActiveRound = stub(async (_organizerDiscordId: string) => okResult())
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ listActiveRounds, concludeActiveRound }),
      discordRest: createFakeDiscordRest({ editMessage: stub(async () => ({}) as never) }),
    }

    const response = await concludePod(ctx)

    expect(concludeActiveRound.calls).toEqual([['organizer-1', undefined]])
    expect(responseData(response).content).toMatch(/concluded your jtl round/i)
  })

  it('skips the ambiguity check and resolves the exact round directly when round is given', async () => {
    const listActiveRounds = stub(async (_organizerDiscordId: string, _kind: 'cancellable' | 'concludable') => {
      throw new Error('listActiveRounds should not have been called when round was given explicitly')
    })
    const concludeActiveRound = stub(async (_organizerDiscordId: string, _organizerRoundNumber?: number) =>
      okResult({ podRoundId: 'round-3', setCode: 'SOR', organizerRoundNumber: 3 })
    )
    const ctx: CommandContext = {
      interaction: withRoundOption(3),
      backend: createFakeBackendClient({ listActiveRounds, concludeActiveRound }),
      discordRest: createFakeDiscordRest({ editMessage: stub(async () => ({}) as never) }),
    }

    const response = await concludePod(ctx)

    expect(concludeActiveRound.calls).toEqual([['organizer-1', 3]])
    expect(responseData(response).content).toMatch(/concluded your sor round/i)
  })
})
