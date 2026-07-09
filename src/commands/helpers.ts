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
