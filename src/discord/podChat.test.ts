import { describe, expect, it, vi } from 'vitest'
import { OverwriteType, PermissionFlagsBits, type RESTPostAPIGuildChannelJSONBody } from 'discord-api-types/v10'
import { createPodChatSpace, postPodChatWelcomeMessage } from './podChat.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { stub } from '../testUtils/stub.js'
import type { DiscordRestClient } from './rest.js'

describe('createPodChatSpace', () => {
  it('creates a private channel with overwrites for @everyone-deny + organizer + every signup, and returns the channel id + invite URL', async () => {
    const createChannel = stub<Parameters<DiscordRestClient['createChannel']>, ReturnType<DiscordRestClient['createChannel']>>(
      async () => ({ id: 'channel-1' }) as never
    )
    const createInvite = stub<Parameters<DiscordRestClient['createInvite']>, ReturnType<DiscordRestClient['createInvite']>>(
      async () => ({ code: 'abc123' }) as never
    )
    const discordRest = createFakeDiscordRest({ createChannel, createInvite })

    const result = await createPodChatSpace(
      discordRest,
      {
        setCode: 'JTL',
        originGuildId: 'guild-1',
        organizerDiscordId: 'organizer-1',
        signupDiscordIds: ['player-1', 'player-2'],
      },
      vi.fn()
    )

    expect(result).toEqual({ channelId: 'channel-1', inviteUrl: 'https://discord.com/invite/abc123' })

    expect(createChannel.calls).toHaveLength(1)
    const [guildId, body] = createChannel.calls[0]
    expect(guildId).toBe('guild-1')

    const overwrites = (body as RESTPostAPIGuildChannelJSONBody & {
      permission_overwrites: { id: string; type: number; allow: string; deny: string }[]
    }).permission_overwrites

    const everyoneOverwrite = overwrites.find((o) => o.id === 'guild-1')
    expect(everyoneOverwrite).toBeDefined()
    expect(everyoneOverwrite?.type).toBe(OverwriteType.Role)
    expect(BigInt(everyoneOverwrite?.deny ?? '0') & PermissionFlagsBits.ViewChannel).toBe(
      PermissionFlagsBits.ViewChannel
    )

    for (const id of ['organizer-1', 'player-1', 'player-2']) {
      const overwrite = overwrites.find((o) => o.id === id)
      expect(overwrite, `expected an overwrite for ${id}`).toBeDefined()
      expect(overwrite?.type).toBe(OverwriteType.Member)
      expect(BigInt(overwrite?.allow ?? '0') & PermissionFlagsBits.ViewChannel).toBe(PermissionFlagsBits.ViewChannel)
      expect(BigInt(overwrite?.allow ?? '0') & PermissionFlagsBits.SendMessages).toBe(
        PermissionFlagsBits.SendMessages
      )
    }

    expect(createInvite.calls).toEqual([['channel-1']])
  })

  it('dedupes the organizer if they also appear in signupDiscordIds', async () => {
    const createChannel = stub<Parameters<DiscordRestClient['createChannel']>, ReturnType<DiscordRestClient['createChannel']>>(
      async () => ({ id: 'channel-1' }) as never
    )
    const createInvite = stub<Parameters<DiscordRestClient['createInvite']>, ReturnType<DiscordRestClient['createInvite']>>(
      async () => ({ code: 'abc123' }) as never
    )
    const discordRest = createFakeDiscordRest({ createChannel, createInvite })

    await createPodChatSpace(
      discordRest,
      {
        setCode: 'JTL',
        originGuildId: 'guild-1',
        organizerDiscordId: 'organizer-1',
        signupDiscordIds: ['organizer-1', 'player-1'],
      },
      vi.fn()
    )

    const [, body] = createChannel.calls[0]
    const overwrites = (body as RESTPostAPIGuildChannelJSONBody & { permission_overwrites: { id: string }[] })
      .permission_overwrites
    const memberOverwrites = overwrites.filter((o) => o.id !== 'guild-1')
    expect(memberOverwrites).toHaveLength(2)
  })

  it('returns undefined and logs, never throwing, when createChannel rejects', async () => {
    const discordRest = createFakeDiscordRest({
      createChannel: async () => {
        throw new Error('missing Manage Channels permission')
      },
    })
    const log = vi.fn()

    const result = await createPodChatSpace(
      discordRest,
      { setCode: 'JTL', originGuildId: 'guild-1', organizerDiscordId: 'organizer-1', signupDiscordIds: [] },
      log
    )

    expect(result).toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][1]).toBe('failed to create pod chat channel')
  })

  it('returns undefined and logs, never throwing, when createInvite rejects', async () => {
    const discordRest = createFakeDiscordRest({
      createChannel: async () => ({ id: 'channel-1' }) as never,
      createInvite: async () => {
        throw new Error('bot no longer in guild')
      },
    })
    const log = vi.fn()

    const result = await createPodChatSpace(
      discordRest,
      { setCode: 'JTL', originGuildId: 'guild-1', organizerDiscordId: 'organizer-1', signupDiscordIds: ['player-1'] },
      log
    )

    expect(result).toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('postPodChatWelcomeMessage', () => {
  it('posts to the right channel with every mention and the share URL present in the content', async () => {
    const postMessage = stub<Parameters<DiscordRestClient['postMessage']>, ReturnType<DiscordRestClient['postMessage']>>(
      async () => ({}) as never
    )
    const discordRest = createFakeDiscordRest({ postMessage })

    await postPodChatWelcomeMessage(
      discordRest,
      'channel-1',
      { shareUrl: 'https://www.protectthepod.com/draft/share-1', signupDiscordIds: ['player-1', 'player-2'] },
      vi.fn()
    )

    expect(postMessage.calls).toHaveLength(1)
    const [channelId, body] = postMessage.calls[0]
    expect(channelId).toBe('channel-1')
    const content = (body as { content: string }).content
    expect(content).toContain('<@player-1>')
    expect(content).toContain('<@player-2>')
    expect(content).toContain('https://www.protectthepod.com/draft/share-1')
  })

  it('still posts sensibly (no stray leading whitespace) with an empty signupDiscordIds array', async () => {
    const postMessage = stub<Parameters<DiscordRestClient['postMessage']>, ReturnType<DiscordRestClient['postMessage']>>(
      async () => ({}) as never
    )
    const discordRest = createFakeDiscordRest({ postMessage })

    await postPodChatWelcomeMessage(
      discordRest,
      'channel-1',
      { shareUrl: 'https://www.protectthepod.com/draft/share-1', signupDiscordIds: [] },
      vi.fn()
    )

    expect(postMessage.calls).toHaveLength(1)
    const content = (postMessage.calls[0][1] as { content: string }).content
    expect(content).toContain('https://www.protectthepod.com/draft/share-1')
    expect(content).not.toMatch(/^\s/)
    expect(content).not.toContain('<@')
  })

  it('catches and logs (never throws) when postMessage rejects', async () => {
    const discordRest = createFakeDiscordRest({
      postMessage: async () => {
        throw new Error('Missing Access')
      },
    })
    const log = vi.fn()

    await expect(
      postPodChatWelcomeMessage(
        discordRest,
        'channel-1',
        { shareUrl: 'https://www.protectthepod.com/draft/share-1', signupDiscordIds: ['player-1'] },
        log
      )
    ).resolves.toBeUndefined()

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][1]).toBe('failed to post pod chat welcome message')
  })
})
