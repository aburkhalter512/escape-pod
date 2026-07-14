// The seam between Discord interaction handling and durable state/PTP
// business logic (see INTEGRATIONS.md §7.3, §4.1, §8). This used to be an
// HTTP client to a separate backend service; the two are now one deployed
// process, so LocalBackendClient below calls the extracted services/*
// functions directly, in-process — no serialization, no network round
// trip. commands/* and interactions/* only depend on the BackendClient
// interface, so none of them needed to change for that merge.

import type { PostingPolicy } from '@prisma/client'
import type { AppPrismaClient } from './prismaClient.js'
import type { PtpClient } from './ptp/client.js'
import type { Logger, Result } from './services/errors.js'
import type { ActiveRoundSummary, ConcludeActiveRoundResult, OnFiringHook } from './services/pods.js'
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
  linkOrganizer(discordId: string, token: string): Promise<Result<{ username: string }>>
  subscribeGuild(
    guildId: string,
    installedBy: string,
    params: { channelId?: string; policy?: PostingPolicy }
  ): Promise<Result<{ subscribed: boolean; broadcastChannelId: string; postingPolicy: PostingPolicy }>>
  unsubscribeGuild(guildId: string): Promise<{ wasSubscribed: boolean }>
  // Deprecated — no longer has any effect on eligibility, see
  // services/guilds.ts's allowOrganizer. Kept only so the deprecated
  // /allow-organizer command still resolves to a real (inert) call
  // instead of needing special-casing.
  allowOrganizer(guildId: string, organizerDiscordId: string, approvedBy: string): Promise<void>
  // Replaces allowOrganizer above — trusts an entire origin guild
  // instead of one organizer at a time. See services/guilds.ts's
  // allowGuild.
  allowGuild(guildId: string, allowedOriginGuildId: string, approvedBy: string): Promise<void>
  // Eligibility is origin-guild-scoped, not organizer-scoped — see
  // services/organizers.ts's listEligibleGuilds.
  listEligibleGuilds(originGuildId: string): Promise<{ guilds: Array<{ guildId: string }>; anySubscribed: boolean }>
  startPod(params: {
    organizerDiscordId: string
    setCode: string
    threshold: number
    guildIds: string[]
    scheduledFor?: Date
    originGuildName?: string
    originGuildId?: string
  }): Promise<{ podRoundId: string; organizerRoundNumber: number; targets: Array<{ guildId: string; channelId: string }> }>
  recordMessagePosted(podRoundId: string, guildId: string, messageId: string): Promise<Result<void>>
  recordSignup(
    podRoundId: string,
    discordId: string,
    username: string,
    sourceGuildId: string,
    action: SignupAction,
    onFiring?: OnFiringHook
  ): Promise<
    Result<{
      count: number
      threshold: number
      setCode: string
      organizerRoundNumber: number
      full: boolean
      podCreated: boolean
      shareUrl?: string
      chatUrl?: string
      chatChannelId?: string
      signupDiscordIds: string[]
      originGuildName: string | null
      scheduledFor: Date | null
      targets: Array<{ guildId: string; channelId: string; messageId: string | null }>
    }>
  >
  cancelPod(podRoundId: string, requestedBy: string): Promise<Result<void>>
  cancelActiveRound(organizerDiscordId: string, organizerRoundNumber?: number): Promise<{
    podRoundId: string
    setCode: string
    organizerRoundNumber: number
    originGuildName: string | null
    targets: Array<{ channelId: string; messageId: string | null }>
  } | null>
  concludeActiveRound(organizerDiscordId: string, organizerRoundNumber?: number): Promise<Result<ConcludeActiveRoundResult>>
  // Read-side counterpart to the two methods above — see
  // services/pods.ts's listActiveRoundsForOrganizer for the full
  // rationale (autocomplete choices + ambiguity detection when
  // organizerRoundNumber is omitted from a cancel/conclude call).
  listActiveRounds(organizerDiscordId: string, kind: 'cancellable' | 'concludable'): Promise<ActiveRoundSummary[]>
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
  linkOrganizer(discordId: string, token: string): Promise<Result<{ username: string }>> {
    return organizersService.linkOrganizer(this.deps, { discordId, token })
  }

  // §7.2: register a guild's broadcast subscription, or reconfigure an
  // existing one's channel/policy (or neither, to just read current
  // settings back) — see services/guilds.ts's subscribeGuild.
  subscribeGuild(
    guildId: string,
    installedBy: string,
    params: { channelId?: string; policy?: PostingPolicy }
  ): Promise<Result<{ subscribed: boolean; broadcastChannelId: string; postingPolicy: PostingPolicy }>> {
    return guildsService.subscribeGuild(this.deps, { guildId, installedBy, ...params })
  }

  // §7.2 inverse: soft-deletes the subscription (see services/guilds.ts's
  // unsubscribeGuild for why this can never be a real row delete).
  unsubscribeGuild(guildId: string): Promise<{ wasSubscribed: boolean }> {
    return guildsService.unsubscribeGuild(this.deps, guildId)
  }

  // Deprecated — see services/guilds.ts's allowOrganizer.
  allowOrganizer(guildId: string, organizerDiscordId: string, approvedBy: string): Promise<void> {
    return guildsService.allowOrganizer(this.deps, { guildId, organizerDiscordId, approvedBy })
  }

  // §7.2: trust an entire origin guild for a guild with `allowlist`
  // policy — replaces allowOrganizer above.
  allowGuild(guildId: string, allowedOriginGuildId: string, approvedBy: string): Promise<void> {
    return guildsService.allowGuild(this.deps, { guildId, allowedOriginGuildId, approvedBy })
  }

  // §7.5: guilds a round starting from originGuildId may target; returns
  // eligible target guild IDs (no name — the caller resolves those live
  // via discordRest.getGuild, see services/organizers.ts) plus whether
  // ANY guild is subscribed at all, so the caller can distinguish "no
  // guild anywhere is subscribed" from "guilds are subscribed but none
  // trust this origin guild."
  listEligibleGuilds(originGuildId: string): Promise<{ guilds: Array<{ guildId: string }>; anySubscribed: boolean }> {
    return organizersService.listEligibleGuilds(this.deps, originGuildId)
  }

  // §7.5 steps 1-2: creates the round + PodRoundTarget rows. Returns each
  // target's resolved channel so the caller can actually post there.
  startPod(params: {
    organizerDiscordId: string
    setCode: string
    threshold: number
    guildIds: string[]
    scheduledFor?: Date
    originGuildName?: string
    originGuildId?: string
  }): Promise<{ podRoundId: string; organizerRoundNumber: number; targets: Array<{ guildId: string; channelId: string }> }> {
    return podsService.startPod(this.deps, params)
  }

  // §7.5 step 2: persists the Discord message ID for one target guild once
  // it's been posted, so a later signup's fan-out (step 3) knows what to edit.
  recordMessagePosted(podRoundId: string, guildId: string, messageId: string): Promise<Result<void>> {
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
    action: SignupAction,
    onFiring?: OnFiringHook
  ): Promise<
    Result<{
      count: number
      threshold: number
      setCode: string
      organizerRoundNumber: number
      full: boolean
      podCreated: boolean
      shareUrl?: string
      chatUrl?: string
      chatChannelId?: string
      signupDiscordIds: string[]
      originGuildName: string | null
      scheduledFor: Date | null
      targets: Array<{ guildId: string; channelId: string; messageId: string | null }>
    }>
  > {
    return podsService.recordSignup(this.deps, { podRoundId, discordId, username, sourceGuildId, action, onFiring })
  }

  // §7.5 step 5: cancel a round.
  cancelPod(podRoundId: string, requestedBy: string): Promise<Result<void>> {
    return podsService.cancelPod(this.deps, { podRoundId, requestedBy })
  }

  // §7.5 step 5, /cancel-pod's actual entry point: finds and cancels the
  // organizer's active round — a specific one when organizerRoundNumber
  // is given (GitHub issue #6), otherwise the most-recent-round fallback
  // (see services/pods.ts's cancelActiveRound for the full rationale).
  cancelActiveRound(organizerDiscordId: string, organizerRoundNumber?: number): Promise<{
    podRoundId: string
    setCode: string
    organizerRoundNumber: number
    originGuildName: string | null
    targets: Array<{ channelId: string; messageId: string | null }>
  } | null> {
    return podsService.cancelActiveRound(this.deps, organizerDiscordId, organizerRoundNumber)
  }

  // tasks/010, /conclude-pod's actual entry point: finds and concludes
  // the organizer's round (POD_CREATED -> CONCLUDED) — a specific one
  // when organizerRoundNumber is given, otherwise the same
  // most-recent-round fallback as cancelActiveRound above.
  concludeActiveRound(organizerDiscordId: string, organizerRoundNumber?: number): Promise<Result<ConcludeActiveRoundResult>> {
    return podsService.concludeActiveRound(this.deps, organizerDiscordId, organizerRoundNumber)
  }

  // Read-side counterpart used by /cancel-pod's and /conclude-pod's
  // ambiguity handling and by the `round` option's autocomplete handler
  // — see services/pods.ts's listActiveRoundsForOrganizer.
  listActiveRounds(organizerDiscordId: string, kind: 'cancellable' | 'concludable'): Promise<ActiveRoundSummary[]> {
    return podsService.listActiveRoundsForOrganizer(this.deps, organizerDiscordId, kind)
  }
}
