import { buildExpiredPodMessage, buildPodRoundMessage } from '../discord/podMessage.js'
import type { DiscordRestClient } from '../discord/rest.js'
import * as podsService from '../services/pods.js'
import type { PodServiceDeps } from '../services/pods.js'

// Intended to run on a periodic schedule (see server.ts's setInterval) —
// unlike jobs/refreshTokens.ts's job body, this one needs Discord access
// (editing every target guild's RSVP message once a round expires or
// fires at the deadline), so it also mirrors commands/cancelPod.ts's
// service-call-then-edit-messages shape rather than being a pure DB job.
export async function expireOverduePodRounds(
  deps: PodServiceDeps,
  discordRest: DiscordRestClient
): Promise<{ expired: number; fired: number }> {
  const results = await podsService.expireOverdueRounds(deps)

  let expired = 0
  let fired = 0
  for (const round of results) {
    let body
    if (round.outcome === 'fired') {
      fired++
      body = buildPodRoundMessage({
        podRoundId: round.podRoundId,
        setCode: round.setCode,
        threshold: round.threshold,
        count: round.count,
        shareUrl: round.shareUrl,
      })
    } else {
      expired++
      body = buildExpiredPodMessage(round.setCode)
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
  }

  return { expired, fired }
}
