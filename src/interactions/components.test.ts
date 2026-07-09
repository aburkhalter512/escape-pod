import { describe, expect, it, vi } from 'vitest'
import { ComponentType, InteractionResponseType, TextInputStyle } from 'discord-api-types/v10'
import { extractTextInputValue, handleMessageComponent, handleModalSubmit } from './components.js'
import type { BackendClient } from '../backendClient.js'
import { responseData } from '../testUtils/responseData.js'

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
    const response = await handleMessageComponent(interaction as never, {} as BackendClient)

    expect(response.type).toBe(InteractionResponseType.Modal)
    expect(responseData(response).custom_id).toBe('connect-ptp:submit')
  })

  it('starts a pod round from a guild-select submission, packing guildIds from values', async () => {
    const startPodMock = vi.fn().mockResolvedValue({ podRoundId: 'round-1' })
    const interaction = {
      data: {
        custom_id: 'start-pod:select-guilds:JTL:8',
        component_type: ComponentType.StringSelect,
        values: ['g1', 'g2'],
      },
      member: { user: { id: 'organizer-1' } },
    }

    const response = await handleMessageComponent(interaction as never, {
      startPod: startPodMock,
    } as unknown as BackendClient)

    expect(startPodMock).toHaveBeenCalledWith({
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: ['g1', 'g2'],
    })
    expect(responseData(response).content).toContain('2 server(s)')
  })

  it('rejects a guild-select submission when the organizer id cannot be determined', async () => {
    const startPodMock = vi.fn()
    const interaction = {
      data: { custom_id: 'start-pod:select-guilds:JTL:8', component_type: ComponentType.StringSelect, values: [] },
    }

    const response = await handleMessageComponent(interaction as never, {
      startPod: startPodMock,
    } as unknown as BackendClient)

    expect(startPodMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
  })

  it('records a signup and reports the shared count via UpdateMessage', async () => {
    const recordSignupMock = vi
      .fn()
      .mockResolvedValue({ count: 5, threshold: 8, thresholdReached: false })
    const interaction = {
      data: { custom_id: 'pod-signup:round-1:in' },
      member: { user: { id: 'player-1', username: 'PlayerOne' } },
      guild_id: 'guild-1',
    }

    const response = await handleMessageComponent(interaction as never, {
      recordSignup: recordSignupMock,
    } as unknown as BackendClient)

    expect(recordSignupMock).toHaveBeenCalledWith('round-1', 'player-1', 'PlayerOne', 'guild-1')
    expect(response.type).toBe(InteractionResponseType.UpdateMessage)
    expect(responseData(response).content).toBe('5/8 confirmed')
  })

  it('announces "pod full" once the signup pushes the count to threshold', async () => {
    const recordSignupMock = vi.fn().mockResolvedValue({ count: 8, threshold: 8, thresholdReached: true })
    const interaction = {
      data: { custom_id: 'pod-signup:round-1:in' },
      member: { user: { id: 'player-1', username: 'PlayerOne' } },
      guild_id: 'guild-1',
    }

    const response = await handleMessageComponent(interaction as never, {
      recordSignup: recordSignupMock,
    } as unknown as BackendClient)

    expect(responseData(response).content).toBe('8/8 confirmed — pod full!')
  })

  it('rejects a signup click when the Discord identity cannot be determined', async () => {
    const recordSignupMock = vi.fn()
    const interaction = { data: { custom_id: 'pod-signup:round-1:in' } }

    const response = await handleMessageComponent(interaction as never, {
      recordSignup: recordSignupMock,
    } as unknown as BackendClient)

    expect(recordSignupMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/could not determine your discord identity/i)
  })

  it('falls back to a generic message for an unrecognized custom_id', async () => {
    const interaction = { data: { custom_id: 'something-unexpected' } }
    const response = await handleMessageComponent(interaction as never, {} as BackendClient)
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
