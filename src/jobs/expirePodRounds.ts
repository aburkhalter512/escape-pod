import { buildExpiredPodMessage, buildPodRoundMessage } from '../discord/podMessage.js'
import { createPodChatSpace, postPodChatWelcomeMessage } from '../discord/podChat.js'
import { notifyPlayersByDm } from '../discord/dmSignups.js'
import type { DiscordRestClient } from '../discord/rest.js'
import * as podsService from '../services/pods.js'
import type { PodServiceDeps, OnFiringHook } from '../services/pods.js'

// Intended to run on a periodic schedule (see server.ts's setInterval) —
// unlike jobs/refreshTokens.ts's job body, this one needs Discord access
// (editing every target guild's RSVP message once a round expires or
// fires at the deadline), so it also mirrors commands/cancelPod.ts's
// service-call-then-edit-messages shape rather than being a pure DB job.
export async function expireOverduePodRounds(
  deps: PodServiceDeps,
  discordRest: DiscordRestClient
): Promise<{ expired: number; fired: number }> {
  // Same "create the chat channel and invite everyone before the PTP pod"
  // sequencing as interactions/components.ts's pod-signup: handler — see
  // services/pods.ts's fireRound for where this actually runs. Adapts
  // createPodChatSpace's { channelId, inviteUrl } into the hook's
  // { channelId, chatUrl } shape.
  const onFiring: OnFiringHook = async (ctx) => {
    if (!ctx.originGuildId) return undefined
    const chatSpace = await createPodChatSpace(discordRest, { ...ctx, originGuildId: ctx.originGuildId }, (err, msg) =>
      deps.logger.error({ err }, msg)
    )
    return chatSpace ? { channelId: chatSpace.channelId, chatUrl: chatSpace.inviteUrl } : undefined
  }

  const results = await podsService.expireOverdueRounds(deps, onFiring)

  let expired = 0
  let fired = 0
  for (const round of results) {
    let body
    if (round.outcome === 'fired') {
      fired++
      body = buildPodRoundMessage({
        podRoundId: round.podRoundId,
        setCode: round.setCode,
        organizerRoundNumber: round.organizerRoundNumber,
        threshold: round.threshold,
        count: round.count,
        shareUrl: round.shareUrl,
        originGuildName: round.originGuildName,
        chatUrl: round.chatUrl,
        signupDiscordIds: round.signupDiscordIds,
      })
    } else {
      expired++
      body = buildExpiredPodMessage(round.setCode, round.organizerRoundNumber, round.originGuildName)
    }

    const outcomes = await Promise.allSettled(
      round.targets
        .filter((target) => target.messageId)
        .map((target) =>
          discordRest.editMessage(target.channelId, target.messageId as string, {
            embeds: body.embeds,
            components: body.components,
          })
        )
    )
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        deps.logger.error(
          { err: outcome.reason, podRoundId: round.podRoundId },
          `failed to edit message for ${round.outcome} pod round`
        )
      }
    }

    // Best-effort DM supplement, and a best-effort welcome message into the
    // chat channel onFiring created above, only once a round has actually
    // fired (a stuck THRESHOLD_REACHED round from a failed PTP call never
    // reaches 'fired' — see fireRound — so there's no "Starting!" state to
    // DM out or channel to post into). Run concurrently — independent
    // fan-outs, same as elsewhere in this file.
    if (round.outcome === 'fired') {
      await Promise.all([
        notifyPlayersByDm(discordRest, round.signupDiscordIds ?? [], body, (err, msg) => deps.logger.error({ err }, msg)),
        round.chatChannelId && round.shareUrl
          ? postPodChatWelcomeMessage(
              discordRest,
              round.chatChannelId,
              { shareUrl: round.shareUrl, signupDiscordIds: round.signupDiscordIds ?? [] },
              (err, msg) => deps.logger.error({ err }, msg)
            )
          : Promise.resolve(),
      ])
    }
  }

  return { expired, fired }
}
