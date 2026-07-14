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

// Shared label format for a single round — used both by describeCandidates
// below and directly by interactions/autocomplete.ts's choice-building, so
// what an organizer sees in the ambiguity message matches what they'd see
// in the `round` option's autocomplete dropdown (GitHub issue #6), rather
// than two independently-maintained format strings that could drift.
export function roundLabel(candidate: { setCode: string; organizerRoundNumber: number }): string {
  return `${candidate.setCode} #${candidate.organizerRoundNumber}`
}

export function describeCandidates(candidates: Array<{ setCode: string; organizerRoundNumber: number }>): string {
  return candidates.map(roundLabel).join(', ')
}
