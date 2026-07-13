import { afterEach, describe, expect, it } from 'vitest'
import { HttpPtpClient } from './client.js'
import { stub } from '../testUtils/stub.js'

describe('HttpPtpClient', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function client() {
    return new HttpPtpClient({ baseUrl: 'https://www.protectthepod.com' })
  }

  // Every response-producing test cares only about the Response coming
  // back, not the request shape, so the stub ignores its arguments.
  function stubFetchReturning(response: () => Response) {
    globalThis.fetch = stub(async (_url: string | URL | Request, _init?: RequestInit) => response())
  }

  // For tests that inspect the request itself — typed so fetchStub.calls
  // captures the real (url, init) shape instead of inferring [].
  function stubFetchCapturing(response: Response) {
    return stub(async (_url: string | URL | Request, _init?: RequestInit) => response)
  }

  describe('validateToken', () => {
    it('returns true when PTP responds 200', async () => {
      stubFetchReturning(() => new Response('{}', { status: 200 }))
      expect(await client().validateToken('good-token')).toBe(true)
    })

    it('returns false when PTP responds 401 (expired/revoked token)', async () => {
      stubFetchReturning(() => new Response('{}', { status: 401 }))
      expect(await client().validateToken('bad-token')).toBe(false)
    })

    it('calls the exact low-stakes read-only endpoint documented in §8.2(d)', async () => {
      const fetchStub = stubFetchCapturing(new Response('{}', { status: 200 }))
      globalThis.fetch = fetchStub
      await client().validateToken('a-token')

      const [url, init] = fetchStub.calls[0]
      expect(url).toBe('https://www.protectthepod.com/api/me/drafts?limit=1')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer a-token')
      expect(init?.method).toBeUndefined() // defaults to GET — no side effects
    })
  })

  describe('createPod', () => {
    it('returns the parsed pod details on success', async () => {
      const body = { id: 'pod-1', shareId: 'abc123', shareUrl: 'https://www.protectthepod.com/draft/abc123', createdAt: '2026-01-01T00:00:00Z' }
      stubFetchReturning(() => new Response(JSON.stringify(body), { status: 201 }))

      const result = await client().createPod('a-token', { setCode: 'JTL', maxPlayers: 8 })

      expect(result).toEqual(body)
    })

    it('sends setCode, maxPlayers, and isPublic:true in the request body', async () => {
      const body = { id: 'pod-1', shareId: 'abc123', createdAt: '2026-01-01T00:00:00Z' }
      const fetchStub = stubFetchCapturing(new Response(JSON.stringify(body), { status: 201 }))
      globalThis.fetch = fetchStub

      await client().createPod('a-token', { setCode: 'JTL', maxPlayers: 6 })

      const [, init] = fetchStub.calls[0]
      expect(JSON.parse(init?.body as string)).toEqual({ setCode: 'JTL', maxPlayers: 6, isPublic: true })
    })

    it('throws with the status and response body when PTP rejects the request', async () => {
      // A Response body can only be read once, so a fresh instance per call
      // is required here — the stub's impl runs fresh each invocation.
      stubFetchReturning(() => new Response('User is already in a lobby', { status: 403 }))

      await expect(client().createPod('a-token', { setCode: 'JTL', maxPlayers: 8 })).rejects.toThrow(/403/)
      await expect(client().createPod('a-token', { setCode: 'JTL', maxPlayers: 8 })).rejects.toThrow(
        /already in a lobby/
      )
    })

    it('always derives shareUrl from baseUrl + shareId, ignoring any shareUrl field PTP sends back', async () => {
      const body = { id: 'pod-1', shareId: 'abc123', createdAt: '2026-01-01T00:00:00Z' } // no shareUrl at all
      stubFetchReturning(() => new Response(JSON.stringify(body), { status: 201 }))

      const result = await client().createPod('a-token', { setCode: 'JTL', maxPlayers: 8 })

      expect(result.shareUrl).toBe('https://www.protectthepod.com/draft/abc123')
    })

    it('ignores a mismatched shareUrl field from the response in favor of the derived one', async () => {
      const body = {
        id: 'pod-1',
        shareId: 'abc123',
        shareUrl: 'https://example.com/totally-wrong',
        createdAt: '2026-01-01T00:00:00Z',
      }
      stubFetchReturning(() => new Response(JSON.stringify(body), { status: 201 }))

      const result = await client().createPod('a-token', { setCode: 'JTL', maxPlayers: 8 })

      expect(result.shareUrl).toBe('https://www.protectthepod.com/draft/abc123')
    })

    it('throws, with the raw response body in the message, when shareId is missing', async () => {
      const body = { id: 'pod-1', createdAt: '2026-01-01T00:00:00Z' } // no shareId
      stubFetchReturning(() => new Response(JSON.stringify(body), { status: 201 }))

      await expect(client().createPod('a-token', { setCode: 'JTL', maxPlayers: 8 })).rejects.toThrow(/pod-1/)
    })

    it('throws, with the raw response body in the message, when shareId is an empty string', async () => {
      const body = { id: 'pod-1', shareId: '', createdAt: '2026-01-01T00:00:00Z' }
      stubFetchReturning(() => new Response(JSON.stringify(body), { status: 201 }))

      await expect(client().createPod('a-token', { setCode: 'JTL', maxPlayers: 8 })).rejects.toThrow(/pod-1/)
    })
  })

  describe('refreshToken', () => {
    it('extracts the new JWT from the Set-Cookie header on success', async () => {
      stubFetchReturning(
        () =>
          new Response('{}', {
            status: 200,
            headers: { 'set-cookie': 'swupod_session=new.jwt.value; Path=/; HttpOnly; Secure' },
          })
      )

      expect(await client().refreshToken('old-token')).toBe('new.jwt.value')
    })

    it('URL-decodes the cookie value', async () => {
      const encoded = encodeURIComponent('token.with special.chars')
      stubFetchReturning(
        () => new Response('{}', { status: 200, headers: { 'set-cookie': `swupod_session=${encoded}; Path=/` } })
      )

      expect(await client().refreshToken('old-token')).toBe('token.with special.chars')
    })

    it('returns null when the response has no Set-Cookie header', async () => {
      stubFetchReturning(() => new Response('{}', { status: 200 }))
      expect(await client().refreshToken('old-token')).toBeNull()
    })

    it('returns null when Set-Cookie is present but does not contain swupod_session', async () => {
      stubFetchReturning(
        () => new Response('{}', { status: 200, headers: { 'set-cookie': 'some_other_cookie=value; Path=/' } })
      )
      expect(await client().refreshToken('old-token')).toBeNull()
    })

    it('returns null when PTP responds non-2xx (e.g. the current token already expired)', async () => {
      stubFetchReturning(() => new Response('{}', { status: 401 }))
      expect(await client().refreshToken('expired-token')).toBeNull()
    })

    it('sends the current token as the Bearer credential, not a cookie', async () => {
      const fetchStub = stubFetchCapturing(new Response('{}', { status: 200 }))
      globalThis.fetch = fetchStub

      await client().refreshToken('old-token')

      const [url, init] = fetchStub.calls[0]
      expect(url).toBe('https://www.protectthepod.com/api/auth/refresh')
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer old-token')
    })
  })
})
