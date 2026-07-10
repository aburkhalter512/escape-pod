import { describe, expect, it } from 'vitest'
import { ApplicationCommandOptionType, type APIInteractionGuildMember } from 'discord-api-types/v10'
import { allowOrganizer } from './allowOrganizer.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction, fakeMember } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'

// Discord's own type guarantees member.user is always present — this
// simulates the malformed payload that guarantee rules out, to prove the
// `?.` in allowOrganizer.ts actually degrades gracefully instead of
// throwing a TypeError (tasks/004).
function memberWithoutUser(): APIInteractionGuildMember {
  return { ...fakeMember(), user: undefined } as unknown as APIInteractionGuildMember
}

function interaction(overrides: Parameters<typeof fakeChatInputInteraction>[0] = {}) {
  return fakeChatInputInteraction({
    options: [{ name: 'organizer', type: ApplicationCommandOptionType.User, value: 'organizer-1' }],
    ...overrides,
  })
}

describe('allowOrganizer', () => {
  it('approves the organizer and mentions them in the confirmation', async () => {
    const allowOrganizerMock = stub(async (guildId: string, organizerDiscordId: string, approvedBy: string) => {
      if (guildId !== 'guild-1' || organizerDiscordId !== 'organizer-1' || approvedBy !== 'user-1') {
        throw new Error(`unexpected allowOrganizer args: ${guildId} ${organizerDiscordId} ${approvedBy}`)
      }
    })
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ allowOrganizer: allowOrganizerMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowOrganizer(ctx)

    expect(responseData(response).content).toContain('<@organizer-1>')
  })

  it('rejects when run outside a server', async () => {
    const allowOrganizerMock = stub(async (_guildId: string, _organizerDiscordId: string, _approvedBy: string) => {
      throw new Error('allowOrganizer should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ guild_id: undefined, member: undefined }),
      backend: createFakeBackendClient({ allowOrganizer: allowOrganizerMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowOrganizer(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('degrades to the same response (not a thrown error) when member is present but member.user is missing', async () => {
    const allowOrganizerMock = stub(async (_guildId: string, _organizerDiscordId: string, _approvedBy: string) => {
      throw new Error('allowOrganizer should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ member: memberWithoutUser() }),
      backend: createFakeBackendClient({ allowOrganizer: allowOrganizerMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowOrganizer(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('rejects when no organizer option is provided', async () => {
    const allowOrganizerMock = stub(async (_guildId: string, _organizerDiscordId: string, _approvedBy: string) => {
      throw new Error('allowOrganizer should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ options: [] }),
      backend: createFakeBackendClient({ allowOrganizer: allowOrganizerMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowOrganizer(ctx)

    expect(responseData(response).content).toMatch(/organizer to approve is required/i)
  })

  it('rejects when the organizer option has an unexpected type', async () => {
    const allowOrganizerMock = stub(async (_guildId: string, _organizerDiscordId: string, _approvedBy: string) => {
      throw new Error('allowOrganizer should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({
        options: [{ name: 'organizer', type: ApplicationCommandOptionType.String, value: 'oops' }],
      }),
      backend: createFakeBackendClient({ allowOrganizer: allowOrganizerMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowOrganizer(ctx)

    expect(responseData(response).content).toMatch(/organizer to approve is required/i)
  })
})
