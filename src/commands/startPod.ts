import {
  ApplicationCommandOptionType,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
} from 'discord-api-types/v10'
import { ephemeral, getOption } from './helpers.js'
import type { CommandHandler } from './types.js'

const DEFAULT_THRESHOLD = 8

// INTEGRATIONS.md §7.4/§7.5 step 1 — presents the organizer's eligible
// guilds (open-policy + allow-listed) as a select menu. The actual fan-out
// happens on the select's MESSAGE_COMPONENT submit (see components.ts);
// set/threshold are packed into custom_id since interactions are stateless
// per-request (§7.4 scale note: 25-option cap on select menus).
export const startPod: CommandHandler = async ({ interaction, backend }) => {
  const organizerId = interaction.member?.user.id ?? interaction.user?.id
  if (!organizerId) {
    return ephemeral('Could not determine your Discord user ID.')
  }

  const setOption = getOption(interaction, 'set')
  if (!setOption || setOption.type !== ApplicationCommandOptionType.String) {
    return ephemeral('A set code is required, e.g. `/start-pod set:JTL`.')
  }
  const thresholdOption = getOption(interaction, 'threshold')
  const threshold =
    thresholdOption?.type === ApplicationCommandOptionType.Integer
      ? thresholdOption.value
      : DEFAULT_THRESHOLD

  const eligibleGuilds = await backend.listEligibleGuilds(organizerId)
  if (eligibleGuilds.length === 0) {
    return ephemeral(
      "You're not approved to post into any subscribed servers yet. Ask a server admin to run `/allow-organizer` for you, or `/subscribe-guild` in an open-policy server."
    )
  }

  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      flags: MessageFlags.Ephemeral,
      content: `Pick which server(s) to post this ${setOption.value} round (threshold ${threshold}) into:`,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: `start-pod:select-guilds:${setOption.value}:${threshold}`,
              min_values: 1,
              max_values: Math.min(eligibleGuilds.length, 25),
              options: eligibleGuilds.slice(0, 25).map((guild) => ({
                label: guild.name,
                value: guild.guildId,
              })),
            },
          ],
        },
      ],
    },
  }
}
