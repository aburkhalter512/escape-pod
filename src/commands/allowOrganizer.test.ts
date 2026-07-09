import { describe, expect, it } from 'vitest'
import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { allowOrganizer } from './allowOrganizer.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'

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
    const allowOrganizerMock = stub(async (guildId: string, organizerDiscordId: string, approvedBy: string) => {
      if (guildId !== 'guild-1' || organizerDiscordId !== 'organizer-1' || approvedBy !== 'admin-1') {
        throw new Error(`unexpected allowOrganizer args: ${guildId} ${organizerDiscordId} ${approvedBy}`)
      }
    })
    const ctx = {
      interaction: makeInteraction(),
      backend: createFakeBackendClient({ allowOrganizer: allowOrganizerMock }),
    } as unknown as CommandContext

    const response = await allowOrganizer(ctx)

    expect(responseData(response).content).toContain('<@organizer-1>')
  })

  it('rejects when run outside a server', async () => {
    const allowOrganizerMock = stub(async (_guildId: string, _organizerDiscordId: string, _approvedBy: string) => {
      throw new Error('allowOrganizer should not have been called')
    })
    const ctx = {
      interaction: makeInteraction({ guild_id: undefined }),
      backend: createFakeBackendClient({ allowOrganizer: allowOrganizerMock }),
    } as unknown as CommandContext

    const response = await allowOrganizer(ctx)

    expect(allowOrganizerMock.calls).toHaveLength(0)
    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('rejects when no organizer option is provided', async () => {
    const allowOrganizerMock = stub(async (_guildId: string, _organizerDiscordId: string, _approvedBy: string) => {
      throw new Error('allowOrganizer should not have been called')
    })
    const ctx = {
      interaction: makeInteraction({ data: { options: [] } }),
      backend: createFakeBackendClient({ allowOrganizer: allowOrganizerMock }),
    } as unknown as CommandContext

    const response = await allowOrganizer(ctx)

    expect(allowOrganizerMock.calls).toHaveLength(0)
    expect(responseData(response).content).toMatch(/organizer to approve is required/i)
  })

  it('rejects when the organizer option has an unexpected type', async () => {
    const allowOrganizerMock = stub(async (_guildId: string, _organizerDiscordId: string, _approvedBy: string) => {
      throw new Error('allowOrganizer should not have been called')
    })
    const ctx = {
      interaction: makeInteraction({
        data: { options: [{ name: 'organizer', type: ApplicationCommandOptionType.String, value: 'oops' }] },
      }),
      backend: createFakeBackendClient({ allowOrganizer: allowOrganizerMock }),
    } as unknown as CommandContext

    const response = await allowOrganizer(ctx)

    expect(allowOrganizerMock.calls).toHaveLength(0)
    expect(responseData(response).content).toMatch(/organizer to approve is required/i)
  })
})
