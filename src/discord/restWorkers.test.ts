import { afterEach, describe, expect, it } from 'vitest'
import { createFetchDiscordRest } from './restWorkers.js'
import { stub } from '../testUtils/stub.js'

// Mirrors rest.test.ts's per-method assertions exactly (same routes, same
// bodies) — the only thing that changed is the transport (plain fetch()
// instead of @discordjs/rest), so this proves createFetchDiscordRest
// builds the identical requests HttpDiscordRest does.
describe('createFetchDiscordRest', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function rest() {
    return createFetchDiscordRest({ botToken: 'test-token', botUserId: 'bot-user-id' })
  }

  function stubFetchReturning(body: unknown, status = 200) {
    const fetchStub = stub(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(status === 204 ? null : JSON.stringify(body), { status })
    })
    globalThis.fetch = fetchStub
    return fetchStub
  }

  it('postMessage: POSTs to the channel messages route with Bot auth and the given body', async () => {
    const fetchStub = stubFetchReturning({ id: 'msg-1' })

    const result = await rest().postMessage('channel-1', { content: 'hello' })

    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('https://discord.com/api/v10/channels/channel-1/messages')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bot test-token')
    expect(JSON.parse(init?.body as string)).toEqual({ content: 'hello' })
    expect(result).toEqual({ id: 'msg-1' })
  })

  it('editMessage: PATCHes the specific message route with the given body', async () => {
    const fetchStub = stubFetchReturning({ id: 'msg-1', content: 'updated' })

    const result = await rest().editMessage('channel-1', 'msg-1', { content: 'updated' })

    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('https://discord.com/api/v10/channels/channel-1/messages/msg-1')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ content: 'updated' })
    expect(result).toEqual({ id: 'msg-1', content: 'updated' })
  })

  it('getGuild: GETs the specific guild route with no body', async () => {
    const fetchStub = stubFetchReturning({ id: 'guild-1', name: 'My Server' })

    const result = await rest().getGuild('guild-1')

    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('https://discord.com/api/v10/guilds/guild-1')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(result).toEqual({ id: 'guild-1', name: 'My Server' })
  })

  it('createChannel: POSTs to the guild channels route with the given body', async () => {
    const fetchStub = stubFetchReturning({ id: 'channel-1' })

    const result = await rest().createChannel('guild-1', { name: 'pod-chat' })

    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('https://discord.com/api/v10/guilds/guild-1/channels')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'pod-chat' })
    expect(result).toEqual({ id: 'channel-1' })
  })

  it('createInvite: POSTs to the channel invites route with a 6h max_age', async () => {
    const fetchStub = stubFetchReturning({ code: 'abc123' })

    const result = await rest().createInvite('channel-1')

    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('https://discord.com/api/v10/channels/channel-1/invites')
    expect(JSON.parse(init?.body as string)).toEqual({ max_age: 21600 })
    expect(result).toEqual({ code: 'abc123' })
  })

  it('createDmChannel: POSTs to the user channels route with the recipient id', async () => {
    const fetchStub = stubFetchReturning({ id: 'dm-channel-1' })

    const result = await rest().createDmChannel('user-1')

    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('https://discord.com/api/v10/users/@me/channels')
    expect(JSON.parse(init?.body as string)).toEqual({ recipient_id: 'user-1' })
    expect(result).toEqual({ id: 'dm-channel-1' })
  })

  it('deleteChannel: DELETEs the specific channel route and returns nothing for a 204', async () => {
    const fetchStub = stubFetchReturning(undefined, 204)

    const result = await rest().deleteChannel('channel-1')

    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('https://discord.com/api/v10/channels/channel-1')
    expect(init?.method).toBe('DELETE')
    expect(result).toBeUndefined()
  })

  it('editOriginalInteractionResponse: PATCHes the webhook @original message route', async () => {
    const fetchStub = stubFetchReturning({ id: 'msg-1' })

    const result = await rest().editOriginalInteractionResponse('app-1', 'interaction-token-1', { content: 'done' })

    // discord-api-types' Routes helpers URL-encode every path segment that
    // isn't already "URL safe" — `@` isn't, so `@original` comes out as
    // `%40original` here (see rest.test.ts's identical assertion for the
    // same route) — real Discord API decodes it back to the literal
    // `@original` route.
    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('https://discord.com/api/v10/webhooks/app-1/interaction-token-1/messages/%40original')
    expect(JSON.parse(init?.body as string)).toEqual({ content: 'done' })
    expect(result).toEqual({ id: 'msg-1' })
  })

  it('throws with the status and response body when Discord returns a non-2xx status', async () => {
    globalThis.fetch = stub(async () => new Response('{"message":"missing access"}', { status: 403 }))

    await expect(rest().postMessage('channel-1', { content: 'hello' })).rejects.toThrow(/403/)
  })

  it('exposes botUserId directly, matching the application/bot id convention', () => {
    expect(rest().botUserId).toBe('bot-user-id')
  })
})
