import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { buildCancelledPodMessage } from '../discord/podMessage.js'
import { describeCandidates, ephemeral, getOption } from './helpers.js'
import type { CommandHandler } from './types.js'

// INTEGRATIONS.md §7.4/§7.5 step 5 — cancels an in-progress round for the
// organizer and edits every target guild's RSVP message to show it's
// cancelled. GitHub issue #6: an organizer with more than one
// simultaneous active round can target a specific one via the optional
// `round` option; omitting it still works exactly as before when there's
// only one candidate (see services/pods.ts's cancelActiveRound for what
// "in-progress" and the no-argument fallback mean precisely).
export const cancelPod: CommandHandler = async ({ interaction, backend, discordRest }) => {
  const organizerId = interaction.member?.user.id ?? interaction.user?.id
  if (!organizerId) {
    return ephemeral('Could not determine your Discord user ID.')
  }

  const roundOption = getOption(interaction, 'round')
  const organizerRoundNumber = roundOption?.type === ApplicationCommandOptionType.Integer ? roundOption.value : undefined

  // Only worth checking for ambiguity when the organizer didn't already
  // name a specific round — an explicit round number goes straight to
  // cancelActiveRound below, which resolves it exactly.
  if (organizerRoundNumber === undefined) {
    const candidates = await backend.listActiveRounds(organizerId, 'cancellable')
    if (candidates.length > 1) {
      return ephemeral(
        `You have multiple active rounds — specify which one: \`/cancel-pod round:<number>\`.\n` +
          `Your active rounds: ${describeCandidates(candidates)}.`
      )
    }
  }

  const result = await backend.cancelActiveRound(organizerId, organizerRoundNumber)
  if (!result) {
    return ephemeral("You don't have an active pod round to cancel.")
  }

  const body = buildCancelledPodMessage(result.setCode, result.organizerRoundNumber, result.originGuildName)
  await Promise.allSettled(
    result.targets
      .filter((target) => target.messageId)
      .map((target) =>
        discordRest.editMessage(target.channelId, target.messageId as string, {
          embeds: body.embeds,
          components: body.components,
        })
      )
  )

  return ephemeral(`Cancelled your ${result.setCode} round.`)
}
