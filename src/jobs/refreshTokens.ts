import type { AppPrismaClient } from '../prismaClient.js'
import type { PtpClient } from '../ptp/client.js'
import { decryptToken, encryptToken } from '../crypto/tokenCrypto.js'
import { decodeJwtPayloadUnverified } from '../util/jwt.js'

const REFRESH_WINDOW_DAYS = 5

// INTEGRATIONS.md §8.3 — proactively rotate tokens before their 30-day
// expiry using /api/auth/refresh's Set-Cookie response, so organizers don't
// have to manually re-run /connect-ptp every month. Intended to run on a
// daily schedule (not wired to a scheduler yet — this is the job body only).
export async function refreshExpiringTokens(prisma: AppPrismaClient, ptp: PtpClient, tokenEncryptionKey: string) {
  const cutoff = new Date(Date.now() + REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const expiring = await prisma.organizer.findMany({
    where: { expiresAt: { lt: cutoff } },
  })

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

    await prisma.organizer.update({
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
