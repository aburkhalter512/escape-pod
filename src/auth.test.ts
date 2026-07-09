import { describe, expect, it } from 'vitest'
import { requireBotApiKey, type MinimalFastifyReply, type MinimalFastifyRequest } from './auth.js'

function fakeRequest(authorization: string | undefined): MinimalFastifyRequest {
  return { headers: { authorization } }
}

function fakeReply() {
  const calls: { code?: number; sent?: unknown } = {}
  const reply: MinimalFastifyReply = {
    code(status) {
      calls.code = status
      return reply
    },
    send(payload) {
      calls.sent = payload
      return reply
    },
  }
  return { reply, calls }
}

describe('requireBotApiKey', () => {
  it('allows the request through when the Bearer key matches exactly', async () => {
    const middleware = requireBotApiKey('correct-key')
    const { reply, calls } = fakeReply()

    await middleware(fakeRequest('Bearer correct-key'), reply)

    expect(calls.code).toBeUndefined()
  })

  it('rejects with 401 when the header is missing entirely', async () => {
    const middleware = requireBotApiKey('correct-key')
    const { reply, calls } = fakeReply()

    await middleware(fakeRequest(undefined), reply)

    expect(calls.code).toBe(401)
  })

  it('rejects with 401 when the key does not match', async () => {
    const middleware = requireBotApiKey('correct-key')
    const { reply, calls } = fakeReply()

    await middleware(fakeRequest('Bearer wrong-key'), reply)

    expect(calls.code).toBe(401)
  })

  it('rejects a header missing the "Bearer " prefix, even with the right key', async () => {
    const middleware = requireBotApiKey('correct-key')
    const { reply, calls } = fakeReply()

    await middleware(fakeRequest('correct-key'), reply)

    expect(calls.code).toBe(401)
  })

  it('is case-sensitive and exact — a key that is merely a prefix/suffix match is rejected', async () => {
    const middleware = requireBotApiKey('correct-key')
    const { reply, calls } = fakeReply()

    await middleware(fakeRequest('Bearer correct-key-extra'), reply)

    expect(calls.code).toBe(401)
  })

  it('rejects an empty string key the same as a wrong key (no accidental bypass)', async () => {
    const middleware = requireBotApiKey('correct-key')
    const { reply, calls } = fakeReply()

    await middleware(fakeRequest('Bearer '), reply)

    expect(calls.code).toBe(401)
  })
})
