import type { AppPrismaClient } from '../prismaClient.js'
import type { PtpClient } from '../ptp/client.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import { decodeJwtPayloadUnverified } from '../util/jwt.js'
import { ok, err, validationError, type Result } from './errors.js'

export interface OrganizerServiceDeps {
  prisma: AppPrismaClient
  ptp: PtpClient
  tokenEncryptionKey: string
}

export interface LinkOrganizerParams {
  discordId: string
  token: string
}

export interface LinkOrganizerResult {
  username: string
}

// INTEGRATIONS.md §8.2 step 3(d) + step 4 — the live check + storage half
// of account linking. Structural + anti-mistake checks (a)-(c) already
// happened bot-side before this was called.
export async function linkOrganizer(
  deps: OrganizerServiceDeps,
  params: LinkOrganizerParams
): Promise<Result<LinkOrganizerResult>> {
  const { discordId, token } = params

  const isValid = await deps.ptp.validateToken(token)
  if (!isValid) {
    return err(validationError('PTP rejected this token'))
  }

  const payload = decodeJwtPayloadUnverified(token)
  if (!payload) {
    return err(validationError('Could not read token payload'))
  }

  await deps.prisma.organizer.upsert({
    where: { discordId },
    create: {
      discordId,
      username: payload.username,
      encryptedToken: encryptToken(token, deps.tokenEncryptionKey),
      expiresAt: new Date(payload.exp * 1000),
    },
    update: {
      username: payload.username,
      encryptedToken: encryptToken(token, deps.tokenEncryptionKey),
      expiresAt: new Date(payload.exp * 1000),
    },
  })

  return ok({ username: payload.username })
}

export interface EligibleGuild {
  guildId: string
}

export interface ListEligibleGuildsResult {
  guilds: EligibleGuild[]
  // False only distinguishes "no guild anywhere is subscribed" from "guilds
  // are subscribed but this organizer isn't eligible for any of them" —
  // the caller (commands/startPod.ts) uses it to show which actually
  // happened instead of one message covering both.
  anySubscribed: boolean
}

// INTEGRATIONS.md §7.4/§7.5 step 1 — guilds this organizer may fan a round
// out to: OPEN-policy guilds, plus guilds where they're allow-listed. No
// display name here — this service never talks to Discord's API (only the
// interaction handlers hold the bot token), and a name stored here would
// go stale the moment a guild renamed itself. The caller (startPod.ts)
// resolves real, current names live via discordRest.getGuild() instead.
export async function listEligibleGuilds(
  deps: OrganizerServiceDeps,
  organizerDiscordId: string
): Promise<ListEligibleGuildsResult> {
  const eligible = await deps.prisma.guildSubscription.findMany({
    where: {
      unsubscribedAt: null,
      OR: [{ postingPolicy: 'OPEN' }, { allowlist: { some: { organizerDiscordId } } }],
    },
  })
  const guilds = eligible.map((guild) => ({ guildId: guild.guildId }))
  if (guilds.length > 0) {
    return { guilds, anySubscribed: true }
  }

  // Only queried when the first result is empty — avoids a second
  // round-trip in the common (eligible-guilds-exist) case.
  const subscribedCount = await deps.prisma.guildSubscription.count({ where: { unsubscribedAt: null } })
  return { guilds, anySubscribed: subscribedCount > 0 }
}
