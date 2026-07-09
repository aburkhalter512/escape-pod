import {
  InteractionResponseType,
  InteractionType,
  type APIInteraction,
  type APIInteractionResponse,
} from 'discord-api-types/v10'
import type { BackendClient } from '../backendClient.js'
import { commandHandlers } from '../commands/index.js'
import { handleMessageComponent, handleModalSubmit } from './components.js'

export async function routeInteraction(
  interaction: APIInteraction,
  backend: BackendClient
): Promise<APIInteractionResponse> {
  switch (interaction.type) {
    case InteractionType.Ping:
      return { type: InteractionResponseType.Pong }

    case InteractionType.ApplicationCommand: {
      const handler = commandHandlers[interaction.data.name]
      if (!handler) {
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: { content: `Unknown command: ${interaction.data.name}` },
        }
      }
      // Narrowed by discord-api-types unions elsewhere; ChatInput is the
      // only command type we register (see commands/definitions.ts).
      return handler({ interaction: interaction as never, backend })
    }

    case InteractionType.MessageComponent:
      return handleMessageComponent(interaction, backend)

    case InteractionType.ModalSubmit:
      return handleModalSubmit(interaction, backend)

    default:
      return {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: 'Unsupported interaction type.' },
      }
  }
}
