import { describe, expect, it } from 'vitest'
import { createFakePrismaClient } from '../testUtils/fakePrismaClient.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { stub } from '../testUtils/stub.js'
import { ValidationError } from './errors.js'
import { linkOrganizer, type OrganizerServiceDeps } from './organizers.js'

const TOKEN_KEY = '00'.repeat(32)

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.sig`
}

const FUTURE_EXP = () => Math.floor(Date.now() / 1000) + 3600

describe('linkOrganizer', () => {
  it('throws ValidationError when PTP does not accept the token, without storing anything', async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: FUTURE_EXP() })
    const upsert = stub(async () => {
      throw new Error('organizer.upsert should not have been called')
    })
    const deps: OrganizerServiceDeps = {
      prisma: createFakePrismaClient({ organizer: { upsert } }),
      ptp: createFakePtpClient({ validateToken: stub(async () => false) }),
      tokenEncryptionKey: TOKEN_KEY,
    }

    await expect(linkOrganizer(deps, { discordId: 'user-1', token })).rejects.toBeInstanceOf(ValidationError)
  })

  it('throws ValidationError when the token cannot be decoded, even if PTP would have accepted it', async () => {
    const upsert = stub(async () => {
      throw new Error('organizer.upsert should not have been called')
    })
    const deps: OrganizerServiceDeps = {
      prisma: createFakePrismaClient({ organizer: { upsert } }),
      ptp: createFakePtpClient({ validateToken: stub(async () => true) }),
      tokenEncryptionKey: TOKEN_KEY,
    }

    await expect(linkOrganizer(deps, { discordId: 'user-1', token: 'not-a-real-jwt' })).rejects.toBeInstanceOf(
      ValidationError
    )
  })
})
