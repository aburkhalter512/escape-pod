// The seam between Discord interaction handling and durable state/PTP
// business logic (see INTEGRATIONS.md §7.3, §4.1, §8). This used to be an
// HTTP client to a separate backend service; the two are now one deployed
// process, so LocalBackendClient below calls the extracted services/*
// functions directly, in-process — no serialization, no network round
// trip. commands/* and interactions/* only depend on the BackendClient
// interface, so none of them needed to change for that merge.

import type { AppPrismaClient } from './prismaClient.js'
import type { PtpClient } from './ptp/client.js'
import type { Logger } from './services/errors.js'
import * as podsService from './services/pods.js'
import * as organizersService from './services/organizers.js'
import * as guildsService from './services/guilds.js'

// The RSVP button's two states (§7.3) — see discord/podMessage.ts for
// where the custom_id encoding this comes from, and interactions/
// components.ts for where it's decoded back out.
export type SignupAction = 'in' | 'leave'

// The contract commands/handlers depend on. Real calls happen in
// LocalBackendClient below; tests get a hand-written stub via
// testUtils/fakeBackendClient.ts that fully satisfies this interface, no
// `as unknown as` needed.
export interface BackendClient {
  linkOrganizer(discordId: string, token: string): Promise<{ username: string }>
  subscribeGuild(guildId: string, channelId: string, installedBy: string): Promise<void>
  allowOrganizer(guildId: string, organizerDiscordId: string, approvedBy: string): Promise<void>
  listEligibleGuilds(organizerDiscordId: string): Promise<Array<{ guildId: string; name: string }>>
  startPod(params: {
    organizerDiscordId: string
    setCode: string
    threshold: number
    guildIds: string[]
  }): Promise<{ podRoundId: string; targets: Array<{ guildId: string; channelId: string }> }>
  recordMessagePosted(podRoundId: string, guildId: string, messageId: string): Promise<void>
  recordSignup(
    podRoundId: string,
    discordId: string,
    username: string,
    sourceGuildId: string,
    action: SignupAction
  ): Promise<{
    count: number
    threshold: number
    setCode: string
    thresholdReached: boolean
    podCreated: boolean
    shareUrl?: string
    targets: Array<{ guildId: string; channelId: string; messageId: string | null }>
  }>
  cancelPod(podRoundId: string, requestedBy: string): Promise<void>
  cancelActiveRound(organizerDiscordId: string): Promise<{
    podRoundId: string
    setCode: string
    targets: Array<{ channelId: string; messageId: string | null }>
  } | null>
}

export interface LocalBackendClientDeps {
  prisma: AppPrismaClient
  ptp: PtpClient
  tokenEncryptionKey: string
  logger: Logger
}

export class LocalBackendClient implements BackendClient {
  constructor(private readonly deps: LocalBackendClientDeps) {}

  // §8.2: submit a pasted PTP token for validation + storage.
  linkOrganizer(discordId: string, token: string): Promise<{ username: string }> {
    return organizersService.linkOrganizer(this.deps, { discordId, token })
  }

  // §7.2: register/update a guild's broadcast subscription.
  subscribeGuild(guildId: string, channelId: string, installedBy: string): Promise<void> {
    return guildsService.subscribeGuild(this.deps, { guildId, channelId, installedBy })
  }

  // §7.2: allow-list an organizer for a guild with `allowlist` policy.
  allowOrganizer(guildId: string, organizerDiscordId: string, approvedBy: string): Promise<void> {
    return guildsService.allowOrganizer(this.deps, { guildId, organizerDiscordId, approvedBy })
  }

  // §7.5: start a round; returns eligible target guilds.
  listEligibleGuilds(organizerDiscordId: string): Promise<Array<{ guildId: string; name: string }>> {
    return organizersService.listEligibleGuilds(this.deps, organizerDiscordId)
  }

  // §7.5 steps 1-2: creates the round + PodRoundTarget rows. Returns each
  // target's resolved channel so the caller can actually post there.
  startPod(params: {
    organizerDiscordId: string
    setCode: string
    threshold: number
    guildIds: string[]
  }): Promise<{ podRoundId: string; targets: Array<{ guildId: string; channelId: string }> }> {
    return podsService.startPod(this.deps, params)
  }

  // §7.5 step 2: persists the Discord message ID for one target guild once
  // it's been posted, so a later signup's fan-out (step 3) knows what to edit.
  recordMessagePosted(podRoundId: string, guildId: string, messageId: string): Promise<void> {
    return podsService.recordTargetMessage(this.deps, { podRoundId, guildId, messageId })
  }

  // §7.5 step 4: record a signup; returns the updated shared count, whether
  // the pod was just created, and every target (for the caller to fan the
  // update out to guilds other than the one this signup came from).
  recordSignup(
    podRoundId: string,
    discordId: string,
    username: string,
    sourceGuildId: string,
    action: SignupAction
  ): Promise<{
    count: number
    threshold: number
    setCode: string
    thresholdReached: boolean
    podCreated: boolean
    shareUrl?: string
    targets: Array<{ guildId: string; channelId: string; messageId: string | null }>
  }> {
    return podsService.recordSignup(this.deps, { podRoundId, discordId, username, sourceGuildId, action })
  }

  // §7.5 step 5: cancel a round.
  cancelPod(podRoundId: string, requestedBy: string): Promise<void> {
    return podsService.cancelPod(this.deps, { podRoundId, requestedBy })
  }

  // §7.5 step 5, /cancel-pod's actual entry point: finds and cancels the
  // organizer's own most-recent active round (the command takes no
  // arguments, so there's no podRoundId to hand cancelPod above directly).
  cancelActiveRound(organizerDiscordId: string): Promise<{
    podRoundId: string
    setCode: string
    targets: Array<{ channelId: string; messageId: string | null }>
  } | null> {
    return podsService.cancelActiveRound(this.deps, organizerDiscordId)
  }
}
