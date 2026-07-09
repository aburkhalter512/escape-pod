import { describe, expect, it, vi } from 'vitest'
import { ComponentType, InteractionResponseType, TextInputStyle } from 'discord-api-types/v10'
import type { REST } from '@discordjs/rest'
import { extractTextInputValue, handleMessageComponent, handleModalSubmit } from './components.js'
import type { BackendClient } from '../backendClient.js'
import { responseData } from '../testUtils/responseData.js'

function fakeRest() {
  return { post: vi.fn(), patch: vi.fn() } as unknown as REST & {
    post: ReturnType<typeof vi.fn>
    patch: ReturnType<typeof vi.fn>
  }
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.sig`
}

const FUTURE_EXP = () => Math.floor(Date.now() / 1000) + 3600
const PAST_EXP = () => Math.floor(Date.now() / 1000) - 3600

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
    const interaction = { data: { custom_id: 'connect-ptp:open-modal' } }
    const response = await handleMessageComponent(interaction as never, {} as BackendClient, fakeRest())

    expect(response.type).toBe(InteractionResponseType.Modal)
    expect(responseData(response).custom_id).toBe('connect-ptp:submit')
  })

  describe('start-pod:select-guilds:', () => {
    function interaction(overrides: Record<string, unknown> = {}) {
      return {
        data: {
          custom_id: 'start-pod:select-guilds:JTL:8',
          component_type: ComponentType.StringSelect,
          values: ['g1', 'g2'],
        },
        member: { user: { id: 'organizer-1' } },
        ...overrides,
      }
    }

    it('starts the round, posts the RSVP message to every target, and records each message id', async () => {
      const startPodMock = vi.fn().mockResolvedValue({
        podRoundId: 'round-1',
        targets: [
          { guildId: 'g1', channelId: 'channel-1' },
          { guildId: 'g2', channelId: 'channel-2' },
        ],
      })
      const recordMessagePostedMock = vi.fn()
      const rest = fakeRest()
      rest.post.mockResolvedValueOnce({ id: 'msg-1' }).mockResolvedValueOnce({ id: 'msg-2' })

      const response = await handleMessageComponent(
        interaction() as never,
        { startPod: startPodMock, recordMessagePosted: recordMessagePostedMock } as unknown as BackendClient,
        rest
      )

      expect(startPodMock).toHaveBeenCalledWith({
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        guildIds: ['g1', 'g2'],
      })

      expect(rest.post).toHaveBeenCalledTimes(2)
      expect(rest.post).toHaveBeenCalledWith('/channels/channel-1/messages', expect.anything())
      expect(rest.post).toHaveBeenCalledWith('/channels/channel-2/messages', expect.anything())

      expect(recordMessagePostedMock).toHaveBeenCalledWith('round-1', 'g1', 'msg-1')
      expect(recordMessagePostedMock).toHaveBeenCalledWith('round-1', 'g2', 'msg-2')

      expect(responseData(response).content).toContain('2 server(s)')
      expect(responseData(response).content).not.toMatch(/failed to post/i)
    })

    it('posts an initial embed showing 0 signups with I\'m in / Leave buttons, not the count directly', async () => {
      const startPodMock = vi
        .fn()
        .mockResolvedValue({ podRoundId: 'round-1', targets: [{ guildId: 'g1', channelId: 'channel-1' }] })
      const rest = fakeRest()
      rest.post.mockResolvedValue({ id: 'msg-1' })

      await handleMessageComponent(
        interaction({ data: { ...interaction().data, values: ['g1'] } }) as never,
        { startPod: startPodMock, recordMessagePosted: vi.fn() } as unknown as BackendClient,
        rest
      )

      const [, postInit] = rest.post.mock.calls[0]
      expect(postInit.body.embeds[0].description).toContain('0/8 confirmed')
      const buttonCustomIds = postInit.body.components[0].components.map((c: { custom_id: string }) => c.custom_id)
      expect(buttonCustomIds).toEqual(['pod-signup:round-1:in', 'pod-signup:round-1:leave'])
    })

    it('reports a partial-failure count when one target fails to post, without dropping the others', async () => {
      const startPodMock = vi.fn().mockResolvedValue({
        podRoundId: 'round-1',
        targets: [
          { guildId: 'g1', channelId: 'channel-1' },
          { guildId: 'g2', channelId: 'channel-2' },
        ],
      })
      const rest = fakeRest()
      rest.post
        .mockResolvedValueOnce({ id: 'msg-1' })
        .mockRejectedValueOnce(new Error('Missing Access'))
      const recordMessagePostedMock = vi.fn()

      const response = await handleMessageComponent(
        interaction() as never,
        { startPod: startPodMock, recordMessagePosted: recordMessagePostedMock } as unknown as BackendClient,
        rest
      )

      // The failing guild never got recordMessagePosted called for it, but
      // the successful one still did — one bad guild shouldn't roll back
      // the rest (Promise.allSettled, not Promise.all).
      expect(recordMessagePostedMock).toHaveBeenCalledTimes(1)
      expect(recordMessagePostedMock).toHaveBeenCalledWith('round-1', 'g1', 'msg-1')
      expect(responseData(response).content).toMatch(/1 server\(s\) failed to post/i)
    })

    it('rejects a guild-select submission when the organizer id cannot be determined', async () => {
      const startPodMock = vi.fn()

      const response = await handleMessageComponent(
        interaction({ member: undefined }) as never,
        { startPod: startPodMock } as unknown as BackendClient,
        fakeRest()
      )

      expect(startPodMock).not.toHaveBeenCalled()
      expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
    })
  })

  describe('pod-signup:', () => {
    function interaction(overrides: Record<string, unknown> = {}) {
      return {
        data: { custom_id: 'pod-signup:round-1:in' },
        member: { user: { id: 'player-1', username: 'PlayerOne' } },
        guild_id: 'guild-1',
        ...overrides,
      }
    }

    function signupResult(overrides: Record<string, unknown> = {}) {
      return {
        count: 5,
        threshold: 8,
        setCode: 'JTL',
        thresholdReached: false,
        podCreated: false,
        targets: [
          { guildId: 'guild-1', channelId: 'channel-1', messageId: 'msg-1' },
          { guildId: 'guild-2', channelId: 'channel-2', messageId: 'msg-2' },
        ],
        ...overrides,
      }
    }

    it('records the signup and returns an UpdateMessage with the new embed', async () => {
      const recordSignupMock = vi.fn().mockResolvedValue(signupResult())

      const response = await handleMessageComponent(
        interaction() as never,
        { recordSignup: recordSignupMock } as unknown as BackendClient,
        fakeRest()
      )

      expect(recordSignupMock).toHaveBeenCalledWith('round-1', 'player-1', 'PlayerOne', 'guild-1')
      expect(response.type).toBe(InteractionResponseType.UpdateMessage)
      expect(responseData(response).content).toBeUndefined() // embeds/components now, not plain content
      expect(responseData(response).components?.[0]).toBeDefined()
    })

    it('edits every OTHER target guild\'s message, but not the one the click came from', async () => {
      const recordSignupMock = vi.fn().mockResolvedValue(signupResult())
      const rest = fakeRest()

      await handleMessageComponent(
        interaction() as never, // guild_id: 'guild-1'
        { recordSignup: recordSignupMock } as unknown as BackendClient,
        rest
      )

      // Only guild-2's message should be REST-edited — guild-1's is handled
      // by the UpdateMessage interaction response itself (§7.5 step 3).
      expect(rest.patch).toHaveBeenCalledTimes(1)
      expect(rest.patch).toHaveBeenCalledWith('/channels/channel-2/messages/msg-2', expect.anything())
    })

    it('skips targets with no recorded messageId yet', async () => {
      const recordSignupMock = vi.fn().mockResolvedValue(
        signupResult({
          targets: [
            { guildId: 'guild-1', channelId: 'channel-1', messageId: 'msg-1' },
            { guildId: 'guild-2', channelId: 'channel-2', messageId: null },
          ],
        })
      )
      const rest = fakeRest()

      await handleMessageComponent(
        interaction() as never,
        { recordSignup: recordSignupMock } as unknown as BackendClient,
        rest
      )

      expect(rest.patch).not.toHaveBeenCalled()
    })

    it('one guild\'s edit failing does not throw or block the interaction response', async () => {
      const recordSignupMock = vi.fn().mockResolvedValue(signupResult())
      const rest = fakeRest()
      rest.patch.mockRejectedValue(new Error('Unknown Message'))

      const response = await handleMessageComponent(
        interaction() as never,
        { recordSignup: recordSignupMock } as unknown as BackendClient,
        rest
      )

      expect(response.type).toBe(InteractionResponseType.UpdateMessage)
    })

    it('shows the pod-full embed with a join link once threshold is reached and the pod is created', async () => {
      const recordSignupMock = vi.fn().mockResolvedValue(
        signupResult({
          count: 8,
          thresholdReached: true,
          podCreated: true,
          shareUrl: 'https://www.protectthepod.com/draft/share-1',
        })
      )

      const response = await handleMessageComponent(
        interaction() as never,
        { recordSignup: recordSignupMock } as unknown as BackendClient,
        fakeRest()
      )

      const data = responseData(response)
      const buttons = (data.components?.[0] as { components: unknown[] }).components
      expect(buttons).toEqual([
        expect.objectContaining({ url: 'https://www.protectthepod.com/draft/share-1' }),
      ])
      // §7.5 step 4: no more "I'm in"/"Leave" buttons once the pod is full.
      expect((buttons[0] as { custom_id?: string }).custom_id).toBeUndefined()
    })

    it('rejects a signup click when the Discord identity cannot be determined', async () => {
      const recordSignupMock = vi.fn()

      const response = await handleMessageComponent(
        interaction({ member: undefined }) as never,
        { recordSignup: recordSignupMock } as unknown as BackendClient,
        fakeRest()
      )

      expect(recordSignupMock).not.toHaveBeenCalled()
      expect(responseData(response).content).toMatch(/could not determine your discord identity/i)
    })
  })

  it('falls back to a generic message for an unrecognized custom_id', async () => {
    const interaction = { data: { custom_id: 'something-unexpected' } }
    const response = await handleMessageComponent(interaction as never, {} as BackendClient, fakeRest())
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
    const linkOrganizerMock = vi.fn().mockResolvedValue({ username: 'PlayerOne' })
    const interaction = {
      data: { custom_id: 'connect-ptp:submit', components: actionRowWithToken(token) },
      member: { user: { id: 'user-1' } },
    }

    const response = await handleModalSubmit(interaction as never, {
      linkOrganizer: linkOrganizerMock,
    } as unknown as BackendClient)

    expect(linkOrganizerMock).toHaveBeenCalledWith('user-1', token)
    expect(responseData(response).content).toContain('Linked as **PlayerOne**')
  })

  it('ignores modals with an unrelated custom_id', async () => {
    const interaction = { data: { custom_id: 'some-other-modal', components: [] } }
    const response = await handleModalSubmit(interaction as never, {} as BackendClient)
    expect(responseData(response).content).toMatch(/unrecognized modal/i)
  })

  it('rejects when the Discord user id cannot be determined', async () => {
    const interaction = { data: { custom_id: 'connect-ptp:submit', components: [] } }
    const response = await handleModalSubmit(interaction as never, {} as BackendClient)
    expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
  })

  it('rejects when no token was submitted in the modal', async () => {
    const interaction = {
      data: { custom_id: 'connect-ptp:submit', components: actionRowWithToken('') },
      member: { user: { id: 'user-1' } },
    }
    const response = await handleModalSubmit(interaction as never, {} as BackendClient)
    expect(responseData(response).content).toMatch(/no token was submitted/i)
  })

  it('rejects a structurally malformed token before calling the backend', async () => {
    const linkOrganizerMock = vi.fn()
    const interaction = {
      data: { custom_id: 'connect-ptp:submit', components: actionRowWithToken('not-a-jwt') },
      member: { user: { id: 'user-1' } },
    }

    const response = await handleModalSubmit(interaction as never, {
      linkOrganizer: linkOrganizerMock,
    } as unknown as BackendClient)

    expect(linkOrganizerMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/doesn't look like a valid token/i)
  })

  it('rejects a token whose embedded discord_id belongs to a different account', async () => {
    const token = fakeJwt({ discord_id: 'someone-else', username: 'Other', exp: FUTURE_EXP() })
    const linkOrganizerMock = vi.fn()
    const interaction = {
      data: { custom_id: 'connect-ptp:submit', components: actionRowWithToken(token) },
      member: { user: { id: 'user-1' } },
    }

    const response = await handleModalSubmit(interaction as never, {
      linkOrganizer: linkOrganizerMock,
    } as unknown as BackendClient)

    expect(linkOrganizerMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/different discord account/i)
  })

  it('rejects an already-expired token before calling the backend', async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: PAST_EXP() })
    const linkOrganizerMock = vi.fn()
    const interaction = {
      data: { custom_id: 'connect-ptp:submit', components: actionRowWithToken(token) },
      member: { user: { id: 'user-1' } },
    }

    const response = await handleModalSubmit(interaction as never, {
      linkOrganizer: linkOrganizerMock,
    } as unknown as BackendClient)

    expect(linkOrganizerMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/already expired/i)
  })

  it('surfaces a friendly error when the backend rejects the token (e.g. PTP says it is invalid)', async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: FUTURE_EXP() })
    const linkOrganizerMock = vi.fn().mockRejectedValue(new Error('Backend request failed: 422'))
    const interaction = {
      data: { custom_id: 'connect-ptp:submit', components: actionRowWithToken(token) },
      member: { user: { id: 'user-1' } },
    }

    const response = await handleModalSubmit(interaction as never, {
      linkOrganizer: linkOrganizerMock,
    } as unknown as BackendClient)

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
    const linkOrganizerMock = vi.fn().mockResolvedValue({ username: 'NoDiscordLink' })
    const interaction = {
      data: { custom_id: 'connect-ptp:submit', components: actionRowWithToken(token) },
      member: { user: { id: 'user-1' } },
    }

    const response = await handleModalSubmit(interaction as never, {
      linkOrganizer: linkOrganizerMock,
    } as unknown as BackendClient)

    expect(linkOrganizerMock).toHaveBeenCalledWith('user-1', token)
    expect(responseData(response).content).toContain('Linked as **NoDiscordLink**')
  })
})
