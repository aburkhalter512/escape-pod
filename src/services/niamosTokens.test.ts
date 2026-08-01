import { describe, expect, it } from 'vitest'
import { createFakeAppSqlStorage } from '../testUtils/fakeAppSqlStorage.js'
import { createFakeNiamosClient } from '../testUtils/fakeNiamosClient.js'
import { stub } from '../testUtils/stub.js'
import { linkNiamosGuildToken, type NiamosTokenServiceDeps } from './niamosTokens.js'

const TOKEN_KEY = '00'.repeat(32)

describe('linkNiamosGuildToken', () => {
  it('returns a validation error when Niamos rejects the token, without storing anything', async () => {
    const linkToken = stub(async () => {
      throw new Error('guildNiamosToken.linkToken should not have been called')
    })
    const deps: NiamosTokenServiceDeps = {
      storage: createFakeAppSqlStorage({ guildNiamosToken: { linkToken } }),
      niamos: createFakeNiamosClient({ whoami: stub(async () => null) }),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await linkNiamosGuildToken(deps, { guildId: 'guild-1', token: 'nms_bad', linkedBy: 'user-1' })

    expect(result).toEqual({ ok: false, error: { kind: 'validation', message: 'Niamos rejected this token' } })
  })

  it('stores the encrypted token and linked-by user, returning the display name', async () => {
    const linkToken = stub(async (args: { where: { guildId: string }; create: { guildId: string; encryptedToken: string; linkedByDiscordId: string; displayName: string }; update: unknown }) => ({
      guildId: args.create.guildId,
      encryptedToken: args.create.encryptedToken,
      linkedByDiscordId: args.create.linkedByDiscordId,
      linkedAt: new Date(),
      displayName: args.create.displayName,
    }))
    const deps: NiamosTokenServiceDeps = {
      storage: createFakeAppSqlStorage({ guildNiamosToken: { linkToken } }),
      niamos: createFakeNiamosClient({ whoami: stub(async () => ({ displayName: 'Niamos' })) }),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await linkNiamosGuildToken(deps, { guildId: 'guild-1', token: 'nms_good', linkedBy: 'user-1' })

    expect(result).toEqual({ ok: true, value: { displayName: 'Niamos' } })
    expect(linkToken.calls).toHaveLength(1)
    const [args] = linkToken.calls[0]
    expect(args.where).toEqual({ guildId: 'guild-1' })
    expect(args.create.guildId).toBe('guild-1')
    expect(args.create.linkedByDiscordId).toBe('user-1')
    expect(args.create.displayName).toBe('Niamos')
    expect(args.create.encryptedToken).not.toBe('nms_good') // encrypted, not stored in plaintext
  })
})
