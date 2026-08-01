import type { AppStorage } from '../storage/appStorage.js'
import type { NiamosClient } from '../niamos/client.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import { ok, err, validationError, type Result } from './errors.js'

export interface NiamosTokenServiceDeps {
  storage: AppStorage
  niamos: NiamosClient
  tokenEncryptionKey: string
}

export interface LinkNiamosGuildTokenParams {
  guildId: string
  token: string
  linkedBy: string
}

export interface LinkNiamosGuildTokenResult {
  displayName: string
}

// /connect-niamos's live-check + storage half — replaces
// services/organizers.ts's old linkOrganizer (PTP, per-organizer).
// Niamos tokens are scoped to the guild they're linked in, not the
// Discord user who pasted them in — any guild admin can run this, and
// re-running it for an already-linked guild replaces its token (only one
// allowed per guild at a time).
export async function linkNiamosGuildToken(
  deps: NiamosTokenServiceDeps,
  params: LinkNiamosGuildTokenParams
): Promise<Result<LinkNiamosGuildTokenResult>> {
  const { guildId, token, linkedBy } = params

  const whoami = await deps.niamos.whoami(token)
  if (!whoami) {
    return err(validationError('Niamos rejected this token'))
  }

  await deps.storage.guildNiamosToken.linkToken({
    guildId,
    encryptedToken: encryptToken(token, deps.tokenEncryptionKey),
    linkedByDiscordId: linkedBy,
    displayName: whoami.displayName,
  })

  return ok({ displayName: whoami.displayName })
}
