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
import type { DiscordRestClient } from '../discord/rest.js'
import type { BackendClient, SignupAction } from '../backendClient.js'
import { buildPodRoundMessage } from '../discord/podMessage.js'
import { decodeJwtPayloadUnverified } from '../util/jwt.js'

export async function handleMessageComponent(
  interaction: APIMessageComponentInteraction,
  backend: BackendClient,
  discordRest: DiscordRestClient
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
    const [, , setCode, thresholdStr, deadlineStr] = customId.split(':')
    const threshold = Number.parseInt(thresholdStr, 10)
    // Empty segment (no deadline was set) parses to NaN — normalize that
    // to undefined rather than threading a NaN Date through to Prisma.
    const deadlineEpochSeconds = deadlineStr ? Number.parseInt(deadlineStr, 10) : NaN
    const scheduledFor = Number.isNaN(deadlineEpochSeconds) ? undefined : new Date(deadlineEpochSeconds * 1000)
    const organizerId = interaction.member?.user.id ?? interaction.user?.id
    const guildIds = interaction.data.values ?? []

    if (!organizerId) {
      return ephemeral('Could not determine your Discord user ID.')
    }

    // Resolved once, here, and stored on the round (see
    // services/pods.ts's StartPodParams) rather than looked up again on
    // every later message edit — a guild receiving a cross-posted round
    // (INTEGRATIONS.md §1) sees where it came from. No guild_id (e.g. a
    // DM-context invocation) or a failed lookup both just omit it.
    let originGuildName: string | undefined
    if (interaction.guild_id) {
      try {
        originGuildName = (await discordRest.getGuild(interaction.guild_id)).name
      } catch (err) {
        console.error(`start-pod origin guild lookup failed for ${interaction.guild_id}:`, err)
      }
    }

    // §7.5 steps 1-2: backend creates the PodRound + PodRoundTarget rows and
    // returns each target's resolved channel; this posts the actual RSVP
    // message into each one and records the resulting message ID so a
    // later signup's fan-out (step 3) knows what to edit.
    const { podRoundId, targets } = await backend.startPod({
      organizerDiscordId: organizerId,
      setCode,
      threshold,
      guildIds,
      scheduledFor,
      originGuildName,
    })

    const postOutcomes = await Promise.allSettled(
      targets.map(async (target) => {
        const body = buildPodRoundMessage({ podRoundId, setCode, threshold, count: 0, scheduledFor, originGuildName })
        const message = await discordRest.postMessage(target.channelId, {
          embeds: body.embeds,
          components: body.components,
        })
        await backend.recordMessagePosted(podRoundId, target.guildId, message.id)
      })
    )
    // Promise.allSettled only exposes each rejection's reason on the
    // outcome object itself — swallowing it here (as this used to) meant
    // "N server(s) failed to post" was the only signal available,
    // regardless of whether the real cause was a permissions issue, the
    // bot not actually being in that guild, a deleted channel, or
    // anything else. Logging each one gives that back without changing
    // the user-facing message.
    for (const [i, outcome] of postOutcomes.entries()) {
      if (outcome.status === 'rejected') {
        console.error(`start-pod post failed for guild ${targets[i].guildId}:`, outcome.reason)
      }
    }
    const failureCount = postOutcomes.filter((outcome) => outcome.status === 'rejected').length

    return ephemeral(
      `Round started for ${setCode} (min ${threshold}) across ${targets.length} server(s).` +
        (failureCount > 0
          ? ` ${failureCount} server(s) failed to post — check the bot has permission in their channel.`
          : '')
    )
  }

  if (customId.startsWith('pod-signup:')) {
    const [, podRoundId, actionRaw] = customId.split(':')
    // Both values come from custom_ids we generate ourselves
    // (podMessage.ts), but default to 'in' defensively rather than assume.
    const action: SignupAction = actionRaw === 'leave' ? 'leave' : 'in'
    const discordId = interaction.member?.user?.id ?? interaction.user?.id
    const username = interaction.member?.user?.username ?? interaction.user?.username

    if (!discordId || !username) {
      return ephemeral('Could not determine your Discord identity.')
    }

    const result = await backend.recordSignup(podRoundId, discordId, username, interaction.guild_id ?? '', action)

    const body = buildPodRoundMessage({
      podRoundId,
      setCode: result.setCode,
      threshold: result.threshold,
      count: result.count,
      shareUrl: result.shareUrl,
      originGuildName: result.originGuildName,
    })

    // Fan the same update out to every OTHER target guild's message — the
    // interaction response below already updates the one this click came
    // from. §7.5 step 3's shared counter only feels shared if every server
    // sees it move. Skips targets with no recorded messageId (either the
    // initial post to that guild failed, or it just hasn't landed yet).
    // Awaited inline (not backgrounded) to keep this simple, which trades
    // away some headroom against Discord's 3-second interaction-response
    // budget as the guild count grows — fine at the scale this is designed
    // for (a handful of sister communities), worth revisiting if rounds
    // start fanning out to dozens of guilds.
    await Promise.allSettled(
      result.targets
        .filter((target) => target.guildId !== interaction.guild_id && target.messageId)
        .map((target) =>
          discordRest.editMessage(target.channelId, target.messageId as string, {
            embeds: body.embeds,
            components: body.components,
          })
        )
    )

    return {
      type: InteractionResponseType.UpdateMessage,
      data: { embeds: body.embeds, components: body.components },
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
  } catch (err) {
    // Was previously a bare `catch {}` — swallowed the real cause
    // entirely (PTP genuinely rejecting the token vs. a Prisma error vs.
    // anything else all produced the exact same message, and nothing was
    // logged anywhere to tell them apart). console.error always reaches
    // CloudWatch via the awslogs driver regardless of Fastify's own
    // logger config, and this function has no request/reply to log
    // through instead.
    console.error('connect-ptp linkOrganizer failed:', err)
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
// Exported for direct unit testing of both shapes — see components.test.ts.
export function extractTextInputValue(
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
