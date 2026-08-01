import { describe, expect, it } from 'vitest'
import { HttpNiamosClient } from './client.js'
import { stub } from '../testUtils/stub.js'

// fetch is injected directly via HttpNiamosClient's own config, not via
// monkey-patching globalThis.fetch — see niamos/client.ts's
// NiamosClientConfig.fetch doc comment (same pattern as
// discord/restWorkers.test.ts's createFetchDiscordRest).
describe('HttpNiamosClient', () => {
  function client(fetchImpl: typeof fetch) {
    return new HttpNiamosClient({
      apiBaseUrl: 'https://niamos-backend.onrender.com',
      shareBaseUrl: 'https://niamos.net',
      fetch: fetchImpl,
    })
  }

  function fetchStubReturning(response: () => Response) {
    return stub(async (_url: string | URL | Request, _init?: RequestInit) => response())
  }

  describe('whoami', () => {
    it('returns the display name when Niamos reports a valid token', async () => {
      const fetchStub = fetchStubReturning(
        () =>
          new Response(JSON.stringify({ displayName: 'Niamos', playerUuid: '5a8e7e1b-6ea1-4e26-8bb4-7877c44be131', valid: true }), {
            status: 200,
          })
      )

      expect(await client(fetchStub as unknown as typeof fetch).whoami('nms_good_token')).toEqual({ displayName: 'Niamos' })
    })

    it('returns null when Niamos responds 401 (invalid/revoked token)', async () => {
      const fetchStub = fetchStubReturning(() => new Response(JSON.stringify({ detail: 'Invalid or revoked token' }), { status: 401 }))

      expect(await client(fetchStub as unknown as typeof fetch).whoami('nms_bad_token')).toBeNull()
    })

    it('returns null when the response is 200 but valid is not true', async () => {
      const fetchStub = fetchStubReturning(() => new Response(JSON.stringify({ displayName: 'Niamos', valid: false }), { status: 200 }))

      expect(await client(fetchStub as unknown as typeof fetch).whoami('nms_token')).toBeNull()
    })

    it('calls GET /api/bot/whoami with the bearer token', async () => {
      const fetchStub = fetchStubReturning(() => new Response(JSON.stringify({ displayName: 'Niamos', valid: true }), { status: 200 }))

      await client(fetchStub as unknown as typeof fetch).whoami('nms_a_token')

      const [url, init] = fetchStub.calls[0]
      expect(url).toBe('https://niamos-backend.onrender.com/api/bot/whoami')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer nms_a_token')
      expect(init?.method).toBeUndefined() // defaults to GET
    })
  })

  describe('createDraft', () => {
    function draftResponse(uuid: string) {
      return {
        draft: {
          id: 35,
          uuid,
          createdAt: '2026-07-31T05:41:12.680813Z',
          finishedAt: null,
          status: 'pending',
          numSeats: 8,
          setName: 'ASH',
        },
        seats: [],
      }
    }

    it('returns the uuid and a derived shareUrl on success', async () => {
      const fetchStub = fetchStubReturning(
        () => new Response(JSON.stringify(draftResponse('240a559f-17e8-4257-8ccc-e4b09d8f76ed')), { status: 201 })
      )

      const result = await client(fetchStub as unknown as typeof fetch).createDraft('nms_a_token', {
        setName: 'ASH',
        numSeats: 8,
        seatCreator: false,
      })

      expect(result).toEqual({
        uuid: '240a559f-17e8-4257-8ccc-e4b09d8f76ed',
        shareUrl: 'https://niamos.net/drafts/240a559f-17e8-4257-8ccc-e4b09d8f76ed',
      })
    })

    it('sends setName, numSeats, and seatCreator in the request body', async () => {
      const fetchStub = fetchStubReturning(() => new Response(JSON.stringify(draftResponse('a-uuid')), { status: 201 }))

      await client(fetchStub as unknown as typeof fetch).createDraft('nms_a_token', { setName: 'JTL', numSeats: 8, seatCreator: false })

      const [url, init] = fetchStub.calls[0]
      expect(url).toBe('https://niamos-backend.onrender.com/api/bot/drafts')
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer nms_a_token')
      expect(JSON.parse(init?.body as string)).toEqual({ setName: 'JTL', numSeats: 8, seatCreator: false })
    })

    it('throws with the status and response body when Niamos rejects the request', async () => {
      const fetchStub = fetchStubReturning(() => new Response('Server has no linked token', { status: 403 }))
      const niamos = client(fetchStub as unknown as typeof fetch)

      await expect(niamos.createDraft('nms_a_token', { setName: 'JTL', numSeats: 8, seatCreator: false })).rejects.toThrow(/403/)
      await expect(niamos.createDraft('nms_a_token', { setName: 'JTL', numSeats: 8, seatCreator: false })).rejects.toThrow(
        /no linked token/
      )
    })

    it('throws, with the raw response body in the message, when draft.uuid is missing', async () => {
      const body = { draft: { id: 35, status: 'pending' }, seats: [] }
      const fetchStub = fetchStubReturning(() => new Response(JSON.stringify(body), { status: 201 }))

      await expect(
        client(fetchStub as unknown as typeof fetch).createDraft('nms_a_token', { setName: 'JTL', numSeats: 8, seatCreator: false })
      ).rejects.toThrow(/pending/)
    })

    it('throws when draft.uuid is an empty string', async () => {
      const body = { draft: { id: 35, uuid: '' }, seats: [] }
      const fetchStub = fetchStubReturning(() => new Response(JSON.stringify(body), { status: 201 }))

      await expect(
        client(fetchStub as unknown as typeof fetch).createDraft('nms_a_token', { setName: 'JTL', numSeats: 8, seatCreator: false })
      ).rejects.toThrow(/"id":35/)
    })
  })
})
