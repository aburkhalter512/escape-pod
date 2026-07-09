import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptToken, encryptToken } from './tokenCrypto.js'

function generateKeyHex(): string {
  return randomBytes(32).toString('hex')
}

describe('encryptToken / decryptToken', () => {
  it('round-trips a plaintext token', () => {
    const key = generateKeyHex()
    const plaintext = 'header.payload.signature'

    const encrypted = encryptToken(plaintext, key)
    expect(decryptToken(encrypted, key)).toBe(plaintext)
  })

  it('produces different ciphertext for the same plaintext on each call (random IV)', () => {
    const key = generateKeyHex()
    const plaintext = 'same-input-every-time'

    const first = encryptToken(plaintext, key)
    const second = encryptToken(plaintext, key)

    expect(first).not.toBe(second)
    // ...but both still decrypt to the same plaintext.
    expect(decryptToken(first, key)).toBe(plaintext)
    expect(decryptToken(second, key)).toBe(plaintext)
  })

  it('fails to decrypt with the wrong key', () => {
    const encrypted = encryptToken('secret-value', generateKeyHex())
    const wrongKey = generateKeyHex()

    expect(() => decryptToken(encrypted, wrongKey)).toThrow()
  })

  it('fails to decrypt when the ciphertext has been tampered with (GCM auth tag catches it)', () => {
    // This is the property that actually matters for §8.5: an attacker who
    // can write to storage shouldn't be able to swap in a token of their
    // choosing without detection, even without knowing the key.
    const key = generateKeyHex()
    const encrypted = encryptToken('the-real-token', key)
    const [iv, authTag, ciphertext] = encrypted.split(':')

    const tamperedByte = (ciphertext[0] === 'a' ? 'b' : 'a') + ciphertext.slice(1)
    const tampered = [iv, authTag, tamperedByte].join(':')

    expect(() => decryptToken(tampered, key)).toThrow()
  })

  it('fails to decrypt when the auth tag has been tampered with', () => {
    const key = generateKeyHex()
    const encrypted = encryptToken('the-real-token', key)
    const [iv, authTag, ciphertext] = encrypted.split(':')

    const tamperedTag = (authTag[0] === 'a' ? 'b' : 'a') + authTag.slice(1)
    const tampered = [iv, tamperedTag, ciphertext].join(':')

    expect(() => decryptToken(tampered, key)).toThrow()
  })

  it('throws a clear error for malformed ciphertext (missing parts)', () => {
    const key = generateKeyHex()
    expect(() => decryptToken('not-the-right-format', key)).toThrow(/malformed/i)
    expect(() => decryptToken('only:two', key)).toThrow(/malformed/i)
    expect(() => decryptToken('', key)).toThrow(/malformed/i)
  })

  it('round-trips tokens containing unicode and special characters', () => {
    const key = generateKeyHex()
    const plaintext = 'token-with-emoji-🔑-and-symbols-!@#$%^&*()'

    expect(decryptToken(encryptToken(plaintext, key), key)).toBe(plaintext)
  })

  it('round-trips an empty string', () => {
    const key = generateKeyHex()
    expect(decryptToken(encryptToken('', key), key)).toBe('')
  })

  it('round-trips a realistically long PTP JWT', () => {
    const key = generateKeyHex()
    // Representative length of a real signed JWT with the fields from
    // §8.2's decoded payload (id, discord_id, username, exp, etc.)
    const plaintext = `header.${'x'.repeat(400)}.signature`
    expect(decryptToken(encryptToken(plaintext, key), key)).toBe(plaintext)
  })
})
