import type {
  Organizer,
  GuildSubscription,
  GuildOrganizerAllowlist,
  GuildOriginAllowlist,
  GuildNiamosToken,
  PodRound,
  PodRoundTarget,
  PodRoundSignup,
  PodRoundStatus,
} from '@prisma/client'

// Hand-written, not Prisma-sourced: no formal Prisma relation exists
// between PodRound.originGuildId and GuildNiamosToken (no FK — a round's
// origin guild need not have ever linked a Niamos token, or could have
// been unlinked after the round started; see storage/schema.ts migration
// 3). Replaces the old Prisma.PodRoundGetPayload<{include:{organizer:true}}>
// join, which the schema guaranteed always resolved (organizer_discord_id
// is NOT NULL + FK-enforced) — guildToken has no such guarantee, so
// callers (services/pods.ts's attemptPodCreation) must treat null as a
// normal, expected outcome, not an invariant violation.
export interface RoundWithGuildToken extends PodRound {
  guildToken: { encryptedToken: string; displayName: string } | null
}

// The shared data-access contract services/*.ts depends on — split out
// from appSqlStorage.ts specifically so this pure type declaration (zero
// Cloudflare-specific ambient globals) can be imported from files that
// compile under either type universe (this branch's plain tsconfig.json,
// used by AWS-reachable code like server.ts/backendClient.ts/routes/*.ts,
// and tsconfig.cloudflare.json, used by the Worker/DO side) — unlike
// appSqlStorage.ts's createAppSqlStorage implementation, which uses
// SqlStorage/SqlStorageValue (only ambient under tsconfig.cloudflare.json)
// and would fail to type-check under the plain config even via a
// type-only import, since TypeScript still processes a whole source
// file's types regardless of how it's imported elsewhere.
//
// Per PR review: every method here is named after the one concrete thing
// it does for its one real caller (see each method's own comment),
// rather than a generic CRUD verb (findMany/update/upsert/...) covering
// several distinct operations that used to branch internally on which
// fields the caller happened to pass. Two concrete implementations:
// appSqlStorage.ts's createAppSqlStorage (Durable Object SQLite, this
// branch's Worker) and prismaAppStorage.ts's createPrismaAppStorage (real
// Prisma/Postgres, this branch's AWS-compatible path — routes/*.ts and
// backendClient.ts adapt a real AppPrismaClient into this shape, so
// server.ts/app.ts never need to change what they construct/pass in at
// all).
export interface AppStorage {
  organizer: {
    // services/pods.ts's startPod — atomically claims this organizer's
    // next sequential round number, creating the organizer row on first
    // use (no separate linking step creates it anymore — see this
    // method's implementation in appSqlStorage.ts for the upsert
    // semantics). See startPod's own doc comment on why this alone, not
    // a transaction, guarantees distinct round numbers under concurrent
    // callers.
    incrementNextRoundNumber(args: { where: { discordId: string }; data: { increment: number } }): Promise<Organizer>
  }
  guildNiamosToken: {
    // services/niamosTokens.ts's linkNiamosGuildToken (/connect-niamos)
    // — create the guild's token row the first time, or replace it on a
    // re-link (only one token allowed per guild at a time). Flat args,
    // not a Prisma-style {where, create, update} — unlike this file's
    // other upsert methods (approveOrganizer, approveOriginGuild), every
    // real caller here always writes the exact same fields on both the
    // insert and update paths, so splitting them apart is pure
    // duplication with no real create-vs-update distinction to express.
    linkToken(args: {
      guildId: string
      encryptedToken: string
      linkedByDiscordId: string
      displayName: string
    }): Promise<GuildNiamosToken>
  }
  guildSubscription: {
    // services/pods.ts's startPod — of the target guilds requested, which
    // are still actively subscribed (a guild could have unsubscribed
    // between /start-pod's eligibility check and this call).
    findActiveByGuildIds(guildIds: string[]): Promise<GuildSubscription[]>
    // services/organizers.ts's listEligibleGuilds — guilds a round
    // starting from originGuildId may fan out to: the origin guild
    // itself (self-trust, no grant needed), plus guilds that
    // specifically trust this origin guild.
    findEligibleForOrigin(originGuildId: string): Promise<GuildSubscription[]>
    // services/guilds.ts's subscribeGuild/unsubscribeGuild — look up a
    // guild's current subscription state (active, inactive, or never
    // subscribed).
    findByGuildId(guildId: string): Promise<GuildSubscription | null>
    // services/guilds.ts's subscribeGuild — first-time subscribe.
    createSubscription(args: {
      data: { guildId: string; broadcastChannelId: string; installedByDiscordId: string }
    }): Promise<GuildSubscription>
    // services/guilds.ts's subscribeGuild — reconfigure an existing
    // subscription's channel, optionally reactivating it
    // (unsubscribedAt: null) when a channel is given.
    updateSettings(args: {
      where: { guildId: string }
      data: Partial<{ broadcastChannelId: string; unsubscribedAt: Date | null }>
    }): Promise<GuildSubscription>
    // services/guilds.ts's unsubscribeGuild — soft-delete by stamping
    // unsubscribedAt, distinct from updateSettings above since it's a
    // one-way state transition with no other fields ever involved.
    markUnsubscribed(guildId: string): Promise<GuildSubscription>
    // services/organizers.ts's listEligibleGuilds fallback — only queried
    // when findEligibleForOrigin comes back empty, to distinguish "no
    // guild anywhere is subscribed" from "guilds are subscribed but none
    // trust this origin."
    countActiveSubscriptions(): Promise<number>
  }
  guildOrganizerAllowlist: {
    // services/guilds.ts's allowOrganizer (deprecated, see its own
    // comment) — approve one organizer for one guild.
    approveOrganizer(args: {
      where: { guildId_organizerDiscordId: { guildId: string; organizerDiscordId: string } }
      create: { guildId: string; organizerDiscordId: string; approvedBy: string }
      update: { approvedBy: string }
    }): Promise<GuildOrganizerAllowlist>
  }
  guildOriginAllowlist: {
    // services/guilds.ts's allowGuild — trust an entire origin guild
    // (replaces allowOrganizer above).
    approveOriginGuild(args: {
      where: { guildId_allowedOriginGuildId: { guildId: string; allowedOriginGuildId: string } }
      create: { guildId: string; allowedOriginGuildId: string; approvedBy: string }
      update: { approvedBy: string }
    }): Promise<GuildOriginAllowlist>
  }
  podRound: {
    // services/pods.ts's startPod — creates the round + one
    // PodRoundTarget per guild.
    createRoundWithTargets(args: {
      data: {
        organizerDiscordId: string
        organizerRoundNumber: number
        setCode: string
        threshold: number
        scheduledFor?: Date
        originGuildName?: string
        originGuildId?: string
        targets: { create: Array<{ guildId: string; channelId: string }> }
      }
    }): Promise<PodRound>
    // services/pods.ts's cancelPod/concludePod — plain lookup by id, no
    // organizer needed.
    findRoundById(id: string): Promise<PodRound | null>
    // services/pods.ts's recordSignup — needs the round's origin guild's
    // encrypted Niamos token if this signup ends up firing the round.
    findRoundWithGuildTokenById(id: string): Promise<RoundWithGuildToken | null>
    // services/pods.ts's cancelActiveRound/concludeActiveRound — resolve
    // an exact round when the caller specified organizerRoundNumber.
    findRoundByOrganizerAndNumber(organizerDiscordId: string, organizerRoundNumber: number): Promise<PodRound | null>
    // services/pods.ts's cancelActiveRound/concludeActiveRound fallback —
    // this organizer's most recently started round, of any status (the
    // caller checks status itself; see its own comment on why this is
    // deliberately not filtered to only cancellable/concludable statuses).
    findLatestRoundForOrganizer(organizerDiscordId: string): Promise<PodRound | null>
    // services/pods.ts's listActiveRoundsForOrganizer — every round in one
    // of the given statuses, for /cancel-pod's and /conclude-pod's
    // ambiguity detection and the `round` option's autocomplete.
    findActiveRoundsForOrganizer(organizerDiscordId: string, statuses: PodRoundStatus[]): Promise<PodRound[]>
    // jobs/expirePodRounds.ts's expireOverdueRounds — every still-
    // COLLECTING round past its deadline (status is always 'COLLECTING'
    // for this query, so it's not a parameter).
    findOverdueRounds(scheduledBefore: Date): Promise<RoundWithGuildToken[]>
    // jobs/retryFailedFires.ts's retryFailedFires — every round stuck at
    // THRESHOLD_REACHED whose initial fireRound attempt failed and hasn't
    // been given up on yet (status/fireFailureNotified are always the
    // same two constants for this query, so neither is a parameter).
    findStuckThresholdReachedRounds(): Promise<RoundWithGuildToken[]>
    // services/pods.ts's attemptPodCreation — the round successfully got
    // a Niamos draft.
    markPodCreated(id: string, data: { ptpPodShareId: string; chatChannelId?: string }): Promise<PodRound>
    // services/pods.ts's cancelPod.
    markCancelled(id: string): Promise<PodRound>
    // services/pods.ts's concludePod.
    markConcluded(id: string): Promise<PodRound>
    // services/pods.ts's retryFailedFires giving up after RETRY_WINDOW_MS.
    markFireFailureNotified(id: string): Promise<PodRound>
    // services/pods.ts's fireRound — the compare-and-swap claim
    // (COLLECTING -> THRESHOLD_REACHED) only one concurrent caller can
    // win; count 0 means someone else already claimed it.
    claimForFiring(id: string, thresholdReachedAt: Date): Promise<{ count: number }>
    // jobs/expirePodRounds.ts's expireOverdueRounds — the same
    // compare-and-swap shape as claimForFiring, claiming COLLECTING ->
    // EXPIRED instead.
    claimExpired(id: string): Promise<{ count: number }>
  }
  podRoundTarget: {
    // services/pods.ts — every target for a round, e.g. to fan a signup
    // count update out to every guild's message.
    findByRoundId(podRoundId: string): Promise<PodRoundTarget[]>
    // services/pods.ts's recordTargetMessage — the one target a freshly
    // posted RSVP message belongs to.
    findByRoundAndGuild(podRoundId: string, guildId: string): Promise<PodRoundTarget | null>
    // services/pods.ts's recordTargetMessage — records the Discord
    // message ID gotten back after posting the RSVP embed.
    setMessageId(podRoundId: string, guildId: string, messageId: string): Promise<PodRoundTarget>
  }
  podRoundSignup: {
    // Not yet called by any real caller (recordSignup/expireOverdueRounds/
    // retryFailedFires all derive count from findSignedUp's own result
    // length instead) — kept as its own concrete operation since it's
    // real, tested SQL surface, not speculative.
    countSignedUp(podRoundId: string): Promise<number>
    // services/pods.ts's recordSignup — records or updates a player's
    // IN/LEFT status for a round.
    recordSignup(args: {
      where: { podRoundId_discordId: { podRoundId: string; discordId: string } }
      create: { podRoundId: string; discordId: string; usernameSnapshot: string; sourceGuildId: string; status: 'IN' | 'LEFT' }
      update: { status: 'IN' | 'LEFT' }
    }): Promise<PodRoundSignup>
    // services/pods.ts's recordSignup/fireRound/expireOverdueRounds/
    // retryFailedFires — every player currently signed up (status: 'IN'
    // is always the filter for this query, so it's not a parameter).
    findSignedUp(podRoundId: string): Promise<PodRoundSignup[]>
  }
}
