import {
  ApplicationCommandOptionType,
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
} from 'discord-api-types/v10'
import { ephemeral, getOption } from './helpers.js'
import type { CommandHandler } from './types.js'

// Replaces subscribeGuild.ts + connectNiamos.ts's role as the primary
// onboarding path — one command instead of two. /connect-niamos itself
// stays registered separately (commands/index.ts) for re-linking a
// token later without redoing the whole setup.
//
// INTEGRATIONS.md §7.2/§7.4 — a guild's own admin opts their server in
// as an LFG broadcast target, independent of any organizer, and can
// reconfigure its channel afterward through this same command (see
// services/guilds.ts's subscribeGuild for exactly what omitting the
// channel means). `default_member_permissions` on the command
// definition already restricts this to Manage Guild holders.
export const escapePodSetup: CommandHandler = async ({ interaction, backend }) => {
  const guildId = interaction.guild_id
  const invokerId = interaction.member?.user?.id

  if (!guildId || !invokerId) {
    return ephemeral('This command must be run in a server.')
  }

  const channelOption = getOption(interaction, 'channel')
  const channelId =
    channelOption?.type === ApplicationCommandOptionType.Channel ? channelOption.value : undefined

  const result = await backend.subscribeGuild(guildId, invokerId, { channelId })
  if (!result.ok) {
    return ephemeral(result.error.message)
  }
  const { value } = result

  if (!value.subscribed) {
    return ephemeral(
      `This server isn't currently subscribed (last channel: <#${value.broadcastChannelId}>). ` +
        'Run this command again with a channel to resume.'
    )
  }

  const changedSomething = channelId !== undefined
  const summary = `Channel: <#${value.broadcastChannelId}>. Use \`/allow-guild\` to trust another server's organizers.`

  // ephemeral() only takes a plain string — the first-time-setup path
  // below needs a button component, so it builds the raw interaction
  // response directly instead (same shape connectNiamos.ts uses).
  if (!value.isNewSubscription) {
    return ephemeral((changedSomething ? 'Updated. ' : 'Current settings — ') + summary)
  }

  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      flags: MessageFlags.Ephemeral,
      content:
        `Subscribed! ${summary}\n\n` +
        "**Link this server's Niamos token**\n\n" +
        '1. Sign in (if needed) and generate a bot token: https://niamos.net/settings\n' +
        '2. Give it a label, click "generate token", then copy it.\n' +
        '3. Click the button below and paste it in. Only one token is allowed per server — linking again replaces the previous one.',
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              custom_id: 'connect-niamos:open-modal',
              label: 'Paste your token',
            },
          ],
        },
      ],
    },
  }
}
