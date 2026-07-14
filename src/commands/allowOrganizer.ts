import { ephemeral } from './helpers.js'
import type { CommandHandler } from './types.js'

// Deprecated — replaced by /allow-guild (commands/allowGuild.ts), which
// trusts an entire origin server instead of approving organizers one at
// a time. No longer writes anything (services/guilds.ts's allowOrganizer,
// still reachable via BackendClient for the HTTP route, is left inert
// rather than called from here) — just redirects.
export const allowOrganizer: CommandHandler = async ({ interaction }) => {
  const guildId = interaction.guild_id
  if (!guildId) {
    return ephemeral('This command must be run in a server.')
  }

  return ephemeral(
    '`/allow-organizer` is deprecated and no longer grants access — use `/allow-guild` to trust an ' +
      'entire origin server instead of approving organizers one at a time.'
  )
}
