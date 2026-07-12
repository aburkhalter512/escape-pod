import {
  InteractionResponseType,
  InteractionType,
  type APIInteraction,
  type APIInteractionResponse,
} from 'discord-api-types/v10'
import type { DiscordRestClient } from '../discord/rest.js'
import type { BackendClient } from '../backendClient.js'
import type { PendingStartPodStore } from '../pendingStartPods.js'
import { commandHandlers } from '../commands/index.js'
import { handleMessageComponent, handleModalSubmit } from './components.js'

export interface RouterDeps {
  backend: BackendClient
  // Only handleMessageComponent's start-pod/pod-signup branches use this —
  // posting/editing messages in guilds other than the one an interaction
  // occurred in needs the bot token, which the interaction response itself
  // can't do (§7.5 step 3).
  discordRest: DiscordRestClient
  // Only handleMessageComponent's start-pod:select-guilds:/confirm:/cancel:
  // branches use this — holds a guild selection between the "select
  // servers" step and the "Send" confirmation click (see
  // pendingStartPods.ts for why this can't just live in a custom_id).
  pendingStartPods: PendingStartPodStore
}

export async function routeInteraction(
  interaction: APIInteraction,
  deps: RouterDeps
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
      return handler({ interaction: interaction as never, backend: deps.backend, discordRest: deps.discordRest })
    }

    case InteractionType.MessageComponent:
      return handleMessageComponent(interaction, deps.backend, deps.discordRest, deps.pendingStartPods)

    case InteractionType.ModalSubmit:
      return handleModalSubmit(interaction, deps.backend)

    default:
      return {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: 'Unsupported interaction type.' },
      }
  }
}
