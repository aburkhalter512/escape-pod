import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { zodValidatorCompiler } from '../validation.js'
import type { AppPrismaClient } from '../prismaClient.js'
import type { PtpClient } from '../ptp/client.js'
import { decryptToken } from '../crypto/tokenCrypto.js'
import { createFakePrismaClient, type FakePrismaOverrides } from '../testUtils/fakePrismaClient.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { stub } from '../testUtils/stub.js'
import { deepEqual } from '../testUtils/deepEqual.js'
import { registerOrganizerRoutes } from './organizers.js'

const TOKEN_KEY = '00'.repeat(32)

type OrganizerUpsertArgs = Parameters<AppPrismaClient['organizer']['upsert']>[0]
type OrganizerRow = Awaited<ReturnType<AppPrismaClient['organizer']['upsert']>>

function fakeOrganizerRow(overrides: Partial<OrganizerRow> = {}): OrganizerRow {
  return {
    discordId: 'user-1',
    username: 'PlayerOne',
    encryptedToken: 'unused-in-response',
    expiresAt: new Date(),
    linkedAt: new Date(),
    nextRoundNumber: 1,
    ...overrides,
  }
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.sig`
}

const FUTURE_EXP = () => Math.floor(Date.now() / 1000) + 3600

function buildApp(overrides: { prisma?: FakePrismaOverrides; ptp?: Partial<PtpClient> } = {}) {
  const app = Fastify()
  app.setValidatorCompiler(zodValidatorCompiler)
  const prisma = createFakePrismaClient(overrides.prisma)
  const ptp = createFakePtpClient({ validateToken: stub(async (_token: string) => true), ...overrides.ptp })

  // Must be a real 32-byte hex string — encryptToken calls createCipheriv
  // synchronously, so an invalid key throws and the route 500s.
  registerOrganizerRoutes(app, { prisma, ptp, tokenEncryptionKey: TOKEN_KEY })
  return { app, prisma, ptp }
}

describe('POST /organizers/link', () => {
  it('validates the token against PTP, then upserts the organizer and returns the username', async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: FUTURE_EXP() })
    const validateToken = stub(async (t: string) => t === token)
    const upsert = stub(async (args: OrganizerUpsertArgs) => {
      const updateEncryptedToken = args.update.encryptedToken
      const valid =
        deepEqual(args.where, { discordId: 'user-1' }) &&
        args.create.discordId === 'user-1' &&
        args.create.username === 'PlayerOne' &&
        args.update.username === 'PlayerOne' &&
        typeof updateEncryptedToken === 'string' &&
        decryptToken(args.create.encryptedToken, TOKEN_KEY) === token &&
        decryptToken(updateEncryptedToken, TOKEN_KEY) === token
      if (!valid) throw new Error(`unexpected organizer.upsert args: ${JSON.stringify(args)}`)
      return fakeOrganizerRow()
    })
    const { app } = buildApp({ ptp: { validateToken }, prisma: { organizer: { upsert } } })

    const response = await app.inject({
      method: 'POST',
      url: '/organizers/link',
      payload: { discordId: 'user-1', token },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ username: 'PlayerOne' })
  })

  it('computes expiresAt from the token exp claim (seconds -> Date)', async () => {
    const exp = FUTURE_EXP()
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp })
    const upsert = stub(async (_args: OrganizerUpsertArgs) => fakeOrganizerRow())
    const { app } = buildApp({ prisma: { organizer: { upsert } } })

    await app.inject({ method: 'POST', url: '/organizers/link', payload: { discordId: 'user-1', token } })

    expect(upsert.calls[0][0].create.expiresAt).toEqual(new Date(exp * 1000))
  })

  it('rejects with 422 when PTP does not accept the token, without storing anything', async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: FUTURE_EXP() })
    const upsert = stub(async (_args: OrganizerUpsertArgs) => fakeOrganizerRow())
    const { app } = buildApp({ ptp: { validateToken: stub(async (_t: string) => false) }, prisma: { organizer: { upsert } } })

    const response = await app.inject({
      method: 'POST',
      url: '/organizers/link',
      payload: { discordId: 'user-1', token },
    })

    expect(response.statusCode).toBe(422)
    expect(upsert.calls).toHaveLength(0)
  })

  it('rejects with 422 when the token cannot be decoded, even if PTP would have accepted it', async () => {
    const upsert = stub(async (_args: OrganizerUpsertArgs) => fakeOrganizerRow())
    const { app } = buildApp({ prisma: { organizer: { upsert } } })

    const response = await app.inject({
      method: 'POST',
      url: '/organizers/link',
      payload: { discordId: 'user-1', token: 'not-a-real-jwt' },
    })

    expect(response.statusCode).toBe(422)
    expect(upsert.calls).toHaveLength(0)
  })

  it('rejects a body missing the token field with 400, before calling PTP', async () => {
    const validateToken = stub(async (_t: string) => true)
    const { app } = buildApp({ ptp: { validateToken } })

    const response = await app.inject({
      method: 'POST',
      url: '/organizers/link',
      payload: { discordId: 'user-1' },
    })

    expect(response.statusCode).toBe(400)
    expect(validateToken.calls).toHaveLength(0)
  })

  it('rejects an empty-string discordId with 400', async () => {
    const validateToken = stub(async (_t: string) => true)
    const { app } = buildApp({ ptp: { validateToken } })

    const response = await app.inject({
      method: 'POST',
      url: '/organizers/link',
      payload: { discordId: '', token: 'some-token' },
    })

    expect(response.statusCode).toBe(400)
    expect(validateToken.calls).toHaveLength(0)
  })
})
