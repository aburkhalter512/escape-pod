import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { ephemeral, getOption } from './helpers.js'
import type { CommandHandler } from './types.js'

// Discord's own snowflake ID format — 17-20 digit numeric string. Used to
// catch an obvious typo/paste-error before writing anything, rather than
// silently trusting arbitrary input as a guild id.
const SNOWFLAKE_PATTERN = /^\d{17,20}$/

// Replaces /allow-organizer (commands/allowOrganizer.ts, deprecated) —
// guild admin trusts an entire *origin* guild (wherever an organizer
// runs /start-pod from — see services/organizers.ts's
// listEligibleGuilds) rather than approving individual organizers one at
// a time, so a new person organizing from an already-trusted community
// doesn't need separate approval. Only consulted when this guild's
// policy is `allowlist`.
//
// Discord's slash-command option types have no "pick another guild"
// picker (User/Channel/Role pickers are scoped to the *current* guild
// only) — the admin supplies the origin guild's raw snowflake ID
// directly (via Discord's own "Copy Server ID", Developer Mode). Once
// stored, best-effort resolve and echo back that guild's name via
// discordRest.getGuild for a sanity check — this only succeeds if the
// bot happens to be a member of that guild, which isn't required for
// trust to be meaningful, so a failure here just falls back to
// confirming by raw ID instead of blocking the command.
export const allowGuild: CommandHandler = async ({ interaction, backend, discordRest }) => {
  const guildId = interaction.guild_id
  const invokerId = interaction.member?.user?.id

  if (!guildId || !invokerId) {
    return ephemeral('This command must be run in a server.')
  }

  const option = getOption(interaction, 'origin-server-id')
  if (!option || option.type !== ApplicationCommandOptionType.String) {
    return ephemeral('An origin server ID is required.')
  }

  const originGuildId = option.value.trim()
  if (!SNOWFLAKE_PATTERN.test(originGuildId)) {
    return ephemeral(
      'That doesn\'t look like a valid Discord server ID. Enable Developer Mode, right-click the ' +
        'other server\'s icon, and choose "Copy Server ID".'
    )
  }

  await backend.allowGuild(guildId, originGuildId, invokerId)

  let originGuildName = originGuildId
  try {
    originGuildName = (await discordRest.getGuild(originGuildId)).name
  } catch {
    // Best-effort — the bot doesn't need to be a member of the origin
    // guild for trust to take effect, so a failed lookup here just means
    // no name confirmation, not a blocked command.
  }

  return ephemeral(`Organizers posting from **${originGuildName}** can now post draft pod rounds into this server.`)
}
