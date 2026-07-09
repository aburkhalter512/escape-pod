import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendClient } from './backendClient.js'

describe('BackendClient', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  function client() {
    return new BackendClient({ baseUrl: 'http://backend.local', apiKey: 'secret-key' })
  }

  it('sends the Bearer API key and JSON content-type on every request', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ username: 'PlayerOne' }), { status: 200 }))

    await client().linkOrganizer('discord-1', 'token-1')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.local/organizers/link',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ discordId: 'discord-1', token: 'token-1' }),
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-key',
          'Content-Type': 'application/json',
        }),
      })
    )
  })

  it('parses and returns the JSON response body on success', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ username: 'PlayerOne' }), { status: 200 }))

    const result = await client().linkOrganizer('discord-1', 'token-1')

    expect(result).toEqual({ username: 'PlayerOne' })
  })

  it('throws with the status and body when the backend responds with a non-2xx status', async () => {
    // A Response body can only be read once, so a fresh instance per call is
    // required here (mockResolvedValue would hand back the same consumed
    // Response on the second await).
    fetchMock.mockImplementation(() => Promise.resolve(new Response('token rejected', { status: 422 })))

    await expect(client().linkOrganizer('discord-1', 'bad-token')).rejects.toThrow(/422/)
    await expect(client().linkOrganizer('discord-1', 'bad-token')).rejects.toThrow(/token rejected/)
  })

  it('propagates network-level failures (fetch rejecting) rather than swallowing them', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(client().listEligibleGuilds('discord-1')).rejects.toThrow('ECONNREFUSED')
  })

  it('builds GET requests with the path interpolated and no body', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))

    await client().listEligibleGuilds('discord-1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://backend.local/organizers/discord-1/eligible-guilds')
    expect(init.body).toBeUndefined()
  })
})
