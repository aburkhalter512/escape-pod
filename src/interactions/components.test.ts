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
    const response = await handleMessageComponent(interaction, createFakeBackendClient(), createFakeDiscordRest())

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

    it('starts the round, posts the RSVP message to every target, and records each message id', async () => {
      const startPodMock = stub(
        async (params: { organizerDiscordId: string; setCode: string; threshold: number; guildIds: string[]; scheduledFor?: Date }) => {
        const expected = {
          organizerDiscordId: 'organizer-1',
          setCode: 'JTL',
          threshold: 8,
          guildIds: ['g1', 'g2'],
          scheduledFor: undefined,
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
      })
      const postMessage = stub(async (channelId: string, _body: RESTPostAPIChannelMessageJSONBody) => {
        if (channelId === 'channel-1') return { id: 'msg-1' } as RESTPostAPIChannelMessageResult
        if (channelId === 'channel-2') return { id: 'msg-2' } as RESTPostAPIChannelMessageResult
        throw new Error(`unexpected postMessage channelId: ${channelId}`)
      })

      const response = await handleMessageComponent(
        interaction(),
        createFakeBackendClient({ startPod: startPodMock, recordMessagePosted: recordMessagePostedMock }),
        createFakeDiscordRest({ postMessage })
      )

      expect(postMessage.calls).toHaveLength(2)
      expect(recordMessagePostedMock.calls).toHaveLength(2)
      expect(responseData(response).content).toContain('2 server(s)')
      expect(responseData(response).content).not.toMatch(/failed to post/i)
    })

    it("posts an initial embed showing 0 signups with I'm in / Leave buttons, not the count directly", async () => {
      const startPodMock = stub(async (_params: unknown) => ({
        podRoundId: 'round-1',
        targets: [{ guildId: 'g1', channelId: 'channel-1' }],
      }))
      const postMessage = stub(
        async (_channelId: string, _body: RESTPostAPIChannelMessageJSONBody) => ({ id: 'msg-1' }) as RESTPostAPIChannelMessageResult
      )

      await handleMessageComponent(
        interaction({ values: ['g1'] }),
        createFakeBackendClient({ startPod: startPodMock, recordMessagePosted: stub(async () => undefined) }),
        createFakeDiscordRest({ postMessage })
      )

      const [, postBody] = postMessage.calls[0]
      const embeds = postBody.embeds as Array<{ description: string }>
      expect(embeds[0].description).toContain('0/8 confirmed')
      const components = postBody.components as Array<{ components: Array<{ custom_id: string }> }>
      const buttonCustomIds = components[0].components.map((c) => c.custom_id)
      expect(buttonCustomIds).toEqual(['pod-signup:round-1:in', 'pod-signup:round-1:leave'])
    })

    it('reports a partial-failure count when one target fails to post, without dropping the others', async () => {
      const startPodMock = stub(async (_params: unknown) => ({
        podRoundId: 'round-1',
        targets: [
          { guildId: 'g1', channelId: 'channel-1' },
          { guildId: 'g2', channelId: 'channel-2' },
        ],
      }))
      const recordMessagePostedMock = stub(async (_podRoundId: string, _guildId: string, _messageId: string) => undefined)
      const postMessage = stub(async (channelId: string, _body: RESTPostAPIChannelMessageJSONBody) => {
        if (channelId === 'channel-1') return { id: 'msg-1' } as RESTPostAPIChannelMessageResult
        throw new Error('Missing Access')
      })

      const response = await handleMessageComponent(
        interaction(),
        createFakeBackendClient({ startPod: startPodMock, recordMessagePosted: recordMessagePostedMock }),
        createFakeDiscordRest({ postMessage })
      )

      // The failing guild never got recordMessagePosted called for it, but
      // the successful one still did — one bad guild shouldn't roll back
      // the rest (Promise.allSettled, not Promise.all).
      expect(recordMessagePostedMock.calls).toHaveLength(1)
      expect(recordMessagePostedMock.calls[0]).toEqual(['round-1', 'g1', 'msg-1'])
      expect(responseData(response).content).toMatch(/1 server\(s\) failed to post/i)
    })

    it('rejects a guild-select submission when the organizer id cannot be determined', async () => {
      const startPodMock = stub(async (_params: unknown) => {
        throw new Error('startPod should not have been called')
      })

      const response = await handleMessageComponent(
        interaction({ member: undefined }),
        createFakeBackendClient({ startPod: startPodMock }),
        createFakeDiscordRest()
      )

      expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
    })

    it('parses the deadline segment into scheduledFor and threads it through to startPod and the posted message', async () => {
      const deadlineEpoch = Math.floor(Date.now() / 1000) + 7200
      const deadlineInteraction = fakeMessageComponentInteraction({
        data: {
          custom_id: `start-pod:select-guilds:JTL:8:${deadlineEpoch}`,
          component_type: ComponentType.StringSelect,
          values: ['g1'],
        },
        member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
      })
      const startPodMock = stub(async (params: { scheduledFor?: Date }) => {
        expect(params.scheduledFor).toEqual(new Date(deadlineEpoch * 1000))
        return { podRoundId: 'round-1', targets: [{ guildId: 'g1', channelId: 'channel-1' }] }
      })
      const postMessage = stub(
        async (_channelId: string, body: RESTPostAPIChannelMessageJSONBody) => {
          const embeds = body.embeds as Array<{ description: string }>
          expect(embeds[0].description).toContain(`<t:${deadlineEpoch}:R>`)
          return { id: 'msg-1' } as RESTPostAPIChannelMessageResult
        }
      )

      await handleMessageComponent(
        deadlineInteraction,
        createFakeBackendClient({ startPod: startPodMock, recordMessagePosted: stub(async () => undefined) }),
        createFakeDiscordRest({ postMessage })
      )

      expect(postMessage.calls).toHaveLength(1)
    })

    it('treats a missing deadline segment (custom_id ending in a bare colon) the same as no deadline at all', async () => {
      const noDeadlineInteraction = fakeMessageComponentInteraction({
        data: {
          custom_id: 'start-pod:select-guilds:JTL:8:',
          component_type: ComponentType.StringSelect,
          values: ['g1'],
        },
        member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
      })
      const startPodMock = stub(async (params: { scheduledFor?: Date }) => {
        expect(params.scheduledFor).toBeUndefined()
        return { podRoundId: 'round-1', targets: [{ guildId: 'g1', channelId: 'channel-1' }] }
      })

      await handleMessageComponent(
        noDeadlineInteraction,
        createFakeBackendClient({ startPod: startPodMock, recordMessagePosted: stub(async () => undefined) }),
        createFakeDiscordRest({ postMessage: stub(async () => ({ id: 'msg-1' }) as RESTPostAPIChannelMessageResult) })
      )
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

    function signupResult(overrides: Record<string, unknown> = {}) {
      return {
        count: 5,
        threshold: 8,
        setCode: 'JTL',
        full: false,
        podCreated: false,
        targets: [
          { guildId: 'guild-1', channelId: 'channel-1', messageId: 'msg-1' },
          { guildId: 'guild-2', channelId: 'channel-2', messageId: 'msg-2' },
        ],
        ...overrides,
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
        })
      )

      expect(response.type).toBe(InteractionResponseType.UpdateMessage)
      expect(responseData(response).content).toBeUndefined() // embeds/components now, not plain content
      expect(responseData(response).components?.[0]).toBeDefined()
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
        })
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
        createFakeDiscordRest({ editMessage })
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
        createFakeDiscordRest({ editMessage })
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
        createFakeDiscordRest({ editMessage })
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
        })
      )

      const data = responseData(response)
      const buttons = (data.components?.[0] as { components: unknown[] }).components
      expect(buttons).toEqual([expect.objectContaining({ url: 'https://www.protectthepod.com/draft/share-1' })])
      // §7.5 step 4: no more "I'm in"/"Leave" buttons once the pod is full.
      expect((buttons[0] as { custom_id?: string }).custom_id).toBeUndefined()
    })

    it('rejects a signup click when the Discord identity cannot be determined', async () => {
      const recordSignupMock = stub(async (_podRoundId: string, _discordId: string, _username: string, _sourceGuildId: string) => {
        throw new Error('recordSignup should not have been called')
      })

      const response = await handleMessageComponent(
        interaction({ member: undefined }),
        createFakeBackendClient({ recordSignup: recordSignupMock }),
        createFakeDiscordRest()
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
        createFakeDiscordRest()
      )

      expect(responseData(response).content).toMatch(/could not determine your discord identity/i)
    })
  })

  it('falls back to a generic message for an unrecognized custom_id', async () => {
    const interaction = fakeMessageComponentInteraction({
      data: { custom_id: 'something-unexpected', component_type: ComponentType.Button },
    })
    const response = await handleMessageComponent(interaction, createFakeBackendClient(), createFakeDiscordRest())
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
      return { username: 'PlayerOne' }
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

  it('surfaces a friendly error when the backend rejects the token (e.g. PTP says it is invalid)', async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: FUTURE_EXP() })
    const linkOrganizerMock = stub(async (_discordId: string, _t: string) => {
      throw new Error('Backend request failed: 422')
    })
    const interaction = fakeModalSubmitInteraction({
      customId: 'connect-ptp:submit',
      components: actionRowWithToken(token),
    })

    const response = await handleModalSubmit(interaction, createFakeBackendClient({ linkOrganizer: linkOrganizerMock }))

    expect(responseData(response).content).toMatch(/didn't accept that token/i)
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
      return { username: 'NoDiscordLink' }
    })
    const interaction = fakeModalSubmitInteraction({
      customId: 'connect-ptp:submit',
      components: actionRowWithToken(token),
    })

    const response = await handleModalSubmit(interaction, createFakeBackendClient({ linkOrganizer: linkOrganizerMock }))

    expect(responseData(response).content).toContain('Linked as **NoDiscordLink**')
  })
})
