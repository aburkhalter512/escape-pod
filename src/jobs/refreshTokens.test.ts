import { describe, expect, it } from 'vitest'
import { encryptToken, decryptToken } from '../crypto/tokenCrypto.js'
import type { AppStorage } from '../storage/appStorage.js'
import { createFakeAppSqlStorage } from '../testUtils/fakeAppSqlStorage.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { stub } from '../testUtils/stub.js'
import { refreshExpiringTokens } from './refreshTokens.js'

const TOKEN_KEY = '00'.repeat(32)

type OrganizerRow = Awaited<ReturnType<AppStorage['organizer']['findExpiringBefore']>>[number]
type OrganizerUpdateTokenArgs = Parameters<AppStorage['organizer']['updateToken']>[0]

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.sig`
}

function fakeOrganizer(discordId: string, token: string): OrganizerRow {
  return {
    discordId,
    username: 'PlayerOne',
    encryptedToken: encryptToken(token, TOKEN_KEY),
    expiresAt: new Date(),
    linkedAt: new Date(),
    nextRoundNumber: 1,
  }
}

describe('refreshExpiringTokens', () => {
  it('queries for organizers expiring within the refresh window, not all organizers', async () => {
    const findExpiringBefore = stub(async (_cutoff: Date) => [])
    const storage = createFakeAppSqlStorage({ organizer: { findExpiringBefore } })
    const ptp = createFakePtpClient()

    await refreshExpiringTokens(storage, ptp, TOKEN_KEY)

    const cutoff = findExpiringBefore.calls[0][0]
    expect(cutoff).toBeInstanceOf(Date)
    const daysFromNow = (cutoff.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(daysFromNow).toBeGreaterThan(4.9)
    expect(daysFromNow).toBeLessThan(5.1)
  })

  it('rotates the stored token and expiry for an organizer whose refresh succeeds', async () => {
    const oldToken = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: 1000 })
    const newExp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    const newToken = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: newExp })
    const organizer = fakeOrganizer('user-1', oldToken)

    const updateToken = stub(async (args: OrganizerUpdateTokenArgs) => {
      const ciphertext = args.data.encryptedToken
      if (typeof ciphertext !== 'string' || decryptToken(ciphertext, TOKEN_KEY) !== newToken) {
        throw new Error(`unexpected encryptedToken in organizer.updateToken: ${JSON.stringify(args)}`)
      }
      if (!(args.data.expiresAt instanceof Date) || args.data.expiresAt.getTime() !== newExp * 1000) {
        throw new Error(`unexpected expiresAt in organizer.updateToken: ${JSON.stringify(args)}`)
      }
      return organizer
    })
    const storage = createFakeAppSqlStorage({
      organizer: { findExpiringBefore: stub(async (_cutoff: Date) => [organizer]), updateToken },
    })
    const refreshToken = stub(async (token: string) => (token === oldToken ? newToken : null))
    const ptp = createFakePtpClient({ refreshToken })

    const result = await refreshExpiringTokens(storage, ptp, TOKEN_KEY)

    expect(updateToken.calls).toHaveLength(1)
    expect(result).toEqual({ refreshed: 1, failed: 0, checked: 1 })
  })

  it('leaves the organizer untouched and counts it as failed when PTP refuses to refresh', async () => {
    const oldToken = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: 1000 })
    const organizer = fakeOrganizer('user-1', oldToken)

    const updateToken = stub(async (_args: OrganizerUpdateTokenArgs) => {
      throw new Error('organizer.updateToken should not have been called')
    })
    const storage = createFakeAppSqlStorage({
      organizer: { findExpiringBefore: stub(async (_cutoff: Date) => [organizer]), updateToken },
    })
    const ptp = createFakePtpClient({ refreshToken: stub(async (_token: string) => null) })

    const result = await refreshExpiringTokens(storage, ptp, TOKEN_KEY)

    expect(result).toEqual({ refreshed: 0, failed: 1, checked: 1 })
  })

  it('counts it as failed (not a thrown error) when PTP returns a token that fails to decode', async () => {
    const oldToken = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: 1000 })
    const organizer = fakeOrganizer('user-1', oldToken)

    const updateToken = stub(async (_args: OrganizerUpdateTokenArgs) => {
      throw new Error('organizer.updateToken should not have been called')
    })
    const storage = createFakeAppSqlStorage({
      organizer: { findExpiringBefore: stub(async (_cutoff: Date) => [organizer]), updateToken },
    })
    const ptp = createFakePtpClient({ refreshToken: stub(async (_token: string) => 'not-a-valid-jwt') })

    const result = await refreshExpiringTokens(storage, ptp, TOKEN_KEY)

    expect(result).toEqual({ refreshed: 0, failed: 1, checked: 1 })
  })

  it('processes every expiring organizer independently and tallies mixed outcomes', async () => {
    const successToken = fakeJwt({ discord_id: 'user-1', username: 'Success', exp: 1000 })
    const failToken = fakeJwt({ discord_id: 'user-2', username: 'Fail', exp: 1000 })
    const refreshedToken = fakeJwt({
      discord_id: 'user-1',
      username: 'Success',
      exp: Math.floor(Date.now() / 1000) + 1000,
    })

    const organizers = [fakeOrganizer('user-1', successToken), fakeOrganizer('user-2', failToken)]
    const storage = createFakeAppSqlStorage({
      organizer: {
        findExpiringBefore: stub(async (_cutoff: Date) => organizers),
        updateToken: stub(async (_args: OrganizerUpdateTokenArgs) => organizers[0]),
      },
    })
    const ptp = createFakePtpClient({
      refreshToken: stub(async (token: string) => (token === successToken ? refreshedToken : null)),
    })

    const result = await refreshExpiringTokens(storage, ptp, TOKEN_KEY)

    expect(result).toEqual({ refreshed: 1, failed: 1, checked: 2 })
  })

  it('returns all-zero counts when nothing is expiring soon', async () => {
    const storage = createFakeAppSqlStorage({ organizer: { findExpiringBefore: stub(async (_cutoff: Date) => []) } })
    const refreshToken = stub(async (_token: string) => {
      throw new Error('refreshToken should not have been called')
    })
    const ptp = createFakePtpClient({ refreshToken })

    const result = await refreshExpiringTokens(storage, ptp, TOKEN_KEY)

    expect(result).toEqual({ refreshed: 0, failed: 0, checked: 0 })
  })
})
