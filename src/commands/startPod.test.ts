import { describe, expect, it } from 'vitest'
import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { startPod } from './startPod.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction, fakeMember, fakeUser } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'

function interaction(overrides: Parameters<typeof fakeChatInputInteraction>[0] = {}) {
  return fakeChatInputInteraction({
    member: fakeMember({ user: fakeUser({ id: 'organizer-1' }) }),
    options: [{ name: 'set', type: ApplicationCommandOptionType.String, value: 'JTL' }],
    ...overrides,
  })
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

// Resolves guild names live (INTEGRATIONS.md — names aren't stored, since
// a cached one would go stale on rename), keyed by a plain guildId->name
// map so tests can describe the guilds they care about without touching
// the real Discord API shape beyond {id, name}.
function fakeGetGuild(names: Record<string, string>) {
  return stub(async (guildId: string) => {
    const name = names[guildId]
    if (name === undefined) throw new Error(`unexpected getGuild call: ${guildId}`)
    return { id: guildId, name } as never
  })
}

describe('startPod', () => {
  it('presents eligible guilds as a select menu, packing set+threshold into custom_id', async () => {
    const listEligibleGuildsMock = stub(async (organizerDiscordId: string) => {
      if (organizerDiscordId !== 'organizer-1') throw new Error(`unexpected organizerDiscordId: ${organizerDiscordId}`)
      return [{ guildId: 'g1' }, { guildId: 'g2' }]
    })
    const ctx: CommandContext = {
      interaction: interaction({
        options: [
          { name: 'set', type: ApplicationCommandOptionType.String, value: 'JTL' },
          { name: 'threshold', type: ApplicationCommandOptionType.Integer, value: 7 },
        ],
      }),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
      discordRest: createFakeDiscordRest({ getGuild: fakeGetGuild({ g1: 'Alpha', g2: 'Beta' }) }),
    }

    const response = await startPod(ctx)

    const select = selectComponent(response)
    expect(select.custom_id).toBe('start-pod:select-guilds:JTL:7:')
    expect(select.options).toEqual([
      { label: 'Alpha', value: 'g1' },
      { label: 'Beta', value: 'g2' },
    ])
    expect(select.min_values).toBe(1)
    expect(select.max_values).toBe(2)
  })

  it('falls back to the raw guildId as the label when a name lookup fails', async () => {
    const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => [{ guildId: 'g1' }, { guildId: 'g2' }])
    const getGuild = stub(async (guildId: string) => {
      if (guildId === 'g2') throw new Error('bot is no longer in this guild')
      return { id: guildId, name: 'Alpha' } as never
    })
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
      discordRest: createFakeDiscordRest({ getGuild }),
    }

    const response = await startPod(ctx)

    expect(selectComponent(response).options).toEqual([
      { label: 'Alpha', value: 'g1' },
      { label: 'g2', value: 'g2' },
    ])
  })

  it('defaults the threshold to 8 when not provided', async () => {
    const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => [{ guildId: 'g1' }])
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
      discordRest: createFakeDiscordRest({ getGuild: fakeGetGuild({ g1: 'Alpha' }) }),
    }

    const response = await startPod(ctx)

    expect(selectComponent(response).custom_id).toBe('start-pod:select-guilds:JTL:8:')
    expect(responseData(response).content).toContain('min 8')
  })

  it('falls back to interaction.user.id when there is no member (e.g. DM context)', async () => {
    const listEligibleGuildsMock = stub(async (organizerDiscordId: string) => {
      if (organizerDiscordId !== 'dm-organizer') throw new Error(`unexpected organizerDiscordId: ${organizerDiscordId}`)
      return [{ guildId: 'g1' }]
    })
    const ctx: CommandContext = {
      interaction: interaction({
        guild_id: undefined,
        member: undefined,
        user: fakeUser({ id: 'dm-organizer' }),
      }),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
      discordRest: createFakeDiscordRest({ getGuild: fakeGetGuild({ g1: 'Alpha' }) }),
    }

    const response = await startPod(ctx)

    expect(selectComponent(response).custom_id).toBe('start-pod:select-guilds:JTL:8:')
  })

  it('rejects when neither member nor user is present on the interaction', async () => {
    const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => {
      throw new Error('listEligibleGuilds should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ guild_id: undefined, member: undefined }),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await startPod(ctx)

    expect(responseData(response).content).toMatch(/could not determine your discord user id/i)
  })

  it('rejects when no set option is provided', async () => {
    const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => {
      throw new Error('listEligibleGuilds should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ options: [] }),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await startPod(ctx)

    expect(responseData(response).content).toMatch(/set code is required/i)
  })

  it('tells the organizer plainly when they have no eligible guilds yet', async () => {
    const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => [])
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await startPod(ctx)

    expect(responseData(response).components).toBeUndefined()
    expect(responseData(response).content).toMatch(/not approved to post/i)
  })

  it('caps the select menu at 25 options even when more guilds are eligible (Discord limit), and only resolves names for the ones that fit', async () => {
    const manyGuilds = Array.from({ length: 30 }, (_, i) => ({ guildId: `g${i}` }))
    const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => manyGuilds)
    const names = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`g${i}`, `Guild ${i}`]))
    const getGuild = stub(async (guildId: string) => {
      if (!(guildId in names)) throw new Error(`unexpected getGuild call: ${guildId}`)
      return { id: guildId, name: names[guildId] } as never
    })
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
      discordRest: createFakeDiscordRest({ getGuild }),
    }

    const response = await startPod(ctx)
    const select = selectComponent(response)

    expect(select.options).toHaveLength(25)
    expect(select.max_values).toBe(25)
    expect(getGuild.calls).toHaveLength(25) // never looked up guilds 25-29, which wouldn't fit anyway
  })

  describe('deadline option', () => {
    it('packs a valid deadline as an absolute epoch-seconds timestamp into the custom_id', async () => {
      const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => [{ guildId: 'g1' }])
      const ctx: CommandContext = {
        interaction: interaction({
          options: [
            { name: 'set', type: ApplicationCommandOptionType.String, value: 'JTL' },
            { name: 'deadline', type: ApplicationCommandOptionType.String, value: '2h' },
          ],
        }),
        backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
        discordRest: createFakeDiscordRest({ getGuild: fakeGetGuild({ g1: 'Alpha' }) }),
      }

      const before = Math.floor((Date.now() + 2 * 60 * 60_000) / 1000)
      const response = await startPod(ctx)
      const after = Math.floor((Date.now() + 2 * 60 * 60_000) / 1000)

      const [, , , , deadlineStr] = selectComponent(response).custom_id.split(':')
      const deadline = Number.parseInt(deadlineStr, 10)
      expect(deadline).toBeGreaterThanOrEqual(before)
      expect(deadline).toBeLessThanOrEqual(after)
      expect(responseData(response).content).toContain(`<t:${deadline}:R>`)
    })

    it('rejects an unparseable deadline before ever calling the backend', async () => {
      const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => {
        throw new Error('listEligibleGuilds should not have been called')
      })
      const ctx: CommandContext = {
        interaction: interaction({
          options: [
            { name: 'set', type: ApplicationCommandOptionType.String, value: 'JTL' },
            { name: 'deadline', type: ApplicationCommandOptionType.String, value: 'tomorrow' },
          ],
        }),
        backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
        discordRest: createFakeDiscordRest(),
      }

      const response = await startPod(ctx)

      expect(responseData(response).content).toMatch(/couldn't understand that deadline/i)
    })

    it('rejects a deadline under the 5-minute minimum', async () => {
      const ctx: CommandContext = {
        interaction: interaction({
          options: [
            { name: 'set', type: ApplicationCommandOptionType.String, value: 'JTL' },
            { name: 'deadline', type: ApplicationCommandOptionType.String, value: '4m' },
          ],
        }),
        backend: createFakeBackendClient(),
        discordRest: createFakeDiscordRest(),
      }

      const response = await startPod(ctx)

      expect(responseData(response).content).toMatch(/at least 5 minutes/i)
    })

    it('rejects a deadline over the 30-day maximum', async () => {
      const ctx: CommandContext = {
        interaction: interaction({
          options: [
            { name: 'set', type: ApplicationCommandOptionType.String, value: 'JTL' },
            { name: 'deadline', type: ApplicationCommandOptionType.String, value: '31d' },
          ],
        }),
        backend: createFakeBackendClient(),
        discordRest: createFakeDiscordRest(),
      }

      const response = await startPod(ctx)

      expect(responseData(response).content).toMatch(/can't be more than 30 days/i)
    })

    it('omits the deadline entirely when not provided (no trailing content, empty custom_id segment)', async () => {
      const listEligibleGuildsMock = stub(async (_organizerDiscordId: string) => [{ guildId: 'g1' }])
      const ctx: CommandContext = {
        interaction: interaction(),
        backend: createFakeBackendClient({ listEligibleGuilds: listEligibleGuildsMock }),
        discordRest: createFakeDiscordRest({ getGuild: fakeGetGuild({ g1: 'Alpha' }) }),
      }

      const response = await startPod(ctx)

      expect(selectComponent(response).custom_id.split(':')).toHaveLength(5)
      expect(selectComponent(response).custom_id.endsWith(':')).toBe(true)
      expect(responseData(response).content).not.toContain('deadline')
    })
  })
})
