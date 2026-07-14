import { describe, expect, it } from 'vitest'
import { InteractionResponseType } from 'discord-api-types/v10'
import { handleAutocomplete } from './autocomplete.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { fakeAutocompleteInteraction, fakeMember, fakeUser } from '../testUtils/fakeInteraction.js'
import { stub } from '../testUtils/stub.js'

// GitHub issue #6 — live suggestions for the `round` option on
// /cancel-pod and /conclude-pod. router.test.ts only proves dispatch
// reaches this handler; these tests cover its actual behavior.
describe('handleAutocomplete', () => {
  it("asks for 'cancellable' rounds for cancel-pod and maps them to name/value choices", async () => {
    const listActiveRounds = stub(async (organizerDiscordId: string, kind: 'cancellable' | 'concludable') => {
      expect(organizerDiscordId).toBe('organizer-1')
      expect(kind).toBe('cancellable')
      return [
        { podRoundId: 'round-1', setCode: 'JTL', organizerRoundNumber: 1 },
        { podRoundId: 'round-3', setCode: 'SOR', organizerRoundNumber: 3 },
      ]
    })
    const interaction = fakeAutocompleteInteraction({
      name: 'cancel-pod',
      member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
    })

    const response = await handleAutocomplete(interaction, createFakeBackendClient({ listActiveRounds }))

    expect(response).toEqual({
      type: InteractionResponseType.ApplicationCommandAutocompleteResult,
      data: {
        choices: [
          { name: 'JTL #1', value: 1 },
          { name: 'SOR #3', value: 3 },
        ],
      },
    })
  })

  it("asks for 'concludable' rounds for conclude-pod", async () => {
    const listActiveRounds = stub(async (_organizerDiscordId: string, kind: 'cancellable' | 'concludable') => {
      expect(kind).toBe('concludable')
      return []
    })
    const interaction = fakeAutocompleteInteraction({
      name: 'conclude-pod',
      member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
    })

    await handleAutocomplete(interaction, createFakeBackendClient({ listActiveRounds }))

    expect(listActiveRounds.calls).toHaveLength(1)
  })

  it("scopes choices to the calling organizer only — a different organizer's rounds never appear", async () => {
    const listActiveRounds = stub(async (organizerDiscordId: string, _kind: 'cancellable' | 'concludable') =>
      organizerDiscordId === 'organizer-1'
        ? [{ podRoundId: 'round-1', setCode: 'JTL', organizerRoundNumber: 1 }]
        : [{ podRoundId: 'round-9', setCode: 'TWI', organizerRoundNumber: 9 }]
    )
    const interaction = fakeAutocompleteInteraction({
      name: 'cancel-pod',
      member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
    })

    const response = await handleAutocomplete(interaction, createFakeBackendClient({ listActiveRounds }))

    expect(response).toEqual({
      type: InteractionResponseType.ApplicationCommandAutocompleteResult,
      data: { choices: [{ name: 'JTL #1', value: 1 }] },
    })
  })

  it('returns an empty choice list, without calling the backend, when the organizer id cannot be determined', async () => {
    const listActiveRounds = stub(async (_organizerDiscordId: string, _kind: 'cancellable' | 'concludable') => {
      throw new Error('listActiveRounds should not have been called')
    })
    const interaction = fakeAutocompleteInteraction({ name: 'cancel-pod', member: undefined })

    const response = await handleAutocomplete(interaction, createFakeBackendClient({ listActiveRounds }))

    expect(response).toEqual({
      type: InteractionResponseType.ApplicationCommandAutocompleteResult,
      data: { choices: [] },
    })
  })

  // Only cancel-pod/conclude-pod register an autocomplete-enabled `round`
  // option today — this proves an unrecognized command name fails safe
  // (empty choices) instead of silently defaulting to "cancellable," so a
  // future command adding its own autocomplete option can't accidentally
  // inherit the wrong kind here.
  it('returns an empty choice list, without calling the backend, for a command name it does not recognize', async () => {
    const listActiveRounds = stub(async (_organizerDiscordId: string, _kind: 'cancellable' | 'concludable') => {
      throw new Error('listActiveRounds should not have been called')
    })
    const interaction = fakeAutocompleteInteraction({
      name: 'some-other-command',
      member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
    })

    const response = await handleAutocomplete(interaction, createFakeBackendClient({ listActiveRounds }))

    expect(response).toEqual({
      type: InteractionResponseType.ApplicationCommandAutocompleteResult,
      data: { choices: [] },
    })
  })
})
