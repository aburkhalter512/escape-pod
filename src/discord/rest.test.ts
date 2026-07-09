import { describe, expect, it, vi } from 'vitest'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { editMessage, postMessage } from './rest.js'

describe('postMessage', () => {
  it('POSTs to the channel messages route with the given body', async () => {
    const post = vi.fn().mockResolvedValue({ id: 'msg-1' })
    const rest = createFakeDiscordRest({ post })

    const result = await postMessage(rest, 'channel-1', { content: 'hello' })

    expect(post).toHaveBeenCalledWith('/channels/channel-1/messages', { body: { content: 'hello' } })
    expect(result).toEqual({ id: 'msg-1' })
  })
})

describe('editMessage', () => {
  it('PATCHes the specific message route with the given body', async () => {
    const patch = vi.fn().mockResolvedValue({ id: 'msg-1', content: 'updated' })
    const rest = createFakeDiscordRest({ patch })

    const result = await editMessage(rest, 'channel-1', 'msg-1', { content: 'updated' })

    expect(patch).toHaveBeenCalledWith('/channels/channel-1/messages/msg-1', {
      body: { content: 'updated' },
    })
    expect(result).toEqual({ id: 'msg-1', content: 'updated' })
  })
})
