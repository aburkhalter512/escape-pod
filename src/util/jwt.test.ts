import { describe, expect, it } from 'vitest'
import { decodeJwtPayloadUnverified } from './jwt.js'

function fakeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256' }): string {
  const encode = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${encode(header)}.${encode(payload)}.fake-signature`
}

describe('decodeJwtPayloadUnverified', () => {
  it('decodes a well-formed token payload', () => {
    const token = fakeJwt({ id: 'u1', discord_id: '123', username: 'PlayerOne', exp: 1234567890 })
    expect(decodeJwtPayloadUnverified(token)).toEqual({
      id: 'u1',
      discord_id: '123',
      username: 'PlayerOne',
      exp: 1234567890,
    })
  })

  it('returns null for a token with the wrong number of segments', () => {
    expect(decodeJwtPayloadUnverified('only.two')).toBeNull()
    expect(decodeJwtPayloadUnverified('one')).toBeNull()
    expect(decodeJwtPayloadUnverified('a.b.c.d')).toBeNull()
    expect(decodeJwtPayloadUnverified('')).toBeNull()
  })

  it('returns null when the payload segment is not valid base64', () => {
    expect(decodeJwtPayloadUnverified('header.not!!valid!!base64.sig')).toBeNull()
  })

  it('returns null when the decoded payload is not valid JSON', () => {
    const notJson = Buffer.from('this is not json').toString('base64url')
    expect(decodeJwtPayloadUnverified(`header.${notJson}.sig`)).toBeNull()
  })

  it('handles base64url characters (-, _) that differ from standard base64', () => {
    // Pick a payload whose base64 encoding is known to contain - or _ in
    // base64url form, to make sure the -> +// substitution path is exercised.
    const payload = { id: 'x'.repeat(40), username: '???>>><<<', exp: 1 }
    const token = fakeJwt(payload)
    expect(decodeJwtPayloadUnverified(token)).toEqual(payload)
  })

  it('handles payloads whose base64 length requires padding', () => {
    // base64 needs 0-2 '=' padding chars depending on input length mod 3;
    // exercise a few different payload sizes to hit each padding case.
    for (const filler of ['a', 'ab', 'abc', 'abcd']) {
      const payload = { id: filler, username: 'u', exp: 1 }
      expect(decodeJwtPayloadUnverified(fakeJwt(payload))).toEqual(payload)
    }
  })

  it('does not throw on a real Node-generated JWT-shaped token, just decodes what it can', () => {
    // Real PTP tokens don't include discord_id for anonymous-provider users
    // in every case (§8.2 code reads it as optional) — make sure absence
    // doesn't break decoding.
    const token = fakeJwt({ id: 'u2', username: 'NoDiscordLink', exp: 999 })
    const decoded = decodeJwtPayloadUnverified(token)
    expect(decoded?.discord_id).toBeUndefined()
    expect(decoded?.username).toBe('NoDiscordLink')
  })
})
