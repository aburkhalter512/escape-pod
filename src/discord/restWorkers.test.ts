import { afterEach, describe, expect, it } from 'vitest'
import { createFetchDiscordRest } from './restWorkers.js'
import { stub } from '../testUtils/stub.js'

// rest.test.ts already covers HttpDiscordRest's route/body logic against
// a stubbed RawRestClient (shared by both platforms) — what's left
// uncovered, and what this file is scoped to, is createFetchRawRestClient
// itself: the real fetch()-based transport underneath (URL construction,
// auth header, JSON encoding, 204 handling, non-2xx error throwing). Not
// a per-Discord-method test suite; one representative case per transport
// behavior is enough since the route-building logic itself is already
// proven identical in rest.test.ts.
describe('createFetchDiscordRest transport', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function rest() {
    return createFetchDiscordRest({ botToken: 'test-token', botUserId: 'bot-user-id' })
  }

  it('sends a real fetch() POST with Bot auth, JSON content-type, and a JSON-encoded body', async () => {
    const fetchStub = stub(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 })
    })
    globalThis.fetch = fetchStub

    const result = await rest().postMessage('channel-1', { content: 'hello' })

    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('https://discord.com/api/v10/channels/channel-1/messages')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bot test-token')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init?.body as string)).toEqual({ content: 'hello' })
    expect(result).toEqual({ id: 'msg-1' })
  })

  it('returns undefined for a 204 response instead of parsing an empty body as JSON', async () => {
    globalThis.fetch = stub(async () => new Response(null, { status: 204 }))

    const result = await rest().deleteChannel('channel-1')

    expect(result).toBeUndefined()
  })

  it('throws with the status and response body text when Discord returns a non-2xx status', async () => {
    globalThis.fetch = stub(async () => new Response('{"message":"missing access"}', { status: 403 }))

    await expect(rest().postMessage('channel-1', { content: 'hello' })).rejects.toThrow(/403/)
  })
})
