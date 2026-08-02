import type { AppStorage } from '../storage/appStorage.js'

export interface OrganizerServiceDeps {
  storage: AppStorage
}

export interface EligibleGuild {
  guildId: string
}

export interface ListEligibleGuildsResult {
  guilds: EligibleGuild[]
  // False only distinguishes "no guild anywhere is subscribed" from "guilds
  // are subscribed but none of them trust this origin guild" — the caller
  // (commands/startPod.ts) uses it to show which actually happened instead
  // of one message covering both.
  anySubscribed: boolean
}

// INTEGRATIONS.md §7.4/§7.5 step 1 — guilds a round starting from
// originGuildId may fan out to: the origin guild itself (self-trust, no
// grant needed), plus any other guild that specifically trusts this
// origin guild (see GuildOriginAllowlist, schema.prisma — replaces the
// old per-organizer allowlist; the caller no longer has any bearing on
// eligibility, only *where* /start-pod was run does). No display name
// here — this service never talks to
// Discord's API (only the interaction handlers hold the bot token), and
// a name stored here would go stale the moment a guild renamed itself.
// The caller (startPod.ts) resolves real, current names live via
// discordRest.getGuild() instead.
export async function listEligibleGuilds(
  deps: Pick<OrganizerServiceDeps, 'storage'>,
  originGuildId: string
): Promise<ListEligibleGuildsResult> {
  const eligible = await deps.storage.guildSubscription.findEligibleForOrigin(originGuildId)
  const guilds = eligible.map((guild) => ({ guildId: guild.guildId }))
  if (guilds.length > 0) {
    return { guilds, anySubscribed: true }
  }

  // Only queried when the first result is empty — avoids a second
  // round-trip in the common (eligible-guilds-exist) case.
  const subscribedCount = await deps.storage.guildSubscription.countActiveSubscriptions()
  return { guilds, anySubscribed: subscribedCount > 0 }
}
