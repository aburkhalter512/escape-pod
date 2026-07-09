import { describe, expect, it } from 'vitest'
import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { startPod } from './startPod.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    member: { user: { id: 'organizer-1' } },
    data: {
      options: [{ name: 'set', type: ApplicationCommandOptionType.String, value: 'JTL' }],
    },
    ...overrides,
  }
}

function selectComponent(response: Awaited<ReturnType<typeof startPod>>) {
  const row = responseData(response).components?.[0] as { components: unknown[] }
  return row.components[0] as {
    custom_id: string
    min_values: number
    max_values: number
    options: Array<{ label: string; value: string }>
  }
}

describe('startPod', () => {
  it('presents eligible guilds as a select menu, packing set+threshold into custom_id', async () => {
    const listEligibleGuildsMock = stub(async (organizerDiscordId: string) => {
      if (organizerDiscordId !== 'organizer-1') throw new Error(`unexpected organizerDiscordId: ${organizerDiscordId}`)
      return [{ guildId: 'g1', name: 'Alpha' }, { guildId: 'g2', name: 'Beta' }]
    })
    const ctx = {
      interaction: makeInteraction({
        data: {
          options: [
            { name: 'set', type: ApplicationCommandOptionType.String, value: 'JTL' },
            { name: 'threshold', type: ApplicationCommandOptionType.Integer, value: 7 },
          ],
        },
      }),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
    } as unknown as CommandContext

    const response = await startPod(ctx)

    const select = selectComponent(response)
    expect(select.custom_id).toBe('start-pod:select-guilds:JTL:7')
    expect(select.options).toEqual([
      { label: 'Alpha', value: 'g1' },
      { label: 'Beta', value: 'g2' },
    ])
    expect(select.min_values).toBe(1)
    expect(select.max_values).toBe(2)
  })

  it('defaults the threshold to 8 when not provided', async () => {
    const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => [{ guildId: 'g1', name: 'Alpha' }])
    const ctx = {
      interaction: makeInteraction(),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
    } as unknown as CommandContext

    const response = await startPod(ctx)

    expect(selectComponent(response).custom_id).toBe('start-pod:select-guilds:JTL:8')
    expect(responseData(response).content).toContain('threshold 8')
  })

  it('falls back to interaction.user.id when there is no member (e.g. DM context)', async () => {
    const listEligibleGuildsMock = stub(async (organizerDiscordId: string) => {
      if (organizerDiscordId !== 'dm-organizer') throw new Error(`unexpected organizerDiscordId: ${organizerDiscordId}`)
      return [{ guildId: 'g1', name: 'Alpha' }]
    })
    const ctx = {
      interaction: makeInteraction({ member: undefined, user: { id: 'dm-organizer' } }),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
    } as unknown as CommandContext

    const response = await startPod(ctx)

    expect(selectComponent(response).custom_id).toBe('start-pod:select-guilds:JTL:8')
  })

  it('rejects when neither member nor user is present on the interaction', async () => {
    const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => {
      throw new Error('listEligibleGuilds should not have been called')
    })
    const ctx = {
      interaction: makeInteraction({ member: undefined }),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
    } as unknown as CommandContext

    const response = await startPod(ctx)

    expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
  })

  it('rejects when no set option is provided', async () => {
    const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => {
      throw new Error('listEligibleGuilds should not have been called')
    })
    const ctx = {
      interaction: makeInteraction({ data: { options: [] } }),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
    } as unknown as CommandContext

    const response = await startPod(ctx)

    expect(responseData(response).content).toMatch(/set code is required/i)
  })

  it('tells the organizer plainly when they have no eligible guilds yet', async () => {
    const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => [])
    const ctx = {
      interaction: makeInteraction(),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
    } as unknown as CommandContext

    const response = await startPod(ctx)

    expect(responseData(response).components).toBeUndefined()
    expect(responseData(response).content).toMatch(/not approved to post/i)
  })

  it('caps the select menu at 25 options even when more guilds are eligible (Discord limit)', async () => {
    const manyGuilds = Array.from({ length: 30 }, (_, i) => ({ guildId: `g${i}`, name: `Guild ${i}` }))
    const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => manyGuilds)
    const ctx = {
      interaction: makeInteraction(),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
    } as unknown as CommandContext

    const response = await startPod(ctx)
    const select = selectComponent(response)

    expect(select.options).toHaveLength(25)
    expect(select.max_values).toBe(25)
  })
})
