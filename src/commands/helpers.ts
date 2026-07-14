import {
  InteractionResponseType,
  MessageFlags,
  type APIChatInputApplicationCommandInteraction,
  type APIInteractionResponse,
} from 'discord-api-types/v10'

export function getOption(interaction: APIChatInputApplicationCommandInteraction, name: string) {
  return interaction.data.options?.find((opt) => opt.name === name)
}

export function ephemeral(content: string): APIInteractionResponse {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { flags: MessageFlags.Ephemeral, content },
  }
}

// Shared label format for a round in any human-facing list — the
// ambiguity message in cancelPod.ts/concludePod.ts and the `round`
// option's autocomplete choices both use this, so what an organizer
// sees in one matches what they'd see in the other (GitHub issue #6).
export function describeCandidates(candidates: Array<{ setCode: string; organizerRoundNumber: number }>): string {
  return candidates.map((c) => `${c.setCode} #${c.organizerRoundNumber}`).join(', ')
}
