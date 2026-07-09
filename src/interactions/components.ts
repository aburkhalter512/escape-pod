import {
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  TextInputStyle,
  type APIMessageComponentInteraction,
  type APIModalSubmitInteraction,
  type APIModalSubmissionComponent,
  type APIInteractionResponse,
} from 'discord-api-types/v10'
import type { BackendClient } from '../backendClient.js'
import { decodeJwtPayloadUnverified } from '../util/jwt.js'

export async function handleMessageComponent(
  interaction: APIMessageComponentInteraction,
  backend: BackendClient
): Promise<APIInteractionResponse> {
  const customId = interaction.data.custom_id

  if (customId === 'connect-ptp:open-modal') {
    return {
      type: InteractionResponseType.Modal,
      data: {
        custom_id: 'connect-ptp:submit',
        title: 'Link your Protect the Pod account',
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.TextInput,
                custom_id: 'ptp-token',
                label: 'Token from /api/auth/token',
                style: TextInputStyle.Short,
                required: true,
                min_length: 20,
              },
            ],
          },
        ],
      },
    }
  }

  if (customId.startsWith('start-pod:select-guilds:') && interaction.data.component_type === ComponentType.StringSelect) {
    const [, , setCode, thresholdStr] = customId.split(':')
    const threshold = Number.parseInt(thresholdStr, 10)
    const organizerId = interaction.member?.user.id ?? interaction.user?.id
    const guildIds = interaction.data.values ?? []

    if (!organizerId) {
      return ephemeral('Could not determine your Discord user ID.')
    }

    // TODO(§7.5 steps 1-2): backend creates the PodRound + PodRoundTarget
    // rows and returns identifiers; a follow-up step (not yet built) then
    // uses src/discord/rest.ts to post the RSVP embed + buttons into each
    // target guild's configured channel.
    await backend.startPod({ organizerDiscordId: organizerId, setCode, threshold, guildIds })

    return ephemeral(`Round started for ${setCode} (threshold ${threshold}) across ${guildIds.length} server(s).`)
  }

  if (customId.startsWith('pod-signup:')) {
    const [, podRoundId, action] = customId.split(':')
    const discordId = interaction.member?.user.id ?? interaction.user?.id
    const username = interaction.member?.user.username ?? interaction.user?.username

    if (!discordId || !username) {
      return ephemeral('Could not determine your Discord identity.')
    }

    // TODO(§7.5 step 3): only handles the message the click happened on.
    // Syncing the shared count to every OTHER target guild's message needs
    // a REST call per message via src/discord/rest.ts — not wired up yet.
    const result = await backend.recordSignup(podRoundId, discordId, username, interaction.guild_id ?? '')
    void action // 'in' | 'leave' — branch not yet implemented in backend.recordSignup

    return {
      type: InteractionResponseType.UpdateMessage,
      data: {
        content: `${result.count}/${result.threshold} confirmed${result.thresholdReached ? ' — pod full!' : ''}`,
      },
    }
  }

  return ephemeral('Unrecognized interaction.')
}

export async function handleModalSubmit(
  interaction: APIModalSubmitInteraction,
  backend: BackendClient
): Promise<APIInteractionResponse> {
  if (interaction.data.custom_id !== 'connect-ptp:submit') {
    return ephemeral('Unrecognized modal.')
  }

  const discordId = interaction.member?.user.id ?? interaction.user?.id
  if (!discordId) {
    return ephemeral('Could not determine your Discord user ID.')
  }

  const token = extractTextInputValue(interaction.data.components, 'ptp-token')
  if (!token) {
    return ephemeral('No token was submitted.')
  }

  // INTEGRATIONS.md §8.2 checks (a)-(c) — structural + anti-mistake — happen
  // here since they're cheap and don't need the backend. Check (d), the live
  // call to PTP, happens backend-side in backend.linkOrganizer.
  const payload = decodeJwtPayloadUnverified(token)
  if (!payload) {
    return ephemeral("That doesn't look like a valid token. Copy the full `token` value from the JSON response.")
  }
  if (payload.discord_id && payload.discord_id !== discordId) {
    return ephemeral('That token belongs to a different Discord account. Make sure you copied your own token.')
  }
  if (payload.exp * 1000 < Date.now()) {
    return ephemeral('That token has already expired — grab a fresh one from /api/auth/token.')
  }

  try {
    const { username } = await backend.linkOrganizer(discordId, token)
    return ephemeral(`Linked as **${username}** ✅ — you can now run \`/start-pod\`.`)
  } catch {
    return ephemeral("PTP didn't accept that token. Grab a fresh one from /api/auth/token and try again.")
  }
}

function ephemeral(content: string): APIInteractionResponse {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { flags: MessageFlags.Ephemeral, content },
  }
}

// Modal submissions can wrap a text input in either a legacy ActionRow or a
// newer Label component (Discord's "Components v2"), so walk both shapes
// rather than assuming one. TextDisplay components carry no value.
function extractTextInputValue(
  components: APIModalSubmissionComponent[],
  customId: string
): string | undefined {
  for (const component of components) {
    if (component.type === ComponentType.ActionRow) {
      const match = component.components.find((input) => input.custom_id === customId)
      if (match) return match.value
    } else if (component.type === ComponentType.Label) {
      const inner = component.component
      if (inner.custom_id === customId && inner.type === ComponentType.TextInput) {
        return inner.value
      }
    }
  }
  return undefined
}
