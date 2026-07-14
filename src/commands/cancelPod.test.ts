import { describe, expect, it } from 'vitest'
import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { cancelPod } from './cancelPod.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction, fakeMember, fakeUser } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'
import type { BackendClient } from '../backendClient.js'

function withRoundOption(value: number) {
  return fakeChatInputInteraction({
    member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
    options: [{ name: 'round', type: ApplicationCommandOptionType.Integer, value }],
  })
}

// Every test below goes through cancelPod's new ambiguity check, which
// calls backend.listActiveRounds whenever no `round` option was given —
// defaults to "no other active rounds" so existing single-round-flow
// tests don't all need to repeat this override.
function backend(overrides: Partial<BackendClient> = {}) {
  return createFakeBackendClient({ listActiveRounds: stub(async () => []), ...overrides })
}

describe('cancelPod', () => {
  it('rejects when neither member nor user is present', async () => {
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ guild_id: undefined, member: undefined }),
      backend: backend(),
      discordRest: createFakeDiscordRest(),
    }

    const response = await cancelPod(ctx)

    expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
  })

  it("tells the organizer there's nothing to cancel when they have no active round", async () => {
    const cancelActiveRound = stub(async (_organizerDiscordId: string) => null)
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: backend({ cancelActiveRound }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await cancelPod(ctx)

    expect(cancelActiveRound.calls).toEqual([['organizer-1', undefined]])
    expect(responseData(response).content).toMatch(/don't have an active pod round/i)
  })

  it('cancels the round and edits every target guild message with a messageId', async () => {
    const cancelActiveRound = stub(async (_organizerDiscordId: string) => ({
      podRoundId: 'round-1',
      setCode: 'JTL',
      organizerRoundNumber: 1,
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
      backend: backend({ cancelActiveRound }),
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
      organizerRoundNumber: 1,
      originGuildName: 'Sister Community',
      targets: [{ channelId: 'channel-1', messageId: 'msg-1' }],
    }))
    const editMessage = stub(async (_channelId: string, _messageId: string, body: { embeds: Array<{ footer?: { text: string } }> }) => {
      expect(body.embeds[0].footer?.text).toContain('Sister Community')
      return {} as never
    })
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: backend({ cancelActiveRound }),
      discordRest: createFakeDiscordRest({ editMessage }),
    }

    await cancelPod(ctx)

    expect(editMessage.calls).toHaveLength(1)
  })

  it('resolves the organizer id from user.id when member is absent (DM-style interaction)', async () => {
    const cancelActiveRound = stub(async (_organizerDiscordId: string) => null)
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: undefined, user: fakeUser({ id: 'organizer-2' }) }),
      backend: backend({ cancelActiveRound }),
      discordRest: createFakeDiscordRest(),
    }

    await cancelPod(ctx)

    expect(cancelActiveRound.calls).toEqual([['organizer-2', undefined]])
  })

  // GitHub issue #6 — an organizer with more than one active round can't
  // be resolved to a single one automatically; this asks them to specify
  // rather than guessing (and never touches any round while asking).
  it('asks the organizer to specify a round, and calls neither cancelActiveRound nor any edit, when 2+ candidates exist and round was omitted', async () => {
    const listActiveRounds = stub(async (_organizerDiscordId: string, _kind: 'cancellable' | 'concludable') => [
      { podRoundId: 'round-1', setCode: 'JTL', organizerRoundNumber: 1 },
      { podRoundId: 'round-3', setCode: 'SOR', organizerRoundNumber: 3 },
    ])
    const cancelActiveRound = stub(async (_organizerDiscordId: string) => {
      throw new Error('cancelActiveRound should not have been called while ambiguous')
    })
    const editMessage = stub(async (_channelId: string, _messageId: string, _body: unknown) => {
      throw new Error('editMessage should not have been called while ambiguous')
    })
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ listActiveRounds, cancelActiveRound }),
      discordRest: createFakeDiscordRest({ editMessage }),
    }

    const response = await cancelPod(ctx)

    expect(listActiveRounds.calls).toEqual([['organizer-1', 'cancellable']])
    expect(responseData(response).content).toMatch(/multiple active rounds/i)
    expect(responseData(response).content).toContain('JTL #1')
    expect(responseData(response).content).toContain('SOR #3')
  })

  it('proceeds without asking when round is omitted but only one candidate exists (unchanged single-round behavior)', async () => {
    const listActiveRounds = stub(async (_organizerDiscordId: string, _kind: 'cancellable' | 'concludable') => [
      { podRoundId: 'round-1', setCode: 'JTL', organizerRoundNumber: 1 },
    ])
    const cancelActiveRound = stub(async (_organizerDiscordId: string) => ({
      podRoundId: 'round-1',
      setCode: 'JTL',
      organizerRoundNumber: 1,
      originGuildName: null,
      targets: [],
    }))
    const ctx: CommandContext = {
      interaction: fakeChatInputInteraction({ member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }) }),
      backend: createFakeBackendClient({ listActiveRounds, cancelActiveRound }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await cancelPod(ctx)

    expect(cancelActiveRound.calls).toEqual([['organizer-1', undefined]])
    expect(responseData(response).content).toMatch(/cancelled your jtl round/i)
  })

  it('skips the ambiguity check and resolves the exact round directly when round is given', async () => {
    const listActiveRounds = stub(async (_organizerDiscordId: string, _kind: 'cancellable' | 'concludable') => {
      throw new Error('listActiveRounds should not have been called when round was given explicitly')
    })
    const cancelActiveRound = stub(async (_organizerDiscordId: string, _organizerRoundNumber?: number) => ({
      podRoundId: 'round-3',
      setCode: 'SOR',
      organizerRoundNumber: 3,
      originGuildName: null,
      targets: [],
    }))
    const ctx: CommandContext = {
      interaction: withRoundOption(3),
      backend: createFakeBackendClient({ listActiveRounds, cancelActiveRound }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await cancelPod(ctx)

    expect(cancelActiveRound.calls).toEqual([['organizer-1', 3]])
    expect(responseData(response).content).toMatch(/cancelled your sor round/i)
  })
})
