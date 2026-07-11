import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { ephemeral, getOption } from './helpers.js'
import type { CommandHandler } from './types.js'
import { ValidationError } from '../services/errors.js'

const POLICY_LABEL: Record<'OPEN' | 'ALLOWLIST', string> = {
  OPEN: 'Open — any linked organizer can post',
  ALLOWLIST: 'Allow-list — only approved organizers',
}

// INTEGRATIONS.md §7.2 / §7.4 — a guild's own admin opts their server in as
// an LFG broadcast target, independent of any organizer, and can
// reconfigure it afterward through this same command (channel and/or
// policy — see services/guilds.ts's subscribeGuild for exactly what
// omitting one or both means). `default_member_permissions` on the
// command definition already restricts this to Manage Guild holders.
export const subscribeGuild: CommandHandler = async ({ interaction, backend }) => {
  const guildId = interaction.guild_id
  const invokerId = interaction.member?.user?.id

  if (!guildId || !invokerId) {
    return ephemeral('This command must be run in a server.')
  }

  const channelOption = getOption(interaction, 'channel')
  const channelId =
    channelOption?.type === ApplicationCommandOptionType.Channel ? channelOption.value : undefined

  const policyOption = getOption(interaction, 'policy')
  const policy =
    policyOption?.type === ApplicationCommandOptionType.String
      ? (policyOption.value as 'OPEN' | 'ALLOWLIST')
      : undefined

  let result
  try {
    result = await backend.subscribeGuild(guildId, invokerId, { channelId, policy })
  } catch (err) {
    if (err instanceof ValidationError) {
      return ephemeral(err.message)
    }
    throw err
  }

  const changedSomething = channelId !== undefined || policy !== undefined
  const summary = `Channel: <#${result.broadcastChannelId}>. Policy: ${POLICY_LABEL[result.postingPolicy]}.`

  return ephemeral(
    (changedSomething ? 'Updated. ' : 'Current settings — ') +
      summary +
      (result.postingPolicy === 'ALLOWLIST' ? ' Use `/allow-organizer` to approve organizers.' : '')
  )
}
