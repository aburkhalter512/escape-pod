import { describe, expect, it, vi } from 'vitest'
import type { REST } from '@discordjs/rest'
import { editMessage, postMessage } from './rest.js'

function fakeRest() {
  return { post: vi.fn(), patch: vi.fn() } as unknown as REST & { post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> }
}

describe('postMessage', () => {
  it('POSTs to the channel messages route with the given body', async () => {
    const rest = fakeRest()
    rest.post.mockResolvedValue({ id: 'msg-1' })

    const result = await postMessage(rest, 'channel-1', { content: 'hello' })

    expect(rest.post).toHaveBeenCalledWith('/channels/channel-1/messages', { body: { content: 'hello' } })
    expect(result).toEqual({ id: 'msg-1' })
  })
})

describe('editMessage', () => {
  it('PATCHes the specific message route with the given body', async () => {
    const rest = fakeRest()
    rest.patch.mockResolvedValue({ id: 'msg-1', content: 'updated' })

    const result = await editMessage(rest, 'channel-1', 'msg-1', { content: 'updated' })

    expect(rest.patch).toHaveBeenCalledWith('/channels/channel-1/messages/msg-1', {
      body: { content: 'updated' },
    })
    expect(result).toEqual({ id: 'msg-1', content: 'updated' })
  })
})
