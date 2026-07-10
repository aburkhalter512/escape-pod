import {
  ApplicationCommandOptionType,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
} from 'discord-api-types/v10'
import { ephemeral, getOption } from './helpers.js'
import type { CommandHandler } from './types.js'
import { parseDurationMs } from '../util/duration.js'

const DEFAULT_THRESHOLD = 8

// Policy (what's a *sensible* deadline for this app), not what's
// syntactically a duration — see util/duration.ts. Under 5 minutes isn't
// enough time for anyone to realistically see and click; over 30 days is
// almost certainly a typo.
const MIN_DEADLINE_MS = 5 * 60_000
const MAX_DEADLINE_MS = 30 * 24 * 60 * 60_000

// INTEGRATIONS.md §7.4/§7.5 step 1 — presents the organizer's eligible
// guilds (open-policy + allow-listed) as a select menu. The actual fan-out
// happens on the select's MESSAGE_COMPONENT submit (see components.ts);
// set/threshold/deadline are packed into custom_id since interactions are
// stateless per-request (§7.4 scale note: 25-option cap on select menus).
export const startPod: CommandHandler = async ({ interaction, backend, discordRest }) => {
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

  const deadlineOption = getOption(interaction, 'deadline')
  let deadlineEpochSeconds: number | undefined
  if (deadlineOption?.type === ApplicationCommandOptionType.String) {
    const durationMs = parseDurationMs(deadlineOption.value)
    if (durationMs === null) {
      return ephemeral('Couldn\'t understand that deadline. Use a duration like `2h`, `90m`, or `1d`.')
    }
    if (durationMs < MIN_DEADLINE_MS) {
      return ephemeral('Deadline must be at least 5 minutes out.')
    }
    if (durationMs > MAX_DEADLINE_MS) {
      return ephemeral('Deadline can\'t be more than 30 days out.')
    }
    deadlineEpochSeconds = Math.floor((Date.now() + durationMs) / 1000)
  }

  const eligibleGuilds = await backend.listEligibleGuilds(organizerId)
  if (eligibleGuilds.length === 0) {
    return ephemeral(
      "You're not approved to post into any subscribed servers yet. Ask a server admin to run `/allow-organizer` for you, or `/subscribe-guild` in an open-policy server."
    )
  }

  // Resolved live, not stored — a name cached at /subscribe-guild time
  // would go stale the moment a guild renamed itself. §7.4's 25-option
  // select-menu cap bounds this to at most 25 concurrent lookups; slicing
  // before resolving (not after) avoids wasting calls on guilds that
  // wouldn't fit in the menu anyway. Falls back to the raw guildId per
  // guild (not the whole command) if a lookup fails — e.g. the bot was
  // removed from that guild since it was allow-listed.
  const capped = eligibleGuilds.slice(0, 25)
  const nameLookups = await Promise.allSettled(capped.map((guild) => discordRest.getGuild(guild.guildId)))
  const options = capped.map((guild, i) => {
    const lookup = nameLookups[i]
    return {
      label: lookup.status === 'fulfilled' ? lookup.value.name : guild.guildId,
      value: guild.guildId,
    }
  })

  const deadlineNote = deadlineEpochSeconds ? `, deadline <t:${deadlineEpochSeconds}:R>` : ''

  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      flags: MessageFlags.Ephemeral,
      content: `Pick which server(s) to post this ${setOption.value} round (threshold ${threshold}${deadlineNote}) into:`,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: `start-pod:select-guilds:${setOption.value}:${threshold}:${deadlineEpochSeconds ?? ''}`,
              min_values: 1,
              max_values: options.length,
              options,
            },
          ],
        },
      ],
    },
  }
}
