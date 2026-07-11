import { ephemeral } from './helpers.js'
import type { CommandHandler } from './types.js'

// INTEGRATIONS.md §7.2 / §7.4 — the inverse of /subscribe-guild. Soft-
// deletes (see services/guilds.ts's unsubscribeGuild for why a real row
// delete isn't possible for a guild with any round history) — existing
// round history and allow-list entries are untouched, only future
// eligibility checks stop counting this guild. `default_member_permissions`
// on the command definition already restricts this to Manage Guild holders.
export const unsubscribeGuild: CommandHandler = async ({ interaction, backend }) => {
  const guildId = interaction.guild_id

  if (!guildId) {
    return ephemeral('This command must be run in a server.')
  }

  const { wasSubscribed } = await backend.unsubscribeGuild(guildId)

  return ephemeral(
    wasSubscribed
      ? "This server will no longer receive draft pod broadcasts. Run `/subscribe-guild` with a channel any time to resume."
      : "This server wasn't subscribed to begin with."
  )
}
