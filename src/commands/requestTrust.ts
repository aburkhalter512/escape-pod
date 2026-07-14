import { ephemeral } from './helpers.js'
import type { CommandHandler } from './types.js'

// Generates the exact /allow-guild invocation for *this* server, so an
// admin here doesn't need Developer Mode to find their own server's raw
// snowflake ID before asking another community's admin to trust it —
// see commands/allowGuild.ts, which is the command this message is meant
// to be pasted into.
export const requestTrust: CommandHandler = async ({ interaction, discordRest }) => {
  const guildId = interaction.guild_id
  if (!guildId) {
    return ephemeral('This command must be run in a server.')
  }

  let guildName = guildId
  try {
    guildName = (await discordRest.getGuild(guildId)).name
  } catch {
    // Best-effort — falls back to just the raw ID if the bot can't
    // resolve a display name for some reason.
  }

  return ephemeral(
    `Share this with an admin of the other server: \`/allow-guild origin-server-id:${guildId}\` — ` +
      `it lets organizers posting from **${guildName}** post draft pod rounds into theirs.`
  )
}
