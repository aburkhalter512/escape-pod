import { describe, expect, it } from 'vitest'
import { HttpDiscordRest } from './rest.js'
import { stub } from '../testUtils/stub.js'

describe('HttpDiscordRest.postMessage', () => {
  it('POSTs to the channel messages route with the given body', async () => {
    const post = stub(async (_route: string, _options?: unknown) => ({ id: 'msg-1' }))
    const rest = new HttpDiscordRest({ get: stub(async () => ({})), post, patch: stub(async () => ({})), delete: stub(async () => ({})) }, 'bot-user-id')

    const result = await rest.postMessage('channel-1', { content: 'hello' })

    expect(post.calls[0]).toEqual(['/channels/channel-1/messages', { body: { content: 'hello' } }])
    expect(result).toEqual({ id: 'msg-1' })
  })
})

describe('HttpDiscordRest.editMessage', () => {
  it('PATCHes the specific message route with the given body', async () => {
    const patch = stub(async (_route: string, _options?: unknown) => ({ id: 'msg-1', content: 'updated' }))
    const rest = new HttpDiscordRest({ get: stub(async () => ({})), post: stub(async () => ({})), patch, delete: stub(async () => ({})) }, 'bot-user-id')

    const result = await rest.editMessage('channel-1', 'msg-1', { content: 'updated' })

    expect(patch.calls[0]).toEqual(['/channels/channel-1/messages/msg-1', { body: { content: 'updated' } }])
    expect(result).toEqual({ id: 'msg-1', content: 'updated' })
  })
})

describe('HttpDiscordRest.getGuild', () => {
  it('GETs the specific guild route', async () => {
    const get = stub(async (_route: string, _options?: unknown) => ({ id: 'guild-1', name: 'My Server' }))
    const rest = new HttpDiscordRest({ get, post: stub(async () => ({})), patch: stub(async () => ({})), delete: stub(async () => ({})) }, 'bot-user-id')

    const result = await rest.getGuild('guild-1')

    expect(get.calls[0]).toEqual(['/guilds/guild-1'])
    expect(result).toEqual({ id: 'guild-1', name: 'My Server' })
  })
})

describe('HttpDiscordRest.createChannel', () => {
  it('POSTs to the guild channels route with the given body', async () => {
    const post = stub(async (_route: string, _options?: unknown) => ({ id: 'channel-1' }))
    const rest = new HttpDiscordRest({ get: stub(async () => ({})), post, patch: stub(async () => ({})), delete: stub(async () => ({})) }, 'bot-user-id')

    const result = await rest.createChannel('guild-1', { name: 'pod-chat' })

    expect(post.calls[0]).toEqual(['/guilds/guild-1/channels', { body: { name: 'pod-chat' } }])
    expect(result).toEqual({ id: 'channel-1' })
  })
})

describe('HttpDiscordRest.createInvite', () => {
  it('POSTs to the channel invites route with a 6h max_age', async () => {
    const post = stub(async (_route: string, _options?: unknown) => ({ code: 'abc123' }))
    const rest = new HttpDiscordRest({ get: stub(async () => ({})), post, patch: stub(async () => ({})), delete: stub(async () => ({})) }, 'bot-user-id')

    const result = await rest.createInvite('channel-1')

    expect(post.calls[0]).toEqual(['/channels/channel-1/invites', { body: { max_age: 21600 } }])
    expect(result).toEqual({ code: 'abc123' })
  })
})

describe('HttpDiscordRest.createDmChannel', () => {
  it('POSTs to the current-user channels route with the recipient id', async () => {
    const post = stub(async (_route: string, _options?: unknown) => ({ id: 'dm-1' }))
    const rest = new HttpDiscordRest({ get: stub(async () => ({})), post, patch: stub(async () => ({})), delete: stub(async () => ({})) }, 'bot-user-id')

    const result = await rest.createDmChannel('user-1')

    expect(post.calls[0]).toEqual(['/users/@me/channels', { body: { recipient_id: 'user-1' } }])
    expect(result).toEqual({ id: 'dm-1' })
  })
})

describe('HttpDiscordRest.editOriginalInteractionResponse', () => {
  it('PATCHes the webhook @original message route with the given body, using the interaction token (not the bot token)', async () => {
    const patch = stub(async (_route: string, _options?: unknown) => ({ id: 'msg-1', content: 'followup' }))
    const rest = new HttpDiscordRest({ get: stub(async () => ({})), post: stub(async () => ({})), patch, delete: stub(async () => ({})) }, 'bot-user-id')

    const result = await rest.editOriginalInteractionResponse('app-1', 'interaction-token-1', { content: 'followup' })

    // discord-api-types' Routes helpers URL-encode every path segment that
    // isn't already "URL safe" — `@` isn't, so `@original` comes out as
    // `%40original` here (same as it would in the real outgoing request;
    // Discord's API decodes it back to the literal `@original` route).
    expect(patch.calls[0]).toEqual([
      '/webhooks/app-1/interaction-token-1/messages/%40original',
      { body: { content: 'followup' } },
    ])
    expect(result).toEqual({ id: 'msg-1', content: 'followup' })
  })
})

describe('HttpDiscordRest.deleteChannel', () => {
  it('DELETEs the specific channel route', async () => {
    const del = stub(async (_route: string, _options?: unknown) => ({}))
    const rest = new HttpDiscordRest(
      {
        get: stub(async () => ({})),
        post: stub(async () => ({})),
        patch: stub(async () => ({})),
        delete: del,
      },
      'bot-user-id'
    )

    const result = await rest.deleteChannel('channel-1')

    expect(del.calls[0]).toEqual(['/channels/channel-1'])
    expect(result).toBeUndefined()
  })
})
