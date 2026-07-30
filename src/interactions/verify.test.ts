import { beforeAll, describe, expect, it } from 'vitest'
import type { webcrypto } from 'node:crypto'
import { verifyDiscordSignatureFromRequest, type MinimalHonoRequest } from './verify.js'

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

function fakeHonoRequest(headers: Record<string, string | undefined>, body?: string): MinimalHonoRequest {
  return {
    header: (name) => headers[name],
    text: async () => body ?? '',
  }
}

beforeAll(async () => {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
  privateKey = keyPair.privateKey
  const rawPublicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey)
  publicKeyHex = Buffer.from(rawPublicKey).toString('hex')
})

describe('verifyDiscordSignatureFromRequest', () => {
  it('accepts a correctly signed request', async () => {
    const timestamp = '1700000000'
    const body = JSON.stringify({ type: 1 })
    const signature = await sign(timestamp, body)

    const result = await verifyDiscordSignatureFromRequest(
      fakeHonoRequest({ 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp }, body),
      publicKeyHex
    )

    expect(result).toEqual({ valid: true, rawBody: body })
  })

  it('rejects a request signed with a different key', async () => {
    const otherKeyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
    const timestamp = '1700000000'
    const body = JSON.stringify({ type: 1 })
    const message = new TextEncoder().encode(timestamp + body)
    const wrongSignature = Buffer.from(
      await crypto.subtle.sign({ name: 'Ed25519' }, otherKeyPair.privateKey, message)
    ).toString('hex')

    const result = await verifyDiscordSignatureFromRequest(
      fakeHonoRequest({ 'x-signature-ed25519': wrongSignature, 'x-signature-timestamp': timestamp }, body),
      publicKeyHex
    )

    expect(result).toEqual({ valid: false, status: 401, body: { error: 'Invalid request signature' } })
  })

  it('rejects when the body has been tampered with after signing', async () => {
    const timestamp = '1700000000'
    const originalBody = JSON.stringify({ amount: 1 })
    const signature = await sign(timestamp, originalBody)
    const tamperedBody = JSON.stringify({ amount: 999 })

    const result = await verifyDiscordSignatureFromRequest(
      fakeHonoRequest({ 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp }, tamperedBody),
      publicKeyHex
    )

    expect(result).toEqual({ valid: false, status: 401, body: { error: 'Invalid request signature' } })
  })

  it('rejects when the timestamp has been tampered with after signing', async () => {
    const originalTimestamp = '1700000000'
    const body = JSON.stringify({ type: 1 })
    const signature = await sign(originalTimestamp, body)

    const result = await verifyDiscordSignatureFromRequest(
      fakeHonoRequest({ 'x-signature-ed25519': signature, 'x-signature-timestamp': '1700000001' }, body),
      publicKeyHex
    )

    expect(result.valid).toBe(false)
  })

  it.each([
    ['missing signature header', { 'x-signature-timestamp': '1700000000' }],
    ['missing timestamp header', { 'x-signature-ed25519': 'deadbeef' }],
    ['both headers missing', {}],
  ])('rejects with 401 when %s', async (_label, headers) => {
    const result = await verifyDiscordSignatureFromRequest(fakeHonoRequest(headers, '{}'), publicKeyHex)

    expect(result).toEqual({ valid: false, status: 401, body: { error: 'Missing signature headers' } })
  })

  it('rejects when the raw body is empty', async () => {
    const result = await verifyDiscordSignatureFromRequest(
      fakeHonoRequest({ 'x-signature-ed25519': 'deadbeef', 'x-signature-timestamp': '1700000000' }, ''),
      publicKeyHex
    )

    expect(result).toEqual({ valid: false, status: 401, body: { error: 'Missing signature headers' } })
  })

  it('rejects a malformed (non-hex) signature without throwing', async () => {
    const result = await verifyDiscordSignatureFromRequest(
      fakeHonoRequest({ 'x-signature-ed25519': 'not-hex-at-all!!', 'x-signature-timestamp': '1700000000' }, '{}'),
      publicKeyHex
    )

    expect(result).toEqual({ valid: false, status: 401, body: { error: 'Invalid request signature' } })
  })
})
