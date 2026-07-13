import {
  ButtonStyle,
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
import type { PendingStartPodStore } from '../pendingStartPods.js'
import type { OnFiringHook } from '../services/pods.js'
import { buildPodRoundMessage } from '../discord/podMessage.js'
import { createPodChatSpace } from '../discord/podChat.js'
import { notifyPlayersByDm } from '../discord/dmSignups.js'
import { decodeJwtPayloadUnverified } from '../util/jwt.js'

export async function handleMessageComponent(
  interaction: APIMessageComponentInteraction,
  backend: BackendClient,
  discordRest: DiscordRestClient,
  pendingStartPods: PendingStartPodStore
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
    // The raw ID is already in hand from the interaction itself — no
    // lookup needed — and is carried alongside the display name so a
    // firing round can later create its chat channel in this guild (see
    // discord/podChat.ts).
    const originGuildId: string | undefined = interaction.guild_id
    if (interaction.guild_id) {
      try {
        originGuildName = (await discordRest.getGuild(interaction.guild_id)).name
      } catch (err) {
        console.error(`start-pod origin guild lookup failed for ${interaction.guild_id}:`, err)
      }
    }

    // Resolved for display only — Discord's select-menu interaction only
    // echoes back the raw selected values, not the option labels shown in
    // the picker, so this needs resolving again to show real names in the
    // confirmation summary below. Bounded by the same ≤25 select-menu cap
    // as the original picker (§7.4).
    const guildNameLookups = await Promise.allSettled(guildIds.map((id) => discordRest.getGuild(id)))
    const guildLabels = guildIds.map((id, i) => {
      const lookup = guildNameLookups[i]
      return lookup.status === 'fulfilled' ? lookup.value.name : id
    })

    // Doesn't create the round or post anything yet — that only happens
    // once the organizer reviews this summary and presses Send
    // (start-pod:confirm: below). guildIds can't travel in the button's
    // own custom_id (up to 25 Discord snowflakes blows past its 100-char
    // limit), so the pending selection is held server-side instead — see
    // pendingStartPods.ts.
    const token = pendingStartPods.create({
      organizerDiscordId: organizerId,
      setCode,
      threshold,
      scheduledFor,
      originGuildName,
      originGuildId,
      guildIds,
    })

    const deadlineNote = scheduledFor ? `, deadline <t:${Math.floor(scheduledFor.getTime() / 1000)}:R>` : ''

    return {
      type: InteractionResponseType.UpdateMessage,
      data: {
        content: `Ready to post this ${setCode} round (min ${threshold}${deadlineNote}) to: ${guildLabels.join(', ')}.`,
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Success,
                label: 'Send',
                custom_id: `start-pod:confirm:${token}`,
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                label: 'Cancel',
                custom_id: `start-pod:cancel:${token}`,
              },
            ],
          },
        ],
      },
    }
  }

  if (customId.startsWith('start-pod:confirm:')) {
    const [, , token] = customId.split(':')
    const pending = pendingStartPods.get(token)
    if (!pending) {
      return {
        type: InteractionResponseType.UpdateMessage,
        data: { content: "This selection has expired — run `/start-pod` again.", components: [] },
      }
    }
    pendingStartPods.delete(token)
    const { organizerDiscordId, setCode, threshold, scheduledFor, originGuildName, originGuildId, guildIds } = pending

    // §7.5 steps 1-2: backend creates the PodRound + PodRoundTarget rows and
    // returns each target's resolved channel; this posts the actual RSVP
    // message into each one and records the resulting message ID so a
    // later signup's fan-out (step 3) knows what to edit.
    const { podRoundId, targets } = await backend.startPod({
      organizerDiscordId,
      setCode,
      threshold,
      guildIds,
      scheduledFor,
      originGuildName,
      originGuildId,
    })

    const postOutcomes = await Promise.allSettled(
      targets.map(async (target) => {
        const body = buildPodRoundMessage({ podRoundId, setCode, threshold, count: 0, scheduledFor, originGuildName })
        const message = await discordRest.postMessage(target.channelId, {
          embeds: body.embeds,
          components: body.components,
        })
        const recorded = await backend.recordMessagePosted(podRoundId, target.guildId, message.id)
        if (!recorded.ok) {
          // Not exception-based control flow — recordMessagePosted itself
          // never throws. This re-synthesizes a rejection purely so the
          // per-target counting/logging below (already built around
          // Promise.allSettled's rejection-based aggregation) keeps
          // working uniformly for both this and a genuine postMessage
          // failure, since neither this loop nor its caller distinguishes
          // *why* a given target failed, only whether it did.
          throw new Error(`recordMessagePosted failed: ${recorded.error.message}`)
        }
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

    return {
      type: InteractionResponseType.UpdateMessage,
      data: {
        content:
          `Round started for ${setCode} (min ${threshold}) across ${targets.length} server(s).` +
          (failureCount > 0
            ? ` ${failureCount} server(s) failed to post — check the bot has permission in their channel.`
            : ''),
        components: [],
      },
    }
  }

  if (customId.startsWith('start-pod:cancel:')) {
    const [, , token] = customId.split(':')
    pendingStartPods.delete(token)
    return {
      type: InteractionResponseType.UpdateMessage,
      data: { content: 'Cancelled.', components: [] },
    }
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

    // Creates the round's temporary chat channel (in its origin guild) and
    // invites everyone signed up so far, before the PTP pod itself gets
    // created (see services/pods.ts's fireRound) — best-effort, never
    // throws, so a permissions problem in that guild can't block firing.
    const onFiring: OnFiringHook = (ctx) =>
      ctx.originGuildId
        ? createPodChatSpace(discordRest, { ...ctx, originGuildId: ctx.originGuildId }, (err, msg) => console.error(msg, err))
        : Promise.resolve(undefined)

    const signupResult = await backend.recordSignup(
      podRoundId,
      discordId,
      username,
      interaction.guild_id ?? '',
      action,
      onFiring
    )
    if (!signupResult.ok) {
      // Today's only case is "round not found" (e.g. a click on a very
      // old/stale message) — worth a specific message here rather than
      // letting it propagate uncaught to server.ts's generic top-level
      // fallback.
      return ephemeral(signupResult.error.message)
    }
    const result = signupResult.value

    const body = buildPodRoundMessage({
      podRoundId,
      setCode: result.setCode,
      threshold: result.threshold,
      count: result.count,
      shareUrl: result.shareUrl,
      originGuildName: result.originGuildName,
      chatUrl: result.chatUrl,
      scheduledFor: result.scheduledFor ?? undefined,
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
    // start fanning out to dozens of guilds. Runs alongside a best-effort
    // DM to every signed-up player (a supplement, not a replacement — see
    // discord/dmSignups.ts), only once the round has actually fired.
    await Promise.all([
      Promise.allSettled(
        result.targets
          .filter((target) => target.guildId !== interaction.guild_id && target.messageId)
          .map((target) =>
            discordRest.editMessage(target.channelId, target.messageId as string, {
              embeds: body.embeds,
              components: body.components,
            })
          )
      ),
      result.podCreated
        ? notifyPlayersByDm(discordRest, result.signupDiscordIds ?? [], body, (err, msg) => console.error(msg, err))
        : Promise.resolve(),
    ])

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

  const result = await backend.linkOrganizer(discordId, token)
  if (!result.ok) {
    // Surfaces the real reason (e.g. "PTP rejected this token" vs. "Could
    // not read token payload") instead of one fixed message regardless of
    // cause. Any genuinely unexpected failure (not this Result's concern)
    // propagates uncaught to server.ts's single /interactions catch-all.
    return ephemeral(result.error.message)
  }
  return ephemeral(`Linked as **${result.value.username}** ✅ — you can now run \`/start-pod\`.`)
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
