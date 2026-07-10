import type { AppPrismaClient } from '../prismaClient.js'
import type { Prisma } from '@prisma/client'
import type { PtpClient } from '../ptp/client.js'
import { decryptToken } from '../crypto/tokenCrypto.js'
import { POD_CAPACITY } from '../podConfig.js'
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
  // Name of the guild /start-pod was invoked in, resolved live by the
  // caller (interactions/components.ts) — stored once here rather than
  // looked up again on every later message edit. Optional: a DM-context
  // invocation has no guild, and a resolution failure shouldn't block
  // creating the round over a cosmetic display value.
  originGuildName?: string
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
  const { organizerDiscordId, setCode, threshold, guildIds, scheduledFor, originGuildName } = params

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
      originGuildName,
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
  full: boolean
  podCreated: boolean
  shareUrl?: string
  originGuildName: string | null
  targets: Array<{ guildId: string; channelId: string; messageId: string | null }>
}

type RoundWithOrganizer = Prisma.PodRoundGetPayload<{ include: { organizer: true } }>

interface FireRoundResult {
  claimed: boolean
  podCreated: boolean
  shareUrl?: string
}

// Atomically claims a COLLECTING round for firing (see tasks/001) and, if
// this call won the claim, creates the PTP pod sized to exactly the
// players who committed so far (not POD_CAPACITY — a round can fire short
// of a full table, e.g. expireOverdueRounds firing at the deadline once
// `threshold` is met). Shared by recordSignup (fires the moment a round
// hits POD_CAPACITY) and expireOverdueRounds (fires at the deadline if at
// least `threshold` players joined, even short of capacity).
async function fireRound(
  deps: PodServiceDeps,
  round: RoundWithOrganizer,
  playerCount: number
): Promise<FireRoundResult> {
  // A plain read-then-write here is racy — two callers (a signup and a
  // concurrent sweep, or two signups) landing close together could both
  // observe status: 'COLLECTING' and both call ptp.createPod. Postgres
  // serializes conditional UPDATEs, so this WHERE-guarded updateMany
  // atomically claims the transition for exactly one caller; everyone else
  // sees count: 0 and skips PTP entirely. The claim itself lands on
  // THRESHOLD_REACHED — so a claim that's never followed by a successful
  // create still leaves the round in a correct, non-retrying state.
  const claim = await deps.prisma.podRound.updateMany({
    where: { id: round.id, status: 'COLLECTING' },
    data: { status: 'THRESHOLD_REACHED' },
  })
  if (claim.count !== 1) {
    return { claimed: false, podCreated: false }
  }

  try {
    const token = decryptToken(round.organizer.encryptedToken, deps.tokenEncryptionKey)
    const result = await deps.ptp.createPod(token, {
      setCode: round.setCode,
      maxPlayers: playerCount,
    })
    await deps.prisma.podRound.update({
      where: { id: round.id },
      data: { status: 'POD_CREATED', ptpPodShareId: result.shareId },
    })
    return { claimed: true, podCreated: true, shareUrl: result.shareUrl }
  } catch (err) {
    // Pod creation failed (e.g. expired/revoked token) even though we've
    // hit the fire condition — the claim above already recorded
    // THRESHOLD_REACHED, so this doesn't silently retry on every
    // subsequent signup or sweep. Needs an operator-facing alert path, not
    // yet built.
    deps.logger.error({ err, podRoundId: round.id }, 'PTP pod creation failed after threshold reached')
    return { claimed: true, podCreated: false }
  }
}

// INTEGRATIONS.md §7.3 key invariant — dedupe by discordId across the
// WHOLE round (not per guild), then §7.5 step 4 — fires the moment the
// round reaches POD_CAPACITY (a full table). `threshold` is a separate,
// lower bar only consulted at the deadline (see expireOverdueRounds) — a
// round is never fired early just because it crossed `threshold`.
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

  const full = count >= POD_CAPACITY
  let podCreated = false
  let shareUrl: string | undefined

  if (full && round.status === 'COLLECTING') {
    const fireResult = await fireRound(deps, round, count)
    podCreated = fireResult.podCreated
    shareUrl = fireResult.shareUrl
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
    full,
    podCreated,
    shareUrl,
    originGuildName: round.originGuildName,
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
  originGuildName: string | null
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
    originGuildName: round.originGuildName,
    targets: targetRows.map((t) => ({ channelId: t.channelId, messageId: t.messageId })),
  }
}

type ExpiredRoundTarget = { channelId: string; messageId: string | null }

export type ExpiredRoundInfo =
  | { podRoundId: string; setCode: string; outcome: 'expired'; originGuildName: string | null; targets: ExpiredRoundTarget[] }
  | {
      podRoundId: string
      setCode: string
      outcome: 'fired'
      count: number
      threshold: number
      shareUrl?: string
      originGuildName: string | null
      targets: ExpiredRoundTarget[]
    }

// Runs on a periodic sweep (jobs/expirePodRounds.ts), not on any user
// action — finds every round still COLLECTING past its deadline. A round
// that reached at least `threshold` players fires anyway (short of a full
// POD_CAPACITY table, same tasks/001-safe claim as recordSignup's
// full-table fire, via fireRound); one that didn't gets expired. Claims
// each candidate individually via a WHERE-guarded updateMany
// compare-and-swap: `claim.count === 1` means this call won that specific
// round, so it's safe to call from more than one concurrent sweep, and
// safe even if a signup is racing the same round toward
// THRESHOLD_REACHED at the same moment — whichever conditional update
// lands first wins, the other sees count: 0 and no-ops.
export async function expireOverdueRounds(deps: PodServiceDeps): Promise<ExpiredRoundInfo[]> {
  const candidates = await deps.prisma.podRound.findMany({
    where: { status: 'COLLECTING', scheduledFor: { lte: new Date() } },
    include: { organizer: true },
  })

  const results: ExpiredRoundInfo[] = []
  for (const round of candidates) {
    const count = await deps.prisma.podRoundSignup.count({
      where: { podRoundId: round.id, status: 'IN' },
    })

    if (count >= round.threshold) {
      const fireResult = await fireRound(deps, round, count)
      if (!fireResult.podCreated) continue

      const targetRows = await deps.prisma.podRoundTarget.findMany({ where: { podRoundId: round.id } })
      results.push({
        podRoundId: round.id,
        setCode: round.setCode,
        outcome: 'fired',
        count,
        threshold: round.threshold,
        shareUrl: fireResult.shareUrl,
        originGuildName: round.originGuildName,
        targets: targetRows.map((t) => ({ channelId: t.channelId, messageId: t.messageId })),
      })
      continue
    }

    const claim = await deps.prisma.podRound.updateMany({
      where: { id: round.id, status: 'COLLECTING' },
      data: { status: 'EXPIRED' },
    })
    if (claim.count !== 1) continue

    const targetRows = await deps.prisma.podRoundTarget.findMany({ where: { podRoundId: round.id } })
    results.push({
      podRoundId: round.id,
      setCode: round.setCode,
      outcome: 'expired',
      originGuildName: round.originGuildName,
      targets: targetRows.map((t) => ({ channelId: t.channelId, messageId: t.messageId })),
    })
  }

  return results
}
