import { describe, expect, it, vi } from 'vitest'
import { ApplicationCommandOptionType, ComponentType } from 'discord-api-types/v10'
import { startPod } from './startPod.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { responseData } from '../testUtils/responseData.js'

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
    const listEligibleGuildsMock = vi
      .fn()
      .mockResolvedValue([{ guildId: 'g1', name: 'Alpha' }, { guildId: 'g2', name: 'Beta' }])
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

    expect(listEligibleGuildsMock).toHaveBeenCalledWith('organizer-1')
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
    const listEligibleGuildsMock = vi.fn().mockResolvedValue([{ guildId: 'g1', name: 'Alpha' }])
    const ctx = {
      interaction: makeInteraction(),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
    } as unknown as CommandContext

    const response = await startPod(ctx)

    expect(selectComponent(response).custom_id).toBe('start-pod:select-guilds:JTL:8')
    expect(responseData(response).content).toContain('threshold 8')
  })

  it('falls back to interaction.user.id when there is no member (e.g. DM context)', async () => {
    const listEligibleGuildsMock = vi.fn().mockResolvedValue([{ guildId: 'g1', name: 'Alpha' }])
    const ctx = {
      interaction: makeInteraction({ member: undefined, user: { id: 'dm-organizer' } }),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
    } as unknown as CommandContext

    await startPod(ctx)

    expect(listEligibleGuildsMock).toHaveBeenCalledWith('dm-organizer')
  })

  it('rejects when neither member nor user is present on the interaction', async () => {
    const listEligibleGuildsMock = vi.fn()
    const ctx = {
      interaction: makeInteraction({ member: undefined }),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
    } as unknown as CommandContext

    const response = await startPod(ctx)

    expect(listEligibleGuildsMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
  })

  it('rejects when no set option is provided', async () => {
    const listEligibleGuildsMock = vi.fn()
    const ctx = {
      interaction: makeInteraction({ data: { options: [] } }),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
    } as unknown as CommandContext

    const response = await startPod(ctx)

    expect(listEligibleGuildsMock).not.toHaveBeenCalled()
    expect(responseData(response).content).toMatch(/set code is required/i)
  })

  it('tells the organizer plainly when they have no eligible guilds yet', async () => {
    const listEligibleGuildsMock = vi.fn().mockResolvedValue([])
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
    const listEligibleGuildsMock = vi.fn().mockResolvedValue(manyGuilds)
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
