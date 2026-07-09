import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { ephemeral, getOption } from './helpers.js'
import type { CommandHandler } from './types.js'

// INTEGRATIONS.md §7.2 / §7.4 — guild admin approves a specific organizer
// to post rounds into this server (only consulted when policy is `allowlist`).
export const allowOrganizer: CommandHandler = async ({ interaction, backend }) => {
  const guildId = interaction.guild_id
  const invokerId = interaction.member?.user.id

  if (!guildId || !invokerId) {
    return ephemeral('This command must be run in a server.')
  }

  const organizerOption = getOption(interaction, 'organizer')
  if (!organizerOption || organizerOption.type !== ApplicationCommandOptionType.User) {
    return ephemeral('An organizer to approve is required.')
  }

  await backend.allowOrganizer(guildId, organizerOption.value, invokerId)

  return ephemeral(`<@${organizerOption.value}> can now post draft pod rounds into this server.`)
}
