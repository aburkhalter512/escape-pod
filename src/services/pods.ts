import type { AppPrismaClient } from '../prismaClient.js'
import type { PtpClient } from '../ptp/client.js'
import { decryptToken } from '../crypto/tokenCrypto.js'
import { NotFoundError, ForbiddenError, type Logger } from './errors.js'

export interface PodServiceDeps {
  prisma: AppPrismaClient
  ptp: PtpClient
  tokenEncryptionKey: string
  logger: Logger
}

export interface StartPodParams {
  organizerDiscordId: string
  setCode: string
  threshold: number
  guildIds: string[]
  // Absolute deadline — if still COLLECTING once this passes, the
  // periodic sweep (jobs/expirePodRounds.ts) auto-expires the round. See
  // util/duration.ts for why callers compute this from a relative
  // duration rather than taking an absolute time directly from the user.
  scheduledFor?: Date
}

export interface StartPodResult {
  podRoundId: string
  targets: Array<{ guildId: string; channelId: string }>
}

// INTEGRATIONS.md §7.5 steps 1-2 — creates the round + one PodRoundTarget
// per guild, resolving each target's broadcast channel from its
// GuildSubscription. Does NOT post the Discord messages itself — that's
// the interaction handlers' job (via discordRest), using the `targets`
// this returns.
export async function startPod(deps: PodServiceDeps, params: StartPodParams): Promise<StartPodResult> {
  const { organizerDiscordId, setCode, threshold, guildIds, scheduledFor } = params

  const subscriptions = await deps.prisma.guildSubscription.findMany({
    where: { guildId: { in: guildIds } },
  })
  // A guild could theoretically have unsubscribed between /start-pod's
  // eligibility check and this call — skip it rather than failing the
  // whole round over one stale target.
  const resolvedTargets = subscriptions.map((sub) => ({
    guildId: sub.guildId,
    channelId: sub.broadcastChannelId,
  }))

  const round = await deps.prisma.podRound.create({
    data: {
      organizerDiscordId,
      setCode,
      threshold,
      scheduledFor,
      targets: {
        create: resolvedTargets.map((t) => ({ guildId: t.guildId, channelId: t.channelId })),
      },
    },
  })

  return { podRoundId: round.id, targets: resolvedTargets }
}

export interface RecordTargetMessageParams {
  podRoundId: string
  guildId: string
  messageId: string
}

// Records the Discord message ID gotten back after posting the RSVP embed
// into a target guild's channel — needed so a later signup can fan an edit
// out to every target guild's message, not just the one the click happened
// in (§7.5 step 3).
export async function recordTargetMessage(
  deps: PodServiceDeps,
  params: RecordTargetMessageParams
): Promise<void> {
  const { podRoundId, guildId, messageId } = params

  const target = await deps.prisma.podRoundTarget.findUnique({
    where: { podRoundId_guildId: { podRoundId, guildId } },
  })
  if (!target) {
    throw new NotFoundError('Pod round target not found')
  }

  await deps.prisma.podRoundTarget.update({
    where: { podRoundId_guildId: { podRoundId, guildId } },
    data: { messageId },
  })
}

export interface RecordSignupParams {
  podRoundId: string
  discordId: string
  username: string
  sourceGuildId: string
  action: 'in' | 'leave'
}

export interface RecordSignupResult {
  count: number
  threshold: number
  setCode: string
  thresholdReached: boolean
  podCreated: boolean
  shareUrl?: string
  targets: Array<{ guildId: string; channelId: string; messageId: string | null }>
}

// INTEGRATIONS.md §7.3 key invariant — dedupe by discordId across the
// WHOLE round (not per guild), then §7.5 step 4 — on threshold, call PTP.
export async function recordSignup(
  deps: PodServiceDeps,
  params: RecordSignupParams
): Promise<RecordSignupResult> {
  const { podRoundId, discordId, username, sourceGuildId, action } = params
  const status = action === 'leave' ? 'LEFT' : 'IN'

  const round = await deps.prisma.podRound.findUnique({
    where: { id: podRoundId },
    include: { organizer: true },
  })
  if (!round) {
    throw new NotFoundError('Pod round not found')
  }

  await deps.prisma.podRoundSignup.upsert({
    where: { podRoundId_discordId: { podRoundId, discordId } },
    create: { podRoundId, discordId, usernameSnapshot: username, sourceGuildId, status },
    update: { status },
  })

  const count = await deps.prisma.podRoundSignup.count({
    where: { podRoundId, status: 'IN' },
  })

  const thresholdReached = count >= round.threshold
  let podCreated = false
  let shareUrl: string | undefined

  if (thresholdReached && round.status === 'COLLECTING') {
    // §7.5 step 4 / tasks/001: a plain read-then-write here is racy — two
    // signups landing close together could both observe status:
    // 'COLLECTING' and both call ptp.createPod. Postgres serializes
    // conditional UPDATEs, so this WHERE-guarded updateMany atomically
    // claims the transition for exactly one concurrent caller; everyone
    // else sees count: 0 and skips PTP entirely. The claim itself lands on
    // THRESHOLD_REACHED — the same status the failure path below already
    // used — so a claim that's never followed by a successful create still
    // leaves the round in a correct, non-retrying state.
    const claim = await deps.prisma.podRound.updateMany({
      where: { id: podRoundId, status: 'COLLECTING' },
      data: { status: 'THRESHOLD_REACHED' },
    })

    if (claim.count === 1) {
      try {
        const token = decryptToken(round.organizer.encryptedToken, deps.tokenEncryptionKey)
        const result = await deps.ptp.createPod(token, {
          setCode: round.setCode,
          maxPlayers: round.threshold,
        })
        await deps.prisma.podRound.update({
          where: { id: podRoundId },
          data: { status: 'POD_CREATED', ptpPodShareId: result.shareId },
        })
        podCreated = true
        shareUrl = result.shareUrl
      } catch (err) {
        // Pod creation failed (e.g. expired/revoked token) even though
        // we've hit the player threshold — the claim above already
        // recorded THRESHOLD_REACHED, so this doesn't silently retry on
        // every subsequent signup. Needs an operator-facing alert path,
        // not yet built.
        deps.logger.error({ err, podRoundId }, 'PTP pod creation failed after threshold reached')
      }
    }
  }

  // Every target for the round, not just sourceGuildId's — the caller
  // needs the full list to fan the updated count out to every guild's
  // message (§7.5 step 3). Only targets with a recorded messageId are
  // actually editable; the caller filters those out itself.
  const targetRows = await deps.prisma.podRoundTarget.findMany({ where: { podRoundId } })
  const targets = targetRows.map((t) => ({
    guildId: t.guildId,
    channelId: t.channelId,
    messageId: t.messageId,
  }))

  return {
    count,
    threshold: round.threshold,
    setCode: round.setCode,
    thresholdReached,
    podCreated,
    shareUrl,
    targets,
  }
}

export interface CancelPodParams {
  podRoundId: string
  requestedBy: string
}

// INTEGRATIONS.md §7.5 step 5.
export async function cancelPod(deps: PodServiceDeps, params: CancelPodParams): Promise<void> {
  const { podRoundId, requestedBy } = params

  const round = await deps.prisma.podRound.findUnique({ where: { id: podRoundId } })
  if (!round) {
    throw new NotFoundError('Pod round not found')
  }
  if (round.organizerDiscordId !== requestedBy) {
    throw new ForbiddenError('Only the organizer who started this round can cancel it')
  }

  await deps.prisma.podRound.update({
    where: { id: podRoundId },
    data: { status: 'CANCELLED' },
  })
}

export interface CancelActiveRoundResult {
  podRoundId: string
  setCode: string
  targets: Array<{ channelId: string; messageId: string | null }>
}

// /cancel-pod takes no arguments (INTEGRATIONS.md's cancel-pod command
// definition has none) — it cancels whichever round the calling organizer
// most recently started that hasn't already finished (POD_CREATED),
// failed (EXPIRED), or already been cancelled. Nothing today prevents an
// organizer from starting more than one round concurrently (no unique
// constraint on organizerDiscordId + active status), so "most recent" is
// a deliberate, documented choice for that edge case, not an oversight.
// Reuses cancelPod above for the actual status update (and its ownership
// check, redundant here since the query below already scopes by
// organizerDiscordId, but cheap and keeps this from silently diverging if
// cancelPod's logic ever changes). Returns enough to let the caller (the
// Discord-facing command handler) edit every target guild's RSVP message
// — this function itself never touches the Discord API, same
// Discord-agnostic-services boundary as the rest of this file.
export async function cancelActiveRound(
  deps: PodServiceDeps,
  organizerDiscordId: string
): Promise<CancelActiveRoundResult | null> {
  const round = await deps.prisma.podRound.findFirst({
    where: { organizerDiscordId, status: { in: ['COLLECTING', 'THRESHOLD_REACHED'] } },
    orderBy: { createdAt: 'desc' },
  })
  if (!round) {
    return null
  }

  await cancelPod(deps, { podRoundId: round.id, requestedBy: organizerDiscordId })

  const targetRows = await deps.prisma.podRoundTarget.findMany({ where: { podRoundId: round.id } })
  return {
    podRoundId: round.id,
    setCode: round.setCode,
    targets: targetRows.map((t) => ({ channelId: t.channelId, messageId: t.messageId })),
  }
}

export interface ExpiredRoundInfo {
  podRoundId: string
  setCode: string
  targets: Array<{ channelId: string; messageId: string | null }>
}

// Runs on a periodic sweep (jobs/expirePodRounds.ts), not on any user
// action — finds every round still COLLECTING past its deadline and
// expires it. Claims each candidate individually via the same
// WHERE-guarded updateMany compare-and-swap recordSignup already uses for
// the threshold-reached race (tasks/001): `claim.count === 1` means this
// call won that specific round, so it's safe to call from more than one
// concurrent sweep, and safe even if a signup is racing the same round
// toward THRESHOLD_REACHED at the same moment — whichever conditional
// update lands first wins, the other sees status no longer COLLECTING
// and no-ops.
export async function expireOverdueRounds(deps: PodServiceDeps): Promise<ExpiredRoundInfo[]> {
  const candidates = await deps.prisma.podRound.findMany({
    where: { status: 'COLLECTING', scheduledFor: { lte: new Date() } },
  })

  const expired: ExpiredRoundInfo[] = []
  for (const round of candidates) {
    const claim = await deps.prisma.podRound.updateMany({
      where: { id: round.id, status: 'COLLECTING' },
      data: { status: 'EXPIRED' },
    })
    if (claim.count !== 1) continue

    const targetRows = await deps.prisma.podRoundTarget.findMany({ where: { podRoundId: round.id } })
    expired.push({
      podRoundId: round.id,
      setCode: round.setCode,
      targets: targetRows.map((t) => ({ channelId: t.channelId, messageId: t.messageId })),
    })
  }

  return expired
}
