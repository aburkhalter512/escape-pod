import { describe, expect, it } from 'vitest'
import { HttpDiscordRest } from './rest.js'
import { stub } from '../testUtils/stub.js'

describe('HttpDiscordRest.postMessage', () => {
  it('POSTs to the channel messages route with the given body', async () => {
    const post = stub(async (_route: string, _options?: unknown) => ({ id: 'msg-1' }))
    const rest = new HttpDiscordRest({ post, patch: stub(async () => ({})) })

    const result = await rest.postMessage('channel-1', { content: 'hello' })

    expect(post.calls[0]).toEqual(['/channels/channel-1/messages', { body: { content: 'hello' } }])
    expect(result).toEqual({ id: 'msg-1' })
  })
})

describe('HttpDiscordRest.editMessage', () => {
  it('PATCHes the specific message route with the given body', async () => {
    const patch = stub(async (_route: string, _options?: unknown) => ({ id: 'msg-1', content: 'updated' }))
    const rest = new HttpDiscordRest({ post: stub(async () => ({})), patch })

    const result = await rest.editMessage('channel-1', 'msg-1', { content: 'updated' })

    expect(patch.calls[0]).toEqual(['/channels/channel-1/messages/msg-1', { body: { content: 'updated' } }])
    expect(result).toEqual({ id: 'msg-1', content: 'updated' })
  })
})
