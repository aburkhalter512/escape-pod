import { afterEach, describe, expect, it } from 'vitest'
import { HttpBackendClient } from './backendClient.js'
import { stub } from './testUtils/stub.js'

describe('HttpBackendClient', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function client() {
    return new HttpBackendClient({ baseUrl: 'http://backend.local', apiKey: 'secret-key' })
  }

  // Every response-producing test cares only about the Response coming
  // back, not the request shape, so the stub ignores its arguments.
  function stubFetchReturning(response: () => Response) {
    globalThis.fetch = stub(async (_url: string | URL | Request, _init?: RequestInit) => response())
  }

  // For tests that inspect the request itself.
  function stubFetchCapturing(response: Response) {
    return stub(async (_url: string | URL | Request, _init?: RequestInit) => response)
  }

  it('sends the Bearer API key and JSON content-type on every request', async () => {
    const fetchStub = stubFetchCapturing(new Response(JSON.stringify({ username: 'PlayerOne' }), { status: 200 }))
    globalThis.fetch = fetchStub

    await client().linkOrganizer('discord-1', 'token-1')

    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('http://backend.local/organizers/link')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ discordId: 'discord-1', token: 'token-1' }))
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret-key')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('parses and returns the JSON response body on success', async () => {
    stubFetchReturning(() => new Response(JSON.stringify({ username: 'PlayerOne' }), { status: 200 }))

    const result = await client().linkOrganizer('discord-1', 'token-1')

    expect(result).toEqual({ username: 'PlayerOne' })
  })

  it('throws with the status and body when the backend responds with a non-2xx status', async () => {
    // A Response body can only be read once, so a fresh instance per call is
    // required here — the stub's impl runs fresh each invocation.
    stubFetchReturning(() => new Response('token rejected', { status: 422 }))

    await expect(client().linkOrganizer('discord-1', 'bad-token')).rejects.toThrow(/422/)
    await expect(client().linkOrganizer('discord-1', 'bad-token')).rejects.toThrow(/token rejected/)
  })

  it('propagates network-level failures (fetch rejecting) rather than swallowing them', async () => {
    globalThis.fetch = stub(async (_url: string | URL | Request, _init?: RequestInit) => {
      throw new Error('ECONNREFUSED')
    })

    await expect(client().listEligibleGuilds('discord-1')).rejects.toThrow('ECONNREFUSED')
  })

  it('builds GET requests with the path interpolated and no body', async () => {
    const fetchStub = stubFetchCapturing(new Response(JSON.stringify([]), { status: 200 }))
    globalThis.fetch = fetchStub

    await client().listEligibleGuilds('discord-1')

    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('http://backend.local/organizers/discord-1/eligible-guilds')
    expect(init?.body).toBeUndefined()
  })

  it('recordMessagePosted posts the messageId to the round+guild-scoped path', async () => {
    const fetchStub = stubFetchCapturing(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    globalThis.fetch = fetchStub

    await client().recordMessagePosted('round-1', 'guild-1', 'msg-1')

    const [url, init] = fetchStub.calls[0]
    expect(url).toBe('http://backend.local/pods/round-1/targets/guild-1/message')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ messageId: 'msg-1' }))
  })
})
