import type { APIChatInputApplicationCommandInteraction, APIInteractionResponse } from 'discord-api-types/v10'
import type { BackendClient } from '../backendClient.js'

export interface CommandContext {
  interaction: APIChatInputApplicationCommandInteraction
  backend: BackendClient
}

export type CommandHandler = (ctx: CommandContext) => Promise<APIInteractionResponse>
