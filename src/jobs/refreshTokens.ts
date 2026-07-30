import type { AppStorage } from '../storage/appStorage.js'
import type { PtpClient } from '../ptp/client.js'
import { decryptToken, encryptToken } from '../crypto/tokenCrypto.js'
import { decodeJwtPayloadUnverified } from '../util/jwt.js'

const REFRESH_WINDOW_DAYS = 5

// INTEGRATIONS.md §8.3 — proactively rotate tokens before their 30-day
// expiry using /api/auth/refresh's Set-Cookie response, so organizers don't
// have to manually re-run /connect-ptp every month. worker.ts's scheduled()
// handler calls this on Cron Triggers, on a daily schedule.
export async function refreshExpiringTokens(storage: AppStorage, ptp: PtpClient, tokenEncryptionKey: string) {
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
