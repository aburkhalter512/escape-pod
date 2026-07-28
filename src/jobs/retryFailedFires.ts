import { buildFireFailedPodMessage, buildPodRoundMessage } from '../discord/podMessage.js'
import { postPodChatWelcomeMessage, refreshPodChatInvite } from '../discord/podChat.js'
import { notifyPlayersByDm } from '../discord/dmSignups.js'
import type { DiscordRestClient } from '../discord/rest.js'
import type { AppPrismaClient } from '../prismaClient.js'
import { createPrismaAppStorage } from '../storage/prismaAppStorage.js'
import type { PtpClient } from '../ptp/client.js'
import type { Logger } from '../services/errors.js'
import * as podsService from '../services/pods.js'
import type { OnRetrySuccessHook } from '../services/pods.js'

// Kept as a real AppPrismaClient shape (not services/pods.js's
// PodServiceDeps directly) so server.ts never needs to change what it
// constructs/passes in — see routes/pods.ts's PodRouteDeps for the same
// pattern and its fuller rationale.
export interface RetryFailedFiresDeps {
  prisma: AppPrismaClient
  ptp: PtpClient
  tokenEncryptionKey: string
  logger: Logger
}

// Intended to run on a periodic schedule (see server.ts's setInterval),
// same as jobs/expirePodRounds.ts — this is the job-orchestration half of
// issue #5's fix: services/pods.ts's retryFailedFires does the DB-only
// retry/give-up decision, this file supplies the Discord-touching pieces
// (a fresh chat invite on a successful retry, editing every target
// message, DMing signed-up players, posting the chat welcome message) and
// fans them out. Mirrors expireOverduePodRounds's exact shape.
export async function retryOverdueFailedFires(
  deps: RetryFailedFiresDeps,
  discordRest: DiscordRestClient
): Promise<{ succeeded: number; gaveUp: number }> {
  const serviceDeps = {
    storage: createPrismaAppStorage(deps.prisma),
    ptp: deps.ptp,
    tokenEncryptionKey: deps.tokenEncryptionKey,
    logger: deps.logger,
  }

  // Only ever asked for a round that already has a chatChannelId (see
  // retryFailedFires's own gating) — never recreates the channel or its
  // permission overwrites, just asks for a fresh invite into the channel
  // createPodChatSpace already made on the original (failed) fire attempt.
  const onRetrySuccess: OnRetrySuccessHook = async (ctx) =>
    refreshPodChatInvite(discordRest, ctx.chatChannelId, (err, msg) => deps.logger.error({ err }, msg))

  const results = await podsService.retryFailedFires(serviceDeps, onRetrySuccess)

  let succeeded = 0
  let gaveUp = 0
  for (const round of results) {
    let body
    if (round.outcome === 'succeeded') {
      succeeded++
      body = buildPodRoundMessage({
        podRoundId: round.podRoundId,
        setCode: round.setCode,
        organizerRoundNumber: round.organizerRoundNumber,
        // A retry-succeeded round has already fired — threshold no longer
        // matters once shareUrl is set (see buildPodRoundMessage), but the
        // type still requires a value.
        threshold: round.count,
        count: round.count,
        shareUrl: round.shareUrl,
        originGuildName: round.originGuildName,
        chatUrl: round.chatUrl,
        signupDiscordIds: round.signupDiscordIds,
      })
    } else {
      gaveUp++
      body = buildFireFailedPodMessage(round.setCode, round.organizerRoundNumber, round.originGuildName)
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
          `failed to edit message for ${round.outcome} pod round retry`
        )
      }
    }

    // Best-effort DM supplement + welcome message into the (already
    // existing) chat channel, only for a round that just fired for the
    // first time on this retry — same "no participant DM for terminal
    // non-success states" convention as expireOverduePodRounds (gave-up
    // gets no DM, same as cancelled/expired don't). The welcome message
    // never happened on the original failed attempt (it only ever posts
    // after a *successful* fire — see discord/podChat.ts), so this is its
    // first and only chance to go out. Run concurrently — independent
    // fan-outs, same as expireOverduePodRounds.
    if (round.outcome === 'succeeded') {
      await Promise.all([
        notifyPlayersByDm(discordRest, round.signupDiscordIds, body, (err, msg) => deps.logger.error({ err }, msg)),
        round.chatChannelId && round.shareUrl
          ? postPodChatWelcomeMessage(
              discordRest,
              round.chatChannelId,
              { shareUrl: round.shareUrl, signupDiscordIds: round.signupDiscordIds },
              (err, msg) => deps.logger.error({ err }, msg)
            )
          : Promise.resolve(),
      ])
    }
  }

  return { succeeded, gaveUp }
}
