import { ApplicationCommandOptionType } from 'discord-api-types/v10'
import { buildConcludedPodMessage } from '../discord/podMessage.js'
import { describeCandidates, ephemeral, getOption } from './helpers.js'
import type { CommandHandler } from './types.js'

// tasks/010 — manually concludes a finished (POD_CREATED) round for the
// organizer, edits every target guild's RSVP message to show it's
// concluded, and — as a last, best-effort step — deletes the round's
// temporary chat channel (discord/podChat.ts's createPodChatSpace).
// GitHub issue #6: an organizer with more than one simultaneous
// concludable round can target a specific one via the optional `round`
// option; omitting it still works exactly as before when there's only
// one candidate (see services/pods.ts's concludeActiveRound for the
// no-argument fallback). Mirrors commands/cancelPod.ts's shape closely;
// the one addition is the channel cleanup, which must never block the
// ephemeral success reply (a 404 from an already-deleted channel, or a
// permissions issue, is swallowed and logged, same non-blocking
// philosophy as createPodChatSpace itself).
export const concludePod: CommandHandler = async ({ interaction, backend, discordRest }) => {
  const organizerId = interaction.member?.user.id ?? interaction.user?.id
  if (!organizerId) {
    return ephemeral('Could not determine your Discord user ID.')
  }

  const roundOption = getOption(interaction, 'round')
  const organizerRoundNumber = roundOption?.type === ApplicationCommandOptionType.Integer ? roundOption.value : undefined

  if (organizerRoundNumber === undefined) {
    const candidates = await backend.listActiveRounds(organizerId, 'concludable')
    if (candidates.length > 1) {
      return ephemeral(
        `You have multiple rounds ready to conclude — specify which one: \`/conclude-pod round:<number>\`.\n` +
          `Your active rounds: ${describeCandidates(candidates)}.`
      )
    }
  }

  const result = await backend.concludeActiveRound(organizerId, organizerRoundNumber)
  if (!result.ok) {
    return ephemeral(result.error.message)
  }

  const body = buildConcludedPodMessage(result.value.setCode, result.value.organizerRoundNumber, result.value.originGuildName)
  await Promise.allSettled(
    result.value.targets
      .filter((target) => target.messageId)
      .map((target) =>
        discordRest.editMessage(target.channelId, target.messageId as string, {
          embeds: body.embeds,
          components: body.components,
        })
      )
  )

  if (result.value.chatChannelId) {
    try {
      await discordRest.deleteChannel(result.value.chatChannelId)
    } catch (err) {
      console.error(`failed to delete chat channel ${result.value.chatChannelId} for concluded round ${result.value.podRoundId}:`, err)
    }
  }

  return ephemeral(`Concluded your ${result.value.setCode} round.`)
}
