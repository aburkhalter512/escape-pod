import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { ephemeral, getOption } from './helpers.js'
import type { CommandHandler } from './types.js'

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

  const result = await backend.subscribeGuild(guildId, invokerId, { channelId, policy })
  if (!result.ok) {
    return ephemeral(result.error.message)
  }
  const { value } = result

  if (!value.subscribed) {
    return ephemeral(
      `This server isn't currently subscribed (last channel: <#${value.broadcastChannelId}>, policy: ${POLICY_LABEL[value.postingPolicy]}). ` +
        'Run this command again with a channel to resume.'
    )
  }

  const changedSomething = channelId !== undefined || policy !== undefined
  const summary = `Channel: <#${value.broadcastChannelId}>. Policy: ${POLICY_LABEL[value.postingPolicy]}.`

  return ephemeral(
    (changedSomething ? 'Updated. ' : 'Current settings — ') +
      summary +
      (value.postingPolicy === 'ALLOWLIST' ? ' Use `/allow-guild` to trust an origin server\'s organizers.' : '')
  )
}
