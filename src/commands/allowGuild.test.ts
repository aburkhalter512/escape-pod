import { describe, expect, it } from 'vitest'
import {
  ApplicationCommandOptionType,
  ChannelType,
  ComponentType,
  type APIInteractionGuildMember,
  type RESTGetAPIGuildResult,
} from 'discord-api-types/v10'
import { allowGuild } from './allowGuild.js'
import type { CommandContext } from './types.js'
import { createFakeBackendClient } from '../testUtils/fakeBackendClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { fakeChatInputInteraction, fakeMember } from '../testUtils/fakeInteraction.js'
import { responseData } from '../testUtils/responseData.js'
import { stub } from '../testUtils/stub.js'

// Discord's own type guarantees member.user is always present — this
// simulates the malformed payload that guarantee rules out, mirroring
// allowOrganizer.test.ts's same check.
function memberWithoutUser(): APIInteractionGuildMember {
  return { ...fakeMember(), user: undefined } as unknown as APIInteractionGuildMember
}

function interaction(overrides: Parameters<typeof fakeChatInputInteraction>[0] = {}) {
  return fakeChatInputInteraction({
    options: [{ name: 'origin-server-id', type: ApplicationCommandOptionType.String, value: '123456789012345678' }],
    ...overrides,
  })
}

describe('allowGuild', () => {
  it('trusts the origin guild and echoes its resolved name in the confirmation', async () => {
    const allowGuildMock = stub(async (guildId: string, allowedOriginGuildId: string, approvedBy: string) => {
      if (guildId !== 'guild-1' || allowedOriginGuildId !== '123456789012345678' || approvedBy !== 'user-1') {
        throw new Error(`unexpected allowGuild args: ${guildId} ${allowedOriginGuildId} ${approvedBy}`)
      }
      return { ok: true as const, value: undefined }
    })
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ allowGuild: allowGuildMock }),
      discordRest: createFakeDiscordRest({
        getGuild: stub(async (guildId: string) => {
          if (guildId !== '123456789012345678') throw new Error(`unexpected getGuild id: ${guildId}`)
          return { name: 'The Other Server' } as RESTGetAPIGuildResult
        }),
      }),
    }

    const response = await allowGuild(ctx)

    expect(responseData(response).content).toContain('**The Other Server**')
    expect(allowGuildMock.calls).toHaveLength(1)
  })

  it('falls back to the raw ID when the bot cannot resolve the origin guild (not a member of it)', async () => {
    const allowGuildMock = stub(async (_guildId: string, _allowedOriginGuildId: string, _approvedBy: string) => ({
      ok: true as const,
      value: undefined,
    }))
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ allowGuild: allowGuildMock }),
      discordRest: createFakeDiscordRest({
        getGuild: stub(async (_guildId: string) => {
          throw new Error('bot is not a member of that guild')
        }),
      }),
    }

    const response = await allowGuild(ctx)

    expect(responseData(response).content).toContain('**123456789012345678**')
    expect(allowGuildMock.calls).toHaveLength(1)
  })

  it('rejects when run outside a server', async () => {
    const allowGuildMock = stub(async (_guildId: string, _allowedOriginGuildId: string, _approvedBy: string) => {
      throw new Error('allowGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ guild_id: undefined, member: undefined }),
      backend: createFakeBackendClient({ allowGuild: allowGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowGuild(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('degrades to the same response (not a thrown error) when member is present but member.user is missing', async () => {
    const allowGuildMock = stub(async (_guildId: string, _allowedOriginGuildId: string, _approvedBy: string) => {
      throw new Error('allowGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ member: memberWithoutUser() }),
      backend: createFakeBackendClient({ allowGuild: allowGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowGuild(ctx)

    expect(responseData(response).content).toMatch(/must be run in a server/i)
  })

  it('rejects when no origin-server-id option is provided', async () => {
    const allowGuildMock = stub(async (_guildId: string, _allowedOriginGuildId: string, _approvedBy: string) => {
      throw new Error('allowGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({ options: [] }),
      backend: createFakeBackendClient({ allowGuild: allowGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowGuild(ctx)

    expect(responseData(response).content).toMatch(/origin server id is required/i)
  })

  it('rejects when the origin-server-id option has an unexpected type', async () => {
    const allowGuildMock = stub(async (_guildId: string, _allowedOriginGuildId: string, _approvedBy: string) => {
      throw new Error('allowGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({
        options: [{ name: 'origin-server-id', type: ApplicationCommandOptionType.User, value: 'oops' }],
      }),
      backend: createFakeBackendClient({ allowGuild: allowGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowGuild(ctx)

    expect(responseData(response).content).toMatch(/origin server id is required/i)
  })

  it('rejects a non-snowflake origin-server-id without calling the backend', async () => {
    const allowGuildMock = stub(async (_guildId: string, _allowedOriginGuildId: string, _approvedBy: string) => {
      throw new Error('allowGuild should not have been called')
    })
    const ctx: CommandContext = {
      interaction: interaction({
        options: [{ name: 'origin-server-id', type: ApplicationCommandOptionType.String, value: 'not-a-snowflake' }],
      }),
      backend: createFakeBackendClient({ allowGuild: allowGuildMock }),
      discordRest: createFakeDiscordRest(),
    }

    const response = await allowGuild(ctx)

    expect(responseData(response).content).toMatch(/doesn't look like a valid discord server id/i)
    expect(allowGuildMock.calls).toHaveLength(0)
  })

  it('trims surrounding whitespace on the origin-server-id before validating', async () => {
    const allowGuildMock = stub(async (_guildId: string, allowedOriginGuildId: string, _approvedBy: string) => {
      if (allowedOriginGuildId !== '123456789012345678') {
        throw new Error(`unexpected allowedOriginGuildId: ${allowedOriginGuildId}`)
      }
      return { ok: true as const, value: undefined }
    })
    const ctx: CommandContext = {
      interaction: interaction({
        options: [{ name: 'origin-server-id', type: ApplicationCommandOptionType.String, value: '  123456789012345678  ' }],
      }),
      backend: createFakeBackendClient({ allowGuild: allowGuildMock }),
      discordRest: createFakeDiscordRest({ getGuild: stub(async () => ({ name: 'x' }) as RESTGetAPIGuildResult) }),
    }

    const response = await allowGuild(ctx)

    expect(responseData(response).content).toContain('can now post')
    expect(allowGuildMock.calls).toHaveLength(1)
  })

  it("offers a live channel picker instead of a dead-end error when this server hasn't run /escape-pod-setup, without resolving the origin guild's name yet", async () => {
    const allowGuildMock = stub(async (_guildId: string, _allowedOriginGuildId: string, _approvedBy: string) => ({
      ok: false as const,
      error: { kind: 'validation' as const, message: 'This server needs to run /escape-pod-setup before it can trust other servers.' },
    }))
    const getGuild = stub(async (_guildId: string) => {
      throw new Error('getGuild should not have been called when allowGuild fails')
    })
    const ctx: CommandContext = {
      interaction: interaction(),
      backend: createFakeBackendClient({ allowGuild: allowGuildMock }),
      discordRest: createFakeDiscordRest({ getGuild }),
    }

    const response = await allowGuild(ctx)

    expect(responseData(response).content).toContain('This server needs to run /escape-pod-setup before it can trust other servers.')
    expect(getGuild.calls).toHaveLength(0)
    expect(responseData(response).components).toEqual([
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.ChannelSelect,
            custom_id: 'allow-guild:select-channel:123456789012345678',
            channel_types: [ChannelType.GuildText],
            placeholder: expect.any(String),
          },
        ],
      },
    ])
  })
})
