import { describe, expect, it, vi } from 'vitest'
import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { allowOrganizer } from './allowOrganizer.js'
import type { CommandContext } from './types.js'
import type { BackendClient } from '../backendClient.js'
import { responseData } from '../testUtils/responseData.js'

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    guild_id: 'guild-1',
    member: { user: { id: 'admin-1' } },
    data: {
      options: [{ name: 'organizer', type: ApplicationCommandOptionType.User, value: 'organizer-1' }],
    },
    ...overrides,
  }
}

describe('allowOrganizer', () => {
  it('approves the organizer and mentions them in the confirmation', async () => {
    const allowOrganizerMock = vi.fn().mockResolvedValue(undefined)
    const ctx = {
      interaction: makeInteraction(),
      backend: { allowOrganizer: allowOrganizerMock } as unknown as BackendClient,
    } as unknown as CommandContext

    const response = await allowOrganizer(ctx)

    expect(allowOrganizerMock).toHaveBeenCalledWith('guild-1', 'organizer-1', 'admin-1')
    expect(responseData(response).content).toContain('<@organizer-1>')
  })

  it('rejects when run outside a server', async () => {
    const allowOrganizerMock = vi.fn()
    const ctx = {
      interaction: makeInteraction({ guild_id: undefined }),
      backend: { allowOrganizer: allowOrganizerMock } as unknown as BackendClient,
    } as unknown as CommandContext

    const response = await allowOrganizer(ctx)

    expect(allowOrganizerMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('rejects when no organizer option is provided', async () => {
    const allowOrganizerMock = vi.fn()
    const ctx = {
      interaction: makeInteraction({ data: { options: [] } }),
      backend: { allowOrganizer: allowOrganizerMock } as unknown as BackendClient,
    } as unknown as CommandContext

    const response = await allowOrganizer(ctx)

    expect(allowOrganizerMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/organizer to approve is required/i)
  })

  it('rejects when the organizer option has an unexpected type', async () => {
    const allowOrganizerMock = vi.fn()
    const ctx = {
      interaction: makeInteraction({
        data: { options: [{ name: 'organizer', type: ApplicationCommandOptionType.String, value: 'oops' }] },
      }),
      backend: { allowOrganizer: allowOrganizerMock } as unknown as BackendClient,
    } as unknown as CommandContext

    const response = await allowOrganizer(ctx)

    expect(allowOrganizerMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/organizer to approve is required/i)
  })
})
