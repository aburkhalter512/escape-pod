import { buildCancelledPodMessage } from '../discord/podMessage.js'
import { ephemeral } from './helpers.js'
import type { CommandHandler } from './types.js'

// INTEGRATIONS.md §7.4/§7.5 step 5 — cancels the organizer's own
// most-recent in-progress round (see services/pods.ts's cancelActiveRound
// for what "most recent" and "in-progress" mean precisely) and edits
// every target guild's RSVP message to show it's cancelled.
export const cancelPod: CommandHandler = async ({ interaction, backend, discordRest }) => {
  const organizerId = interaction.member?.user.id ?? interaction.user?.id
  if (!organizerId) {
    return ephemeral('Could not determine your Discord user ID.')
  }

  const result = await backend.cancelActiveRound(organizerId)
  if (!result) {
    return ephemeral("You don't have an active pod round to cancel.")
  }

  const body = buildCancelledPodMessage(result.setCode, result.originGuildName)
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
