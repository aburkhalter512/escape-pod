import { ApplicationCommandOptionType, InteractionResponseType, MessageFlags } from 'discord-api-types/v10'
import { ephemeral, getOption } from './helpers.js'
import type { CommandHandler } from './types.js'

// INTEGRATIONS.md §7.2 / §7.4 — a guild's own admin opts their server in as
// an LFG broadcast target, independent of any organizer. `default_member_permissions`
// on the command definition already restricts this to Manage Guild holders.
export const subscribeGuild: CommandHandler = async ({ interaction, backend }) => {
  const guildId = interaction.guild_id
  const invokerId = interaction.member?.user.id

  if (!guildId || !invokerId) {
    return ephemeral('This command must be run in a server.')
  }

  const channelOption = getOption(interaction, 'channel')
  if (!channelOption || channelOption.type !== ApplicationCommandOptionType.Channel) {
    return ephemeral('A channel is required.')
  }

  await backend.subscribeGuild(guildId, channelOption.value, invokerId)

  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      flags: MessageFlags.Ephemeral,
      content: `This server is now subscribed to receive draft pod broadcasts in <#${channelOption.value}>. Default policy is allow-list — use \`/allow-organizer\` to approve organizers.`,
    },
  }
}
