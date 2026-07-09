import { ephemeral } from './helpers.js'
import type { CommandHandler } from './types.js'

// INTEGRATIONS.md §7.4/§7.5 step 5 — cancels the organizer's in-progress
// round. Stubbed: backend needs a way to look up "this organizer's active
// round" (not yet modeled — likely a unique-active-round-per-organizer
// constraint on PodRound, see §7.3) before this can call backend.cancelPod.
export const cancelPod: CommandHandler = async ({ interaction }) => {
  const organizerId = interaction.member?.user.id ?? interaction.user?.id
  if (!organizerId) {
    return ephemeral('Could not determine your Discord user ID.')
  }

  // TODO: backend.findActiveRound(organizerId) -> backend.cancelPod(roundId, organizerId)
  return ephemeral('Cancellation is not wired up yet — see TODO in src/commands/cancelPod.ts.')
}
