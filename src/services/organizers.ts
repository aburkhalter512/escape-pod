import type { AppPrismaClient } from '../prismaClient.js'
import type { PtpClient } from '../ptp/client.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import { decodeJwtPayloadUnverified } from '../util/jwt.js'
import { ValidationError } from './errors.js'

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
): Promise<LinkOrganizerResult> {
  const { discordId, token } = params

  const isValid = await deps.ptp.validateToken(token)
  if (!isValid) {
    throw new ValidationError('PTP rejected this token')
  }

  const payload = decodeJwtPayloadUnverified(token)
  if (!payload) {
    throw new ValidationError('Could not read token payload')
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

  return { username: payload.username }
}

export interface EligibleGuild {
  guildId: string
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
): Promise<EligibleGuild[]> {
  const guilds = await deps.prisma.guildSubscription.findMany({
    where: {
      OR: [{ postingPolicy: 'OPEN' }, { allowlist: { some: { organizerDiscordId } } }],
    },
  })

  return guilds.map((guild) => ({ guildId: guild.guildId }))
}
