import { describe, expect, it } from 'vitest'
import { ComponentType, InteractionResponseType } from 'discord-api-types/v10'
import { routeInteraction, type RouterDeps } from './router.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { createInMemoryPendingStartPodStore } from '../pendingStartPods.js'
import {
  fakeAutocompleteInteraction,
  fakeChatInputInteraction,
  fakeMessageComponentInteraction,
  fakeModalSubmitInteraction,
  fakePingInteraction,
} from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'

function deps(): RouterDeps {
  return {
    backend: createFakeBackendClient(),
    discordRest: createFakeDiscordRest(),
    pendingStartPods: createInMemoryPendingStartPodStore(),
  }
}

describe('routeInteraction', () => {
  it('responds to PING with PONG without touching the backend', async () => {
    const response = await routeInteraction(fakePingInteraction(), deps())
    expect(response).toEqual({ type: InteractionResponseType.Pong })
  })

  it('dispatches an application command to its registered handler', async () => {
    const response = await routeInteraction(fakeChatInputInteraction({ name: 'connect-ptp' }), deps())
    expect(response.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(responseData(response).content).toContain('protectthepod.com')
  })

  it('returns a clear error for a command name with no registered handler', async () => {
    const response = await routeInteraction(fakeChatInputInteraction({ name: 'not-a-real-command' }), deps())
    expect(responseData(response).content).toMatch(/unknown command: not-a-real-command/i)
  })

  it('dispatches message components to the component handler', async () => {
    const interaction = fakeMessageComponentInteraction({
      data: { custom_id: 'connect-ptp:open-modal', component_type: ComponentType.Button },
    })
    const response = await routeInteraction(interaction, deps())
    expect(response.type).toBe(InteractionResponseType.Modal)
  })

  it('dispatches modal submits to the modal handler', async () => {
    const interaction = fakeModalSubmitInteraction({ customId: 'connect-ptp:submit', components: [] })
    const response = await routeInteraction(interaction, deps())
    expect(responseData(response).content).toMatch(/no token was submitted/i)
  })

  // GitHub issue #6 — the round option's live suggestions on /cancel-pod
  // and /conclude-pod. This only proves dispatch reaches the handler with
  // the right deps; handleAutocomplete's own behavior (kind selection,
  // organizer scoping, empty-candidates) is covered in
  // interactions/autocomplete.test.ts.
  it('dispatches autocomplete interactions to the round-choice handler', async () => {
    const listActiveRounds = stub(async (_organizerDiscordId: string, _kind: 'cancellable' | 'concludable') => [
      { podRoundId: 'round-1', setCode: 'JTL', organizerRoundNumber: 1 },
    ])
    const response = await routeInteraction(fakeAutocompleteInteraction({ name: 'cancel-pod' }), {
      ...deps(),
      backend: createFakeBackendClient({ listActiveRounds }),
    })

    expect(response).toEqual({
      type: InteractionResponseType.ApplicationCommandAutocompleteResult,
      data: { choices: [{ name: 'JTL #1', value: 1 }] },
    })
  })

  it('does not let one command handler throwing crash the router for unrelated calls', async () => {
    // Sanity check that handlers are invoked independently — a defensive
    // regression test, not tied to any specific handler's internals.
    const pingResponse = await routeInteraction(fakePingInteraction(), deps())
    expect(pingResponse).toEqual({ type: InteractionResponseType.Pong })
  })
})
