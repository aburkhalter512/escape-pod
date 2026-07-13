import { describe, expect, it } from 'vitest'
import {
  ComponentType,
  InteractionResponseType,
  TextInputStyle,
  type APIInteractionGuildMember,
  type RESTPatchAPIChannelMessageJSONBody,
  type RESTPatchAPIChannelMessageResult,
  type RESTPostAPIChannelMessageJSONBody,
  type RESTPostAPIChannelMessageResult,
} from 'discord-api-types/v10'
import { extractTextInputValue, handleMessageComponent, handleModalSubmit } from './components.js'
import type { SignupAction } from '../backendClient.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeMember, fakeMessageComponentInteraction, fakeModalSubmitInteraction, fakeUser } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'
import { deepEqual } from '../testUtils/deepEqual.js'
import { createInMemoryPendingStartPodStore, type PendingStartPod, type PendingStartPodStore } from '../pendingStartPods.js'

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.sig`
}

const FUTURE_EXP = () => Math.floor(Date.now() / 1000) + 3600
const PAST_EXP = () => Math.floor(Date.now() / 1000) - 3600

// Discord's own type guarantees member.user is always present — this
// simulates the malformed payload that guarantee rules out, to prove the
// `?.` in components.ts's pod-signup: branch actually degrades gracefully
// instead of throwing a TypeError (tasks/004).
function memberWithoutUser(): APIInteractionGuildMember {
  return { ...fakeMember(), user: undefined } as unknown as APIInteractionGuildMember
}

// Origin guild name lookup (interactions.ts's start-pod:select-guilds:
// handler) — same shape as commands/startPod.test.ts's fakeGetGuild, keyed
// by guildId->name so tests describe only the guild(s) they care about.
function fakeGetGuild(names: Record<string, string>) {
  return stub(async (guildId: string) => {
    const name = names[guildId]
    if (name === undefined) throw new Error(`unexpected getGuild call: ${guildId}`)
    return { id: guildId, name } as never
  })
}

describe('extractTextInputValue', () => {
  it('finds a match inside a legacy ActionRow', () => {
    const components = [
      {
        type: ComponentType.ActionRow as const,
        components: [{ type: ComponentType.TextInput as const, custom_id: 'ptp-token', value: 'abc' }],
      },
    ]
    expect(extractTextInputValue(components, 'ptp-token')).toBe('abc')
  })

  it('finds a match inside a Label-wrapped component (Components v2)', () => {
    const components = [
      {
        type: ComponentType.Label as const,
        component: { type: ComponentType.TextInput as const, custom_id: 'ptp-token', value: 'xyz' },
      },
    ]
    expect(extractTextInputValue(components, 'ptp-token')).toBe('xyz')
  })

  it('skips a Label wrapping a non-TextInput component without throwing', () => {
    const components = [
      {
        type: ComponentType.Label as const,
        component: { type: ComponentType.StringSelect as const, custom_id: 'ptp-token', values: ['a'] },
      },
    ]
    expect(extractTextInputValue(components, 'ptp-token')).toBeUndefined()
  })

  it('skips TextDisplay components (no value to extract)', () => {
    const components = [{ type: ComponentType.TextDisplay as const }]
    expect(extractTextInputValue(components, 'ptp-token')).toBeUndefined()
  })

  it('returns undefined when the custom_id is not present anywhere', () => {
    const components = [
      {
        type: ComponentType.ActionRow as const,
        components: [{ type: ComponentType.TextInput as const, custom_id: 'something-else', value: 'abc' }],
      },
    ]
    expect(extractTextInputValue(components, 'ptp-token')).toBeUndefined()
  })

  it('returns undefined for an empty components array', () => {
    expect(extractTextInputValue([], 'ptp-token')).toBeUndefined()
  })
})

describe('handleMessageComponent', () => {
  it('opens the connect-ptp modal on the paste-token button', async () => {
    const interaction = fakeMessageComponentInteraction({
      data: { custom_id: 'connect-ptp:open-modal', component_type: ComponentType.Button },
    })
    const response = await handleMessageComponent(
      interaction,
      createFakeBackendClient(),
      createFakeDiscordRest(),
      createInMemoryPendingStartPodStore()
    )

    expect(response.type).toBe(InteractionResponseType.Modal)
    expect(responseData(response).custom_id).toBe('connect-ptp:submit')
  })

  describe('start-pod:select-guilds:', () => {
    function interaction(overrides: { values?: string[]; member?: APIInteractionGuildMember } = {}) {
      return fakeMessageComponentInteraction({
        data: {
          custom_id: 'start-pod:select-guilds:JTL:8',
          component_type: ComponentType.StringSelect,
          values: overrides.values ?? ['g1', 'g2'],
        },
        member: 'member' in overrides ? overrides.member : fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
      })
    }

    function buttonsOf(response: Awaited<ReturnType<typeof handleMessageComponent>>) {
      const row = responseData(response).components?.[0] as { components: Array<{ label: string; custom_id: string }> }
      return row.components
    }

    it('shows a summary of the selected servers (by name) with Send/Cancel buttons, without posting or creating anything yet', async () => {
      const startPodMock = stub(async (_params: unknown) => {
        throw new Error('startPod should not have been called before Send is pressed')
      })
      const postMessage = stub(async (_channelId: string, _body: RESTPostAPIChannelMessageJSONBody) => {
        throw new Error('postMessage should not have been called before Send is pressed')
      })
      const pendingStartPods = createInMemoryPendingStartPodStore()

      const response = await handleMessageComponent(
        interaction(),
        createFakeBackendClient({ startPod: startPodMock }),
        createFakeDiscordRest({ postMessage, getGuild: fakeGetGuild({ g1: 'Alpha', g2: 'Beta' }) }),
        pendingStartPods
      )

      expect(response.type).toBe(InteractionResponseType.UpdateMessage)
      expect(responseData(response).content).toContain('Alpha')
      expect(responseData(response).content).toContain('Beta')
      const buttons = buttonsOf(response)
      expect(buttons.map((b) => b.label)).toEqual(['Send', 'Cancel'])
      expect(buttons[0].custom_id).toMatch(/^start-pod:confirm:/)
      expect(buttons[1].custom_id).toMatch(/^start-pod:cancel:/)
    })

    it('stores the pending selection (including the resolved origin guild name) keyed by the Send button token', async () => {
      const pendingStartPods = createInMemoryPendingStartPodStore()

      const response = await handleMessageComponent(
        interaction(),
        createFakeBackendClient(),
        createFakeDiscordRest({ getGuild: fakeGetGuild({ 'guild-1': 'Origin Guild', g1: 'Alpha', g2: 'Beta' }) }),
        pendingStartPods
      )

      const sendToken = buttonsOf(response)[0].custom_id.replace('start-pod:confirm:', '')
      expect(pendingStartPods.get(sendToken)).toEqual({
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        scheduledFor: undefined,
        originGuildName: 'Origin Guild',
        originGuildId: 'guild-1',
        guildIds: ['g1', 'g2'],
      })
    })

    it('falls back to the raw guildId in the summary when a name lookup fails', async () => {
      const getGuild = stub(async (guildId: string) => {
        if (guildId === 'g2') throw new Error('bot is no longer in this guild')
        return { id: guildId, name: 'Alpha' } as never
      })

      const response = await handleMessageComponent(
        interaction(),
        createFakeBackendClient(),
        createFakeDiscordRest({ getGuild }),
        createInMemoryPendingStartPodStore()
      )

      expect(responseData(response).content).toContain('Alpha')
      expect(responseData(response).content).toContain('g2')
    })

    it('includes the deadline note in the summary text when a deadline was set', async () => {
      const deadlineEpoch = Math.floor(Date.now() / 1000) + 7200
      const deadlineInteraction = fakeMessageComponentInteraction({
        data: {
          custom_id: `start-pod:select-guilds:JTL:8:${deadlineEpoch}`,
          component_type: ComponentType.StringSelect,
          values: ['g1'],
        },
        member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
      })

      const response = await handleMessageComponent(
        deadlineInteraction,
        createFakeBackendClient(),
        createFakeDiscordRest({ getGuild: fakeGetGuild({ g1: 'Alpha' }) }),
        createInMemoryPendingStartPodStore()
      )

      expect(responseData(response).content).toContain(`<t:${deadlineEpoch}:R>`)
    })

    it('rejects a guild-select submission when the organizer id cannot be determined', async () => {
      const startPodMock = stub(async (_params: unknown) => {
        throw new Error('startPod should not have been called')
      })

      const response = await handleMessageComponent(
        interaction({ member: undefined }),
        createFakeBackendClient({ startPod: startPodMock }),
        createFakeDiscordRest(),
        createInMemoryPendingStartPodStore()
      )

      expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
    })
  })

  describe('start-pod:confirm:', () => {
    function seedPending(store: PendingStartPodStore, overrides: Partial<PendingStartPod> = {}): string {
      return store.create({
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        guildIds: ['g1', 'g2'],
        ...overrides,
      })
    }

    function confirmInteraction(token: string) {
      return fakeMessageComponentInteraction({
        data: { custom_id: `start-pod:confirm:${token}`, component_type: ComponentType.Button },
        member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
      })
    }

    it('starts the round, posts the RSVP message to every target, and records each message id', async () => {
      const pendingStartPods = createInMemoryPendingStartPodStore()
      const token = seedPending(pendingStartPods, { originGuildName: 'Origin Guild', originGuildId: 'guild-1' })

      const startPodMock = stub(
        async (params: {
          organizerDiscordId: string
          setCode: string
          threshold: number
          guildIds: string[]
          scheduledFor?: Date
          originGuildName?: string
          originGuildId?: string
        }) => {
        const expected = {
          organizerDiscordId: 'organizer-1',
          setCode: 'JTL',
          threshold: 8,
          guildIds: ['g1', 'g2'],
          scheduledFor: undefined,
          originGuildName: 'Origin Guild',
          originGuildId: 'guild-1',
        }
        if (!deepEqual(params, expected)) throw new Error(`unexpected startPod args: ${JSON.stringify(params)}`)
        return {
          podRoundId: 'round-1',
          targets: [
            { guildId: 'g1', channelId: 'channel-1' },
            { guildId: 'g2', channelId: 'channel-2' },
          ],
        }
      })
      const recordMessagePostedMock = stub(async (podRoundId: string, guildId: string, messageId: string) => {
        const valid =
          (guildId === 'g1' && podRoundId === 'round-1' && messageId === 'msg-1') ||
          (guildId === 'g2' && podRoundId === 'round-1' && messageId === 'msg-2')
        if (!valid) throw new Error(`unexpected recordMessagePosted args: ${podRoundId} ${guildId} ${messageId}`)
        return { ok: true as const, value: undefined }
      })
      const postMessage = stub(async (channelId: string, _body: RESTPostAPIChannelMessageJSONBody) => {
        if (channelId === 'channel-1') return { id: 'msg-1' } as RESTPostAPIChannelMessageResult
        if (channelId === 'channel-2') return { id: 'msg-2' } as RESTPostAPIChannelMessageResult
        throw new Error(`unexpected postMessage channelId: ${channelId}`)
      })

      const response = await handleMessageComponent(
        confirmInteraction(token),
        createFakeBackendClient({ startPod: startPodMock, recordMessagePosted: recordMessagePostedMock }),
        createFakeDiscordRest({ postMessage }),
        pendingStartPods
      )

      expect(postMessage.calls).toHaveLength(2)
      expect(recordMessagePostedMock.calls).toHaveLength(2)
      expect(responseData(response).content).toContain('2 server(s)')
      expect(responseData(response).content).not.toMatch(/failed to post/i)
    })

    it("includes the origin guild's name in the posted message's footer", async () => {
      const pendingStartPods = createInMemoryPendingStartPodStore()
      const token = seedPending(pendingStartPods, { originGuildName: 'Origin Guild', guildIds: ['g1'] })
      const startPodMock = stub(async (_params: unknown) => ({
        podRoundId: 'round-1',
        targets: [{ guildId: 'g1', channelId: 'channel-1' }],
      }))
      const postMessage = stub(async (_channelId: string, body: RESTPostAPIChannelMessageJSONBody) => {
        const embeds = body.embeds as Array<{ footer?: { text: string } }>
        expect(embeds[0].footer?.text).toContain('Origin Guild')
        return { id: 'msg-1' } as RESTPostAPIChannelMessageResult
      })

      await handleMessageComponent(
        confirmInteraction(token),
        createFakeBackendClient({ startPod: startPodMock, recordMessagePosted: stub(async () => ({ ok: true as const, value: undefined })) }),
        createFakeDiscordRest({ postMessage }),
        pendingStartPods
      )

      expect(postMessage.calls).toHaveLength(1)
    })

    it("posts an initial embed showing 0 signups with I'm in / Leave buttons, not the count directly", async () => {
      const pendingStartPods = createInMemoryPendingStartPodStore()
      const token = seedPending(pendingStartPods, { guildIds: ['g1'] })
      const startPodMock = stub(async (_params: unknown) => ({
        podRoundId: 'round-1',
        targets: [{ guildId: 'g1', channelId: 'channel-1' }],
      }))
      const postMessage = stub(
        async (_channelId: string, _body: RESTPostAPIChannelMessageJSONBody) => ({ id: 'msg-1' }) as RESTPostAPIChannelMessageResult
      )

      await handleMessageComponent(
        confirmInteraction(token),
        createFakeBackendClient({ startPod: startPodMock, recordMessagePosted: stub(async () => ({ ok: true as const, value: undefined })) }),
        createFakeDiscordRest({ postMessage }),
        pendingStartPods
      )

      const [, postBody] = postMessage.calls[0]
      const embeds = postBody.embeds as Array<{ description: string }>
      expect(embeds[0].description).toContain('0/8 confirmed')
      const components = postBody.components as Array<{ components: Array<{ custom_id: string }> }>
      const buttonCustomIds = components[0].components.map((c) => c.custom_id)
      expect(buttonCustomIds).toEqual(['pod-signup:round-1:in', 'pod-signup:round-1:leave'])
    })

    it('reports a partial-failure count when one target fails to post, without dropping the others', async () => {
      const pendingStartPods = createInMemoryPendingStartPodStore()
      const token = seedPending(pendingStartPods)
      const startPodMock = stub(async (_params: unknown) => ({
        podRoundId: 'round-1',
        targets: [
          { guildId: 'g1', channelId: 'channel-1' },
          { guildId: 'g2', channelId: 'channel-2' },
        ],
      }))
      const recordMessagePostedMock = stub(async (_podRoundId: string, _guildId: string, _messageId: string) => ({ ok: true as const, value: undefined }))
      const postMessage = stub(async (channelId: string, _body: RESTPostAPIChannelMessageJSONBody) => {
        if (channelId === 'channel-1') return { id: 'msg-1' } as RESTPostAPIChannelMessageResult
        throw new Error('Missing Access')
      })

      const response = await handleMessageComponent(
        confirmInteraction(token),
        createFakeBackendClient({ startPod: startPodMock, recordMessagePosted: recordMessagePostedMock }),
        createFakeDiscordRest({ postMessage }),
        pendingStartPods
      )

      // The failing guild never got recordMessagePosted called for it, but
      // the successful one still did — one bad guild shouldn't roll back
      // the rest (Promise.allSettled, not Promise.all).
      expect(recordMessagePostedMock.calls).toHaveLength(1)
      expect(recordMessagePostedMock.calls[0]).toEqual(['round-1', 'g1', 'msg-1'])
      expect(responseData(response).content).toMatch(/1 server\(s\) failed to post/i)
    })

    it('threads a seeded deadline through to startPod and the posted message', async () => {
      const scheduledFor = new Date(Date.now() + 2 * 60 * 60_000)
      const pendingStartPods = createInMemoryPendingStartPodStore()
      const token = seedPending(pendingStartPods, { guildIds: ['g1'], scheduledFor })
      const startPodMock = stub(async (params: { scheduledFor?: Date }) => {
        expect(params.scheduledFor).toEqual(scheduledFor)
        return { podRoundId: 'round-1', targets: [{ guildId: 'g1', channelId: 'channel-1' }] }
      })
      const postMessage = stub(async (_channelId: string, body: RESTPostAPIChannelMessageJSONBody) => {
        const embeds = body.embeds as Array<{ description: string }>
        expect(embeds[0].description).toContain(`<t:${Math.floor(scheduledFor.getTime() / 1000)}:R>`)
        return { id: 'msg-1' } as RESTPostAPIChannelMessageResult
      })

      await handleMessageComponent(
        confirmInteraction(token),
        createFakeBackendClient({ startPod: startPodMock, recordMessagePosted: stub(async () => ({ ok: true as const, value: undefined })) }),
        createFakeDiscordRest({ postMessage }),
        pendingStartPods
      )

      expect(postMessage.calls).toHaveLength(1)
    })

    it('shows an expired message (does not create or post anything) for an unknown/already-used token', async () => {
      const startPodMock = stub(async (_params: unknown) => {
        throw new Error('startPod should not have been called for an expired token')
      })

      const response = await handleMessageComponent(
        confirmInteraction('never-seeded-token'),
        createFakeBackendClient({ startPod: startPodMock }),
        createFakeDiscordRest(),
        createInMemoryPendingStartPodStore()
      )

      expect(responseData(response).content).toMatch(/expired/i)
    })

    it('deletes the pending entry once confirmed, so the same token cannot be confirmed twice', async () => {
      const pendingStartPods = createInMemoryPendingStartPodStore()
      const token = seedPending(pendingStartPods, { guildIds: ['g1'] })
      const startPodMock = stub(async (_params: unknown) => ({
        podRoundId: 'round-1',
        targets: [{ guildId: 'g1', channelId: 'channel-1' }],
      }))
      const backend = createFakeBackendClient({
        startPod: startPodMock,
        recordMessagePosted: stub(async () => ({ ok: true as const, value: undefined })),
      })
      const discordRest = createFakeDiscordRest({
        postMessage: stub(async () => ({ id: 'msg-1' }) as RESTPostAPIChannelMessageResult),
      })

      await handleMessageComponent(confirmInteraction(token), backend, discordRest, pendingStartPods)
      const secondResponse = await handleMessageComponent(confirmInteraction(token), backend, discordRest, pendingStartPods)

      expect(responseData(secondResponse).content).toMatch(/expired/i)
      expect(startPodMock.calls).toHaveLength(1)
    })
  })

  describe('start-pod:cancel:', () => {
    it('deletes the pending entry and replies with a simple cancelled message, without creating or posting anything', async () => {
      const pendingStartPods = createInMemoryPendingStartPodStore()
      const token = pendingStartPods.create({
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        guildIds: ['g1'],
      })
      const startPodMock = stub(async (_params: unknown) => {
        throw new Error('startPod should not have been called on cancel')
      })
      const interaction = fakeMessageComponentInteraction({
        data: { custom_id: `start-pod:cancel:${token}`, component_type: ComponentType.Button },
      })

      const response = await handleMessageComponent(
        interaction,
        createFakeBackendClient({ startPod: startPodMock }),
        createFakeDiscordRest(),
        pendingStartPods
      )

      expect(responseData(response).content).toMatch(/cancelled/i)
      expect(pendingStartPods.get(token)).toBeUndefined()
    })

    it('is a no-op (still replies) for an unknown token', async () => {
      const interaction = fakeMessageComponentInteraction({
        data: { custom_id: 'start-pod:cancel:never-seeded-token', component_type: ComponentType.Button },
      })

      const response = await handleMessageComponent(
        interaction,
        createFakeBackendClient(),
        createFakeDiscordRest(),
        createInMemoryPendingStartPodStore()
      )

      expect(responseData(response).content).toMatch(/cancelled/i)
    })
  })

  describe('pod-signup:', () => {
    function interaction(overrides: { member?: APIInteractionGuildMember; customId?: string } = {}) {
      return fakeMessageComponentInteraction({
        data: { custom_id: overrides.customId ?? 'pod-signup:round-1:in', component_type: ComponentType.Button },
        guild_id: 'guild-1',
        member: 'member' in overrides ? overrides.member : fakeMember({ user: fakeUser({ id: 'player-1', username: 'PlayerOne' }) }),
      })
    }

    // Builds the ok() Result recordSignup now returns, not the bare value —
    // every call site here only ever uses this as a recordSignupMock return.
    function signupResult(overrides: Record<string, unknown> = {}) {
      return {
        ok: true as const,
        value: {
          count: 5,
          threshold: 8,
          setCode: 'JTL',
          full: false,
          podCreated: false,
          originGuildName: null,
          scheduledFor: null,
          targets: [
            { guildId: 'guild-1', channelId: 'channel-1', messageId: 'msg-1' },
            { guildId: 'guild-2', channelId: 'channel-2', messageId: 'msg-2' },
          ],
          ...overrides,
        },
      }
    }

    it('records the signup and returns an UpdateMessage with the new embed', async () => {
      const recordSignupMock = stub(async (podRoundId: string, discordId: string, username: string, sourceGuildId: string, action: SignupAction) => {
        const valid =
          podRoundId === 'round-1' && discordId === 'player-1' && username === 'PlayerOne' && sourceGuildId === 'guild-1' && action === 'in'
        if (!valid) throw new Error(`unexpected recordSignup args: ${podRoundId} ${discordId} ${username} ${sourceGuildId} ${action}`)
        return signupResult()
      })

      const response = await handleMessageComponent(
        interaction(),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        // signupResult()'s default targets include guild-2, which triggers a
        // cross-guild edit fan-out (§7.5 step 3) irrelevant to this test.
        createFakeDiscordRest({
          editMessage: stub(async (_channelId: string, _messageId: string, _body: RESTPatchAPIChannelMessageJSONBody) => ({}) as RESTPatchAPIChannelMessageResult),
        }),
        createInMemoryPendingStartPodStore()
      )

      expect(response.type).toBe(InteractionResponseType.UpdateMessage)
      expect(responseData(response).content).toBeUndefined() // embeds/components now, not plain content
      expect(responseData(response).components?.[0]).toBeDefined()
    })

    it('still shows the deadline note after a signup click, not just on the initial post (regression guard)', async () => {
      const scheduledFor = new Date(Date.now() + 2 * 60 * 60_000)
      const recordSignupMock = stub(async () => signupResult({ scheduledFor }))

      const response = await handleMessageComponent(
        interaction(),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        // signupResult()'s default targets include guild-2, which triggers a
        // cross-guild edit fan-out (§7.5 step 3) irrelevant to this test.
        createFakeDiscordRest({
          editMessage: stub(async (_channelId: string, _messageId: string, _body: RESTPatchAPIChannelMessageJSONBody) => ({}) as RESTPatchAPIChannelMessageResult),
        }),
        createInMemoryPendingStartPodStore()
      )

      const embeds = (response as { data?: { embeds?: Array<{ description?: string }> } }).data?.embeds
      expect(embeds?.[0].description).toContain('Fires automatically')
      expect(embeds?.[0].description).toContain(`<t:${Math.floor(scheduledFor.getTime() / 1000)}:R>`)
    })

    it('passes action: leave through to the backend when the Leave button is clicked (tasks/002)', async () => {
      const recordSignupMock = stub(async (podRoundId: string, discordId: string, username: string, sourceGuildId: string, action: SignupAction) => {
        const valid =
          podRoundId === 'round-1' && discordId === 'player-1' && username === 'PlayerOne' && sourceGuildId === 'guild-1' && action === 'leave'
        if (!valid) throw new Error(`unexpected recordSignup args: ${podRoundId} ${discordId} ${username} ${sourceGuildId} ${action}`)
        return signupResult({ count: 4 })
      })

      const response = await handleMessageComponent(
        interaction({ customId: 'pod-signup:round-1:leave' }),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        createFakeDiscordRest({
          editMessage: stub(async (_channelId: string, _messageId: string, _body: RESTPatchAPIChannelMessageJSONBody) => ({}) as RESTPatchAPIChannelMessageResult),
        }),
        createInMemoryPendingStartPodStore()
      )

      expect(recordSignupMock.calls).toHaveLength(1)
      expect(response.type).toBe(InteractionResponseType.UpdateMessage)
    })

    it("edits every OTHER target guild's message, but not the one the click came from", async () => {
      const recordSignupMock = stub(async (_podRoundId: string, _discordId: string, _username: string, _sourceGuildId: string) =>
        signupResult()
      )
      const editMessage = stub(async (channelId: string, messageId: string, _body: RESTPatchAPIChannelMessageJSONBody) => {
        if (channelId !== 'channel-2' || messageId !== 'msg-2') {
          throw new Error(`unexpected editMessage args: ${channelId} ${messageId}`)
        }
        return { id: messageId } as RESTPatchAPIChannelMessageResult
      })

      await handleMessageComponent(
        interaction(), // guild_id: 'guild-1'
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        createFakeDiscordRest({ editMessage }),
        createInMemoryPendingStartPodStore()
      )

      // Only guild-2's message should be REST-edited — guild-1's is handled
      // by the UpdateMessage interaction response itself (§7.5 step 3).
      expect(editMessage.calls).toHaveLength(1)
    })

    it('skips targets with no recorded messageId yet', async () => {
      const recordSignupMock = stub(async (_podRoundId: string, _discordId: string, _username: string, _sourceGuildId: string) =>
        signupResult({
          targets: [
            { guildId: 'guild-1', channelId: 'channel-1', messageId: 'msg-1' },
            { guildId: 'guild-2', channelId: 'channel-2', messageId: null },
          ],
        })
      )
      const editMessage = stub(async (_channelId: string, _messageId: string, _body: RESTPatchAPIChannelMessageJSONBody) => {
        throw new Error('editMessage should not have been called')
      })

      await handleMessageComponent(
        interaction(),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        createFakeDiscordRest({ editMessage }),
        createInMemoryPendingStartPodStore()
      )
    })

    it('one guild\'s edit failing does not throw or block the interaction response', async () => {
      const recordSignupMock = stub(async (_podRoundId: string, _discordId: string, _username: string, _sourceGuildId: string) =>
        signupResult()
      )
      const editMessage = stub(async (_channelId: string, _messageId: string, _body: RESTPatchAPIChannelMessageJSONBody) => {
        throw new Error('Unknown Message')
      })

      const response = await handleMessageComponent(
        interaction(),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        createFakeDiscordRest({ editMessage }),
        createInMemoryPendingStartPodStore()
      )

      expect(response.type).toBe(InteractionResponseType.UpdateMessage)
    })

    it('shows the pod-full embed with a join link once threshold is reached and the pod is created', async () => {
      const recordSignupMock = stub(async (_podRoundId: string, _discordId: string, _username: string, _sourceGuildId: string) =>
        signupResult({
          count: 8,
          full: true,
          podCreated: true,
          shareUrl: 'https://www.protectthepod.com/draft/share-1',
        })
      )

      const response = await handleMessageComponent(
        interaction(),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        // signupResult()'s default targets include guild-2, which triggers a
        // cross-guild edit fan-out (§7.5 step 3) irrelevant to this test.
        createFakeDiscordRest({
          editMessage: stub(async (_channelId: string, _messageId: string, _body: RESTPatchAPIChannelMessageJSONBody) => ({}) as RESTPatchAPIChannelMessageResult),
        }),
        createInMemoryPendingStartPodStore()
      )

      const data = responseData(response)
      const buttons = (data.components?.[0] as { components: unknown[] }).components
      expect(buttons).toEqual([expect.objectContaining({ url: 'https://www.protectthepod.com/draft/share-1' })])
      // §7.5 step 4: no more "I'm in"/"Leave" buttons once the pod is full.
      expect((buttons[0] as { custom_id?: string }).custom_id).toBeUndefined()
    })

    it('also shows a "Join the chat" button when the backend result carries a chatUrl (a chat space was created)', async () => {
      const recordSignupMock = stub(async () =>
        signupResult({
          count: 8,
          full: true,
          podCreated: true,
          shareUrl: 'https://www.protectthepod.com/draft/share-1',
          chatUrl: 'https://discord.com/invite/abc123',
          signupDiscordIds: [],
        })
      )

      const response = await handleMessageComponent(
        interaction(),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        createFakeDiscordRest({
          editMessage: stub(async () => ({}) as RESTPatchAPIChannelMessageResult),
        }),
        createInMemoryPendingStartPodStore()
      )

      const data = responseData(response)
      const buttons = (data.components?.[0] as { components: unknown[] }).components
      expect(buttons).toEqual([
        expect.objectContaining({ url: 'https://www.protectthepod.com/draft/share-1' }),
        expect.objectContaining({ url: 'https://discord.com/invite/abc123' }),
      ])
    })

    it('DMs every signed-up player (as a supplement, not a replacement) once the pod fires', async () => {
      const recordSignupMock = stub(async () =>
        signupResult({
          count: 8,
          full: true,
          podCreated: true,
          shareUrl: 'https://www.protectthepod.com/draft/share-1',
          signupDiscordIds: ['player-1', 'player-2'],
        })
      )
      const dmChannelIds: Record<string, string> = { 'player-1': 'dm-channel-1', 'player-2': 'dm-channel-2' }
      const createDmChannel = stub(async (userId: string) => ({ id: dmChannelIds[userId] }) as never)
      const postMessage = stub(async (_channelId: string, _body: RESTPostAPIChannelMessageJSONBody) => ({}) as RESTPostAPIChannelMessageResult)

      await handleMessageComponent(
        interaction(),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        createFakeDiscordRest({
          editMessage: stub(async () => ({}) as RESTPatchAPIChannelMessageResult),
          createDmChannel,
          postMessage,
        }),
        createInMemoryPendingStartPodStore()
      )

      expect(createDmChannel.calls.map((c) => c[0]).sort()).toEqual(['player-1', 'player-2'])
      expect(postMessage.calls.map((c) => c[0]).sort()).toEqual(['dm-channel-1', 'dm-channel-2'])
    })

    it('does not attempt to DM anyone while the round is still just collecting (podCreated: false)', async () => {
      const recordSignupMock = stub(async () => signupResult({ podCreated: false }))
      const createDmChannel = stub(async () => {
        throw new Error('createDmChannel should not have been called')
      })

      await handleMessageComponent(
        interaction(),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        createFakeDiscordRest({
          editMessage: stub(async () => ({}) as RESTPatchAPIChannelMessageResult),
          createDmChannel,
        }),
        createInMemoryPendingStartPodStore()
      )

      expect(createDmChannel.calls).toHaveLength(0)
    })

    it('rejects a signup click when the Discord identity cannot be determined', async () => {
      const recordSignupMock = stub(async (_podRoundId: string, _discordId: string, _username: string, _sourceGuildId: string) => {
        throw new Error('recordSignup should not have been called')
      })

      const response = await handleMessageComponent(
        interaction({ member: undefined }),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        createFakeDiscordRest(),
        createInMemoryPendingStartPodStore()
      )

      expect(responseData(response).content).toMatch(/could not determine your discord identity/i)
    })

    it('degrades to the same response (not a thrown error) when member is present but member.user is missing', async () => {
      const recordSignupMock = stub(async (_podRoundId: string, _discordId: string, _username: string, _sourceGuildId: string) => {
        throw new Error('recordSignup should not have been called')
      })

      const response = await handleMessageComponent(
        interaction({ member: memberWithoutUser() }),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        createFakeDiscordRest(),
        createInMemoryPendingStartPodStore()
      )

      expect(responseData(response).content).toMatch(/could not determine your discord identity/i)
    })
  })

  it('falls back to a generic message for an unrecognized custom_id', async () => {
    const interaction = fakeMessageComponentInteraction({
      data: { custom_id: 'something-unexpected', component_type: ComponentType.Button },
    })
    const response = await handleMessageComponent(
      interaction,
      createFakeBackendClient(),
      createFakeDiscordRest(),
      createInMemoryPendingStartPodStore()
    )
    expect(responseData(response).content).toMatch(/unrecognized interaction/i)
  })
})

describe('handleModalSubmit', () => {
  function actionRowWithToken(value: string) {
    return [
      {
        type: ComponentType.ActionRow as const,
        components: [
          {
            type: ComponentType.TextInput as const,
            custom_id: 'ptp-token',
            style: TextInputStyle.Short,
            value,
          },
        ],
      },
    ]
  }

  it('links the organizer on a valid, matching, unexpired token', async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: FUTURE_EXP() })
    const linkOrganizerMock = stub(async (discordId: string, t: string) => {
      if (discordId !== 'user-1' || t !== token) throw new Error(`unexpected linkOrganizer args: ${discordId} ${t}`)
      return { ok: true as const, value: { username: 'PlayerOne' } }
    })
    const interaction = fakeModalSubmitInteraction({
      customId: 'connect-ptp:submit',
      components: actionRowWithToken(token),
    })

    const response = await handleModalSubmit(interaction, createFakeBackendClient({ linkOrganizer: linkOrganizerMock }))

    expect(responseData(response).content).toContain('Linked as **PlayerOne**')
  })

  it('ignores modals with an unrelated custom_id', async () => {
    const interaction = fakeModalSubmitInteraction({ customId: 'some-other-modal', components: [] })
    const response = await handleModalSubmit(interaction, createFakeBackendClient())
    expect(responseData(response).content).toMatch(/unrecognized modal/i)
  })

  it('rejects when the Discord user id cannot be determined', async () => {
    const interaction = fakeModalSubmitInteraction({ customId: 'connect-ptp:submit', components: [], member: undefined })
    const response = await handleModalSubmit(interaction, createFakeBackendClient())
    expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
  })

  it('rejects when no token was submitted in the modal', async () => {
    const interaction = fakeModalSubmitInteraction({
      customId: 'connect-ptp:submit',
      components: actionRowWithToken(''),
    })
    const response = await handleModalSubmit(interaction, createFakeBackendClient())
    expect(responseData(response).content).toMatch(/no token was submitted/i)
  })

  it('rejects a structurally malformed token before calling the backend', async () => {
    const linkOrganizerMock = stub(async (_discordId: string, _t: string) => {
      throw new Error('linkOrganizer should not have been called')
    })
    const interaction = fakeModalSubmitInteraction({
      customId: 'connect-ptp:submit',
      components: actionRowWithToken('not-a-jwt'),
    })

    const response = await handleModalSubmit(interaction, createFakeBackendClient({ linkOrganizer: linkOrganizerMock }))

    expect(responseData(response).content).toMatch(/doesn't look like a valid token/i)
  })

  it('rejects a token whose embedded discord_id belongs to a different account', async () => {
    const token = fakeJwt({ discord_id: 'someone-else', username: 'Other', exp: FUTURE_EXP() })
    const linkOrganizerMock = stub(async (_discordId: string, _t: string) => {
      throw new Error('linkOrganizer should not have been called')
    })
    const interaction = fakeModalSubmitInteraction({
      customId: 'connect-ptp:submit',
      components: actionRowWithToken(token),
    })

    const response = await handleModalSubmit(interaction, createFakeBackendClient({ linkOrganizer: linkOrganizerMock }))

    expect(responseData(response).content).toMatch(/different discord account/i)
  })

  it('rejects an already-expired token before calling the backend', async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: PAST_EXP() })
    const linkOrganizerMock = stub(async (_discordId: string, _t: string) => {
      throw new Error('linkOrganizer should not have been called')
    })
    const interaction = fakeModalSubmitInteraction({
      customId: 'connect-ptp:submit',
      components: actionRowWithToken(token),
    })

    const response = await handleModalSubmit(interaction, createFakeBackendClient({ linkOrganizer: linkOrganizerMock }))

    expect(responseData(response).content).toMatch(/already expired/i)
  })

  it("surfaces the service's specific validation error message when the backend rejects the token (e.g. PTP says it is invalid)", async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: FUTURE_EXP() })
    const linkOrganizerMock = stub(async (_discordId: string, _t: string) => ({
      ok: false as const,
      error: { kind: 'validation' as const, message: 'PTP rejected this token' },
    }))
    const interaction = fakeModalSubmitInteraction({
      customId: 'connect-ptp:submit',
      components: actionRowWithToken(token),
    })

    const response = await handleModalSubmit(interaction, createFakeBackendClient({ linkOrganizer: linkOrganizerMock }))

    expect(responseData(response).content).toMatch(/PTP rejected this token/)
  })

  it('documents current behavior: a token with no embedded discord_id skips the anti-mistake check', async () => {
    // §8.2(c) is a guard against pasting *someone else's* token; it can only
    // fire when discord_id is present to compare against. In practice PTP's
    // Option B tokens always carry discord_id (minted via Discord OAuth
    // login), but the check is written as `payload.discord_id && ...`, so a
    // token missing that field silently passes this check and proceeds to
    // the live PTP validation instead. Pinning this so the behavior is a
    // visible, deliberate choice rather than something discovered later.
    const token = fakeJwt({ username: 'NoDiscordLink', exp: FUTURE_EXP() })
    const linkOrganizerMock = stub(async (discordId: string, t: string) => {
      if (discordId !== 'user-1' || t !== token) throw new Error(`unexpected linkOrganizer args: ${discordId} ${t}`)
      return { ok: true as const, value: { username: 'NoDiscordLink' } }
    })
    const interaction = fakeModalSubmitInteraction({
      customId: 'connect-ptp:submit',
      components: actionRowWithToken(token),
    })

    const response = await handleModalSubmit(interaction, createFakeBackendClient({ linkOrganizer: linkOrganizerMock }))

    expect(responseData(response).content).toContain('Linked as **NoDiscordLink**')
  })
})
