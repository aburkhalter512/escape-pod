import type { DiscordRestClient } from './rest.js'
import type { PodRoundMessageBody } from './podMessage.js'

// Best-effort supplement to the "Starting!" broadcast message edit (see
// interactions/components.ts and jobs/expirePodRounds.ts's firing paths) —
// DMs every signed-up player the same fired-state embed/buttons directly, in
// case they don't happen to see the edited message. A DM can silently fail
// (disabled DMs, blocked the bot, no shared guild left, etc.) with no way to
// detect that in advance, so failures here are expected and common: logged
// individually via the passed callback, never thrown, and never allowed to
// affect any other recipient — same Promise.allSettled + per-outcome-
// logging shape as the guild-message fan-outs in expirePodRounds.ts and
// components.ts.
export async function notifyPlayersByDm(
  discordRest: DiscordRestClient,
  discordIds: string[],
  body: PodRoundMessageBody,
  log: (err: unknown, message: string) => void
): Promise<void> {
  const outcomes = await Promise.allSettled(
    discordIds.map(async (discordId) => {
      const channel = await discordRest.createDmChannel(discordId)
      await discordRest.postMessage(channel.id, { embeds: body.embeds, components: body.components })
    })
  )

  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      log(outcome.reason, 'failed to DM signed-up player')
    }
  }
}
