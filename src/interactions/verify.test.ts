import { beforeAll, describe, expect, it } from 'vitest'
import type { webcrypto } from 'node:crypto'
import { verifyDiscordSignature, type MinimalFastifyReply, type MinimalFastifyRequest } from './verify.js'

// Mirrors exactly what discord-interactions' verifyKey does internally
// (node_modules/discord-interactions/dist/util.js): Ed25519 over
// timestamp-bytes + body-bytes, raw public key, hex-encoded signature. We
// generate a real keypair here so these tests exercise the actual crypto
// path rather than mocking it away — this is the one function standing
// between us and accepting forged Discord requests, so it's worth testing
// against real signatures, not stubs.

let publicKeyHex: string
let privateKey: webcrypto.CryptoKey

async function sign(timestamp: string, body: string): Promise<string> {
  const message = new TextEncoder().encode(timestamp + body)
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message)
  return Buffer.from(signature).toString('hex')
}

function fakeRequest(headers: MinimalFastifyRequest['headers'], rawBody?: string): MinimalFastifyRequest {
  return { headers, rawBody }
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

beforeAll(async () => {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
  privateKey = keyPair.privateKey
  const rawPublicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey)
  publicKeyHex = Buffer.from(rawPublicKey).toString('hex')
})

describe('verifyDiscordSignature', () => {
  it('accepts a correctly signed request', async () => {
    const timestamp = '1700000000'
    const body = JSON.stringify({ type: 1 })
    const signature = await sign(timestamp, body)

    const request = fakeRequest(
      { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
      body
    )
    const { reply, calls } = fakeReply()

    const result = await verifyDiscordSignature(request, reply, publicKeyHex)

    expect(result).toBe(true)
    expect(calls.code).toBeUndefined()
  })

  it('rejects a request signed with a different key', async () => {
    const otherKeyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
    const timestamp = '1700000000'
    const body = JSON.stringify({ type: 1 })
    const message = new TextEncoder().encode(timestamp + body)
    const wrongSignature = Buffer.from(
      await crypto.subtle.sign({ name: 'Ed25519' }, otherKeyPair.privateKey, message)
    ).toString('hex')

    const request = fakeRequest(
      { 'x-signature-ed25519': wrongSignature, 'x-signature-timestamp': timestamp },
      body
    )
    const { reply, calls } = fakeReply()

    const result = await verifyDiscordSignature(request, reply, publicKeyHex)

    expect(result).toBe(false)
    expect(calls.code).toBe(401)
  })

  it('rejects when the body has been tampered with after signing', async () => {
    const timestamp = '1700000000'
    const originalBody = JSON.stringify({ amount: 1 })
    const signature = await sign(timestamp, originalBody)
    const tamperedBody = JSON.stringify({ amount: 999 })

    const request = fakeRequest(
      { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
      tamperedBody
    )
    const { reply, calls } = fakeReply()

    expect(await verifyDiscordSignature(request, reply, publicKeyHex)).toBe(false)
    expect(calls.code).toBe(401)
  })

  it('rejects when the timestamp has been tampered with after signing', async () => {
    const originalTimestamp = '1700000000'
    const body = JSON.stringify({ type: 1 })
    const signature = await sign(originalTimestamp, body)

    const request = fakeRequest(
      { 'x-signature-ed25519': signature, 'x-signature-timestamp': '1700000001' },
      body
    )
    const { reply } = fakeReply()

    expect(await verifyDiscordSignature(request, reply, publicKeyHex)).toBe(false)
  })

  it.each([
    ['missing signature header', { 'x-signature-timestamp': '1700000000' }],
    ['missing timestamp header', { 'x-signature-ed25519': 'deadbeef' }],
    ['both headers missing', {}],
  ])('rejects with 401 when %s', async (_label, headers) => {
    const request = fakeRequest(headers, '{}')
    const { reply, calls } = fakeReply()

    const result = await verifyDiscordSignature(request, reply, publicKeyHex)

    expect(result).toBe(false)
    expect(calls.code).toBe(401)
  })

  it('rejects when the raw body is missing (e.g. body parsing stripped it)', async () => {
    const request = fakeRequest({ 'x-signature-ed25519': 'deadbeef', 'x-signature-timestamp': '1700000000' })

    const { reply, calls } = fakeReply()

    expect(await verifyDiscordSignature(request, reply, publicKeyHex)).toBe(false)
    expect(calls.code).toBe(401)
  })

  it('rejects a malformed (non-hex) signature without throwing', async () => {
    const request = fakeRequest(
      { 'x-signature-ed25519': 'not-hex-at-all!!', 'x-signature-timestamp': '1700000000' },
      '{}'
    )
    const { reply, calls } = fakeReply()

    const result = await verifyDiscordSignature(request, reply, publicKeyHex)

    expect(result).toBe(false)
    expect(calls.code).toBe(401)
  })
})
