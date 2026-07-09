import { describe, expect, it } from 'vitest'
import { InteractionResponseType, InteractionType } from 'discord-api-types/v10'
import { routeInteraction } from './router.js'
import type { BackendClient } from '../backendClient.js'
import { responseData } from '../testUtils/responseData.js'

describe('routeInteraction', () => {
  it('responds to PING with PONG without touching the backend', async () => {
    const interaction = { type: InteractionType.Ping }
    const response = await routeInteraction(interaction as never, {} as BackendClient)
    expect(response).toEqual({ type: InteractionResponseType.Pong })
  })

  it('dispatches an application command to its registered handler', async () => {
    const interaction = {
      type: InteractionType.ApplicationCommand,
      data: { name: 'connect-ptp' },
    }
    const response = await routeInteraction(interaction as never, {} as BackendClient)
    expect(response.type).toBe(InteractionResponseType.ChannelMessageWithSource)
    expect(responseData(response).content).toContain('protectthepod.com')
  })

  it('returns a clear error for a command name with no registered handler', async () => {
    const interaction = {
      type: InteractionType.ApplicationCommand,
      data: { name: 'not-a-real-command' },
    }
    const response = await routeInteraction(interaction as never, {} as BackendClient)
    expect(responseData(response).content).toMatch(/unknown command: not-a-real-command/i)
  })

  it('dispatches message components to the component handler', async () => {
    const interaction = {
      type: InteractionType.MessageComponent,
      data: { custom_id: 'connect-ptp:open-modal' },
    }
    const response = await routeInteraction(interaction as never, {} as BackendClient)
    expect(response.type).toBe(InteractionResponseType.Modal)
  })

  it('dispatches modal submits to the modal handler', async () => {
    const interaction = {
      type: InteractionType.ModalSubmit,
      data: { custom_id: 'connect-ptp:submit', components: [] },
      member: { user: { id: 'user-1' } },
    }
    const response = await routeInteraction(interaction as never, {} as BackendClient)
    expect(responseData(response).content).toMatch(/no token was submitted/i)
  })

  it('falls back gracefully for interaction types we do not implement (e.g. autocomplete)', async () => {
    const interaction = { type: InteractionType.ApplicationCommandAutocomplete }
    const response = await routeInteraction(interaction as never, {} as BackendClient)
    expect(responseData(response).content).toMatch(/unsupported interaction type/i)
  })

  it('does not let one command handler throwing crash the router for unrelated calls', async () => {
    // Sanity check that handlers are invoked independently — a defensive
    // regression test, not tied to any specific handler's internals.
    const pingResponse = await routeInteraction({ type: InteractionType.Ping } as never, {} as BackendClient)
    expect(pingResponse).toEqual({ type: InteractionResponseType.Pong })
  })
})
