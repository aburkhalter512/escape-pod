import type { APIChatInputApplicationCommandInteraction, APIInteractionResponse } from 'discord-api-types/v10'
import type { BackendClient } from '../backendClient.js'
import type { DiscordRestClient } from '../discord/rest.js'

export interface CommandContext {
  interaction: APIChatInputApplicationCommandInteraction
  backend: BackendClient
  // Only cancelPod uses this today (editing every target guild's RSVP
  // message to show "Cancelled" — see §7.5 step 5) — the same bot-token
  // REST access handleMessageComponent's start-pod/pod-signup branches
  // already have, extended to slash commands too rather than kept
  // component-only.
  discordRest: DiscordRestClient
}

export type CommandHandler = (ctx: CommandContext) => Promise<APIInteractionResponse>
