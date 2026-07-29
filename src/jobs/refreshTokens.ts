import type { AppPrismaClient } from '../prismaClient.js'
import type { AppStorage } from '../storage/appStorage.js'
import { createPrismaAppStorage } from '../storage/prismaAppStorage.js'
import type { PtpClient } from '../ptp/client.js'
import { decryptToken, encryptToken } from '../crypto/tokenCrypto.js'
import { decodeJwtPayloadUnverified } from '../util/jwt.js'

const REFRESH_WINDOW_DAYS = 5

// INTEGRATIONS.md §8.3 — proactively rotate tokens before their 30-day
// expiry using /api/auth/refresh's Set-Cookie response, so organizers don't
// have to manually re-run /connect-ptp every month. Runs on a daily
// schedule — see server.ts's `sweeps` registration on createGracefulShutdown
// (shutdown.ts) for AWS, unchanged; worker.ts's scheduled() handler calls
// refreshExpiringTokensForStorage below for Cron Triggers instead.
//
// Kept as a real AppPrismaClient param (not a union with AppStorage) so
// server.ts never needs to change what it constructs/passes in — an
// earlier version of this tried a runtime type-sniffing discriminant
// (checking for Prisma's $transaction method) to accept either shape in
// one function, matching backendClient.ts's LocalBackendClientDeps
// pattern; that discriminant turned out to be unsound (AppPrismaClient's
// own declared interface never includes $transaction, so testUtils/
// fakePrismaClient.ts's fixture — and any other AppPrismaClient-shaped
// object — was silently misclassified as AppStorage, confirmed via a
// fresh-eyes review). AppStorage and AppPrismaClient are deliberately
// near-identical in shape (that's the point of the pairing), so no
// reliable structural discriminant exists between them — hence two
// separate functions below instead, sharing one private implementation.
export async function refreshExpiringTokens(prisma: AppPrismaClient, ptp: PtpClient, tokenEncryptionKey: string) {
  return runRefresh(createPrismaAppStorage(prisma), ptp, tokenEncryptionKey)
}

// The Worker/DO-side counterpart — already has a real AppStorage on hand
// (the DO's own this.appStorage), no Prisma client to adapt from.
export async function refreshExpiringTokensForStorage(storage: AppStorage, ptp: PtpClient, tokenEncryptionKey: string) {
  return runRefresh(storage, ptp, tokenEncryptionKey)
}

async function runRefresh(storage: AppStorage, ptp: PtpClient, tokenEncryptionKey: string) {
  const cutoff = new Date(Date.now() + REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const expiring = await storage.organizer.findExpiringBefore(cutoff)

  let refreshed = 0
  let failed = 0

  for (const organizer of expiring) {
    const currentToken = decryptToken(organizer.encryptedToken, tokenEncryptionKey)
    const newToken = await ptp.refreshToken(currentToken)

    if (!newToken) {
      failed++
      // TODO: DM the organizer to re-run /connect-ptp (§8.3 fallback) —
      // needs the discord-bot service to expose a notification endpoint,
      // not built yet.
      continue
    }

    const payload = decodeJwtPayloadUnverified(newToken)
    if (!payload) {
      failed++
      continue
    }

    await storage.organizer.updateToken({
      where: { discordId: organizer.discordId },
      data: {
        encryptedToken: encryptToken(newToken, tokenEncryptionKey),
        expiresAt: new Date(payload.exp * 1000),
      },
    })
    refreshed++
  }

  return { refreshed, failed, checked: expiring.length }
}
