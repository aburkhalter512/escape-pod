import { describe, expect, it, vi } from 'vitest'
import { notifyPlayersByDm } from './dmSignups.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { stub } from '../testUtils/stub.js'
import type { PodRoundMessageBody } from './podMessage.js'

const body: PodRoundMessageBody = {
  embeds: [{ title: 'JTL Draft Pod — Starting!' }],
  components: [],
}

describe('notifyPlayersByDm', () => {
  it('opens a DM channel with every recipient and posts the given body into it', async () => {
    const createDmChannel = stub(async (userId: string) => ({ id: `dm-${userId}` }) as never)
    const postMessage = stub(async () => ({}) as never)
    const discordRest = createFakeDiscordRest({
      createDmChannel: createDmChannel as never,
      postMessage: postMessage as never,
    })

    await notifyPlayersByDm(discordRest, ['player-1', 'player-2'], body, vi.fn())

    expect(createDmChannel.calls).toEqual([['player-1'], ['player-2']])
    expect(postMessage.calls).toEqual([
      ['dm-player-1', { embeds: body.embeds, components: body.components }],
      ['dm-player-2', { embeds: body.embeds, components: body.components }],
    ])
  })

  it("one recipient's createDmChannel failure does not stop the others from being attempted, and never throws", async () => {
    const createDmChannel = stub(async (userId: string) => {
      if (userId === 'player-2') throw new Error('DMs disabled')
      return { id: `dm-${userId}` } as never
    })
    const postMessage = stub(async () => ({}) as never)
    const discordRest = createFakeDiscordRest({
      createDmChannel: createDmChannel as never,
      postMessage: postMessage as never,
    })
    const log = vi.fn()

    await expect(
      notifyPlayersByDm(discordRest, ['player-1', 'player-2', 'player-3'], body, log)
    ).resolves.toBeUndefined()

    expect(createDmChannel.calls).toEqual([['player-1'], ['player-2'], ['player-3']])
    expect(postMessage.calls).toEqual([
      ['dm-player-1', { embeds: body.embeds, components: body.components }],
      ['dm-player-3', { embeds: body.embeds, components: body.components }],
    ])
  })

  it("one recipient's postMessage failure does not stop the others, and every failure is logged individually", async () => {
    const createDmChannel = stub(async (userId: string) => ({ id: `dm-${userId}` }) as never)
    const postMessage = stub(async (channelId: string) => {
      if (channelId === 'dm-player-1') throw new Error('blocked the bot')
      return {} as never
    })
    const discordRest = createFakeDiscordRest({
      createDmChannel: createDmChannel as never,
      postMessage: postMessage as never,
    })
    const log = vi.fn()

    await notifyPlayersByDm(discordRest, ['player-1', 'player-2'], body, log)

    expect(postMessage.calls).toEqual([
      ['dm-player-1', { embeds: body.embeds, components: body.components }],
      ['dm-player-2', { embeds: body.embeds, components: body.components }],
    ])
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][1]).toBe('failed to DM signed-up player')
  })

  it('does nothing (and never throws) for an empty recipient list', async () => {
    const discordRest = createFakeDiscordRest()
    await expect(notifyPlayersByDm(discordRest, [], body, vi.fn())).resolves.toBeUndefined()
  })
})
