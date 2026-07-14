import type { AppPrismaClient } from '../prismaClient.js'
import type { Prisma } from '@prisma/client'
import type { PtpClient } from '../ptp/client.js'
import { decryptToken } from '../crypto/tokenCrypto.js'
import { POD_CAPACITY } from '../podConfig.js'
import { ok, err, notFound, forbidden, validationError, type Logger, type Result } from './errors.js'

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
  // Discord ID counterpart to originGuildName above, resolved and stored
  // the same way and for the same reason — needed so a firing round can
  // later create its private chat channel in this guild (see
  // discord/podChat.ts). Same optionality rationale as originGuildName.
  originGuildId?: string
}

export interface StartPodResult {
  podRoundId: string
  // This organizer's Nth round ever started (see Organizer.nextRoundNumber,
  // PodRound.organizerRoundNumber in schema.prisma) — not yet displayed or
  // consulted anywhere; that's a later, separate change (GitHub issue #6).
  organizerRoundNumber: number
  targets: Array<{ guildId: string; channelId: string }>
}

// INTEGRATIONS.md §7.5 steps 1-2 — creates the round + one PodRoundTarget
// per guild, resolving each target's broadcast channel from its
// GuildSubscription. Does NOT post the Discord messages itself — that's
// the interaction handlers' job (via discordRest), using the `targets`
// this returns.
export async function startPod(deps: PodServiceDeps, params: StartPodParams): Promise<StartPodResult> {
  const { organizerDiscordId, setCode, threshold, guildIds, scheduledFor, originGuildName, originGuildId } = params

  const subscriptions = await deps.prisma.guildSubscription.findMany({
    where: { guildId: { in: guildIds }, unsubscribedAt: null },
  })
  // A guild could genuinely have unsubscribed between /start-pod's
  // eligibility check and this call — skip it rather than failing the
  // whole round over one stale target.
  const resolvedTargets = subscriptions.map((sub) => ({
    guildId: sub.guildId,
    channelId: sub.broadcastChannelId,
  }))

  // Atomically claims this organizer's next sequential round number (see
  // GitHub issue #6 — lets /cancel-pod and /conclude-pod later target a
  // specific round instead of only ever "the most recent one"). Postgres
  // serializes concurrent UPDATEs to the same row, so two concurrent
  // /start-pod calls from the same organizer can never receive the same
  // number — the increment itself is what guarantees uniqueness, the same
  // trust level already placed in fireRound's updateMany compare-and-swap
  // claim (tasks/001). Deliberately not wrapped in a transaction with the
  // podRound.create below: AppPrismaClient's narrow interface
  // (prismaClient.ts) doesn't expose $transaction, and the only thing a
  // transaction would additionally buy here is avoiding a *gap* in the
  // sequence if the process crashes between these two calls — gaps are
  // harmless (PodRound's unique constraint only requires distinctness, not
  // contiguity), so that trade-off isn't worth widening this interface.
  const organizer = await deps.prisma.organizer.update({
    where: { discordId: organizerDiscordId },
    data: { nextRoundNumber: { increment: 1 } },
  })
  const organizerRoundNumber = organizer.nextRoundNumber - 1

  const round = await deps.prisma.podRound.create({
    data: {
      organizerDiscordId,
      organizerRoundNumber,
      setCode,
      threshold,
      scheduledFor,
      originGuildName,
      originGuildId,
      targets: {
        create: resolvedTargets.map((t) => ({ guildId: t.guildId, channelId: t.channelId })),
      },
    },
  })

  return { podRoundId: round.id, organizerRoundNumber, targets: resolvedTargets }
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
): Promise<Result<void>> {
  const { podRoundId, guildId, messageId } = params

  const target = await deps.prisma.podRoundTarget.findUnique({
    where: { podRoundId_guildId: { podRoundId, guildId } },
  })
  if (!target) {
    return err(notFound('Pod round target not found'))
  }

  await deps.prisma.podRoundTarget.update({
    where: { podRoundId_guildId: { podRoundId, guildId } },
    data: { messageId },
  })
  return ok(undefined)
}

export interface RecordSignupParams {
  podRoundId: string
  discordId: string
  username: string
  sourceGuildId: string
  action: 'in' | 'leave'
  onFiring?: OnFiringHook
}

export interface RecordSignupResult {
  count: number
  threshold: number
  setCode: string
  full: boolean
  podCreated: boolean
  shareUrl?: string
  chatUrl?: string
  chatChannelId?: string
  signupDiscordIds: string[]
  originGuildName: string | null
  scheduledFor: Date | null
  targets: Array<{ guildId: string; channelId: string; messageId: string | null }>
}

type RoundWithOrganizer = Prisma.PodRoundGetPayload<{ include: { organizer: true } }>

interface FireRoundResult {
  claimed: boolean
  podCreated: boolean
  shareUrl?: string
  chatUrl?: string
  chatChannelId?: string
  signupDiscordIds?: string[]
}

// Opaque, plain-data hook invoked between claiming a round for firing and
// actually creating the PTP pod — lets a Discord-touching caller (e.g.
// creating a shared chat channel + invite, see discord/podChat.ts) run at
// exactly that point in the sequence without this file importing anything
// Discord-specific. Keeps the Discord-agnostic-services boundary described
// on cancelActiveRound above intact: fireRound only ever deals in plain
// data in and a plain optional { channelId, chatUrl } back out, never
// discordRest itself. Documented (at the one real implementation,
// createPodChatSpace) as never throwing/rejecting — fireRound awaits it
// directly, no extra guarding. The channelId has to make the round trip back
// out through fireRound (and recordSignup/expireOverdueRounds beyond it)
// because the welcome message naming the real PTP share URL can only be
// posted once that URL exists — i.e. after ptp.createPod, which runs after
// this hook — so the caller needs the channel ID later to post into, not
// just the invite URL.
export type OnFiringHook = (ctx: {
  setCode: string
  organizerDiscordId: string
  originGuildId: string | null
  signupDiscordIds: string[]
}) => Promise<{ channelId: string; chatUrl: string } | undefined>

interface AttemptPodCreationResult {
  podCreated: boolean
  shareUrl?: string
}

// The one PTP-touching step shared by fireRound's first attempt (below) and
// retryFailedFires's later retries of an already-claimed round (see below)
// — decrypts the organizer's token, calls ptp.createPod, and on success
// updates the round to POD_CREATED (persisting chatChannelId alongside it,
// if one was already recorded). Deliberately does NOT touch the
// COLLECTING -> THRESHOLD_REACHED claim, the signups fetch, or onFiring —
// those only ever happen once, on the first attempt (see fireRound); a
// retry re-runs only this step against a round that's already
// THRESHOLD_REACHED with its chat channel (if any) already created. On
// failure this logs and returns podCreated: false rather than throwing —
// same never-throws contract fireRound's own try/catch used to have
// inline, now shared by both callers.
async function attemptPodCreation(
  deps: PodServiceDeps,
  round: RoundWithOrganizer,
  chatChannelId: string | undefined
): Promise<AttemptPodCreationResult> {
  try {
    const token = decryptToken(round.organizer.encryptedToken, deps.tokenEncryptionKey)
    const result = await deps.ptp.createPod(token, {
      setCode: round.setCode,
      maxPlayers: POD_CAPACITY,
    })
    await deps.prisma.podRound.update({
      where: { id: round.id },
      data: {
        status: 'POD_CREATED',
        ptpPodShareId: result.shareId,
        ...(chatChannelId ? { chatChannelId } : {}),
      },
    })
    return { podCreated: true, shareUrl: result.shareUrl }
  } catch (err) {
    // Pod creation failed (e.g. expired/revoked token) even though we've
    // hit the fire condition — the round is already at THRESHOLD_REACHED
    // (set by the claim in fireRound, before this ever runs), so this
    // doesn't silently retry on every subsequent signup or sweep tick on
    // its own. The bounded retry sweep (retryFailedFires below) is what
    // actually retries this, and eventually gives up with a visible
    // notification if it keeps failing.
    deps.logger.error({ err, podRoundId: round.id }, 'PTP pod creation failed after threshold reached')
    return { podCreated: false }
  }
}

// Atomically claims a COLLECTING round for firing (see tasks/001) and, if
// this call won the claim, creates the PTP pod. Always sized to
// POD_CAPACITY, never to however many players actually committed —
// `threshold` (consulted only by expireOverdueRounds) is just the
// minimum needed to bother starting at all, not the pod's real size; a
// draft pod is a fixed-size event on PTP's side (pack counts etc. assume
// a full table), so a round that fires short of capacity at its deadline
// still gets a full-size pod with open seats, not one artificially
// capped at the headcount it happened to have at that moment. Shared by
// recordSignup (fires the moment a round hits POD_CAPACITY) and
// expireOverdueRounds (fires at the deadline if at least `threshold`
// players joined, even short of capacity).
async function fireRound(
  deps: PodServiceDeps,
  round: RoundWithOrganizer,
  onFiring?: OnFiringHook
): Promise<FireRoundResult> {
  // A plain read-then-write here is racy — two callers (a signup and a
  // concurrent sweep, or two signups) landing close together could both
  // observe status: 'COLLECTING' and both call ptp.createPod. Postgres
  // serializes conditional UPDATEs, so this WHERE-guarded updateMany
  // atomically claims the transition for exactly one caller; everyone else
  // sees count: 0 and skips PTP entirely. The claim itself lands on
  // THRESHOLD_REACHED — so a claim that's never followed by a successful
  // create still leaves the round in a correct, non-retrying state.
  // thresholdReachedAt is stamped in this same call — it's the one
  // unambiguous "this round got claimed" moment, and the retry sweep
  // (retryFailedFires below) needs it to know how long a stuck round has
  // been waiting.
  const claim = await deps.prisma.podRound.updateMany({
    where: { id: round.id, status: 'COLLECTING' },
    data: { status: 'THRESHOLD_REACHED', thresholdReachedAt: new Date() },
  })
  if (claim.count !== 1) {
    return { claimed: false, podCreated: false }
  }

  // Fetched once, unconditionally — needed for onFiring's permission
  // overwrites below *and* for the caller to DM these same players once
  // this returns, so both consumers share the one query regardless of
  // whether onFiring was even passed.
  const signups = await deps.prisma.podRoundSignup.findMany({
    where: { podRoundId: round.id, status: 'IN' },
  })
  const signupDiscordIds = signups.map((s) => s.discordId)

  let chatUrl: string | undefined
  let chatChannelId: string | undefined
  if (onFiring) {
    const chatSpace = await onFiring({
      setCode: round.setCode,
      organizerDiscordId: round.organizerDiscordId,
      originGuildId: round.originGuildId,
      signupDiscordIds,
    })
    chatUrl = chatSpace?.chatUrl
    chatChannelId = chatSpace?.channelId
  }

  const attempt = await attemptPodCreation(deps, round, chatChannelId)
  return {
    claimed: true,
    podCreated: attempt.podCreated,
    shareUrl: attempt.shareUrl,
    chatUrl,
    chatChannelId,
    signupDiscordIds,
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
): Promise<Result<RecordSignupResult>> {
  const { podRoundId, discordId, username, sourceGuildId, action, onFiring } = params
  const status = action === 'leave' ? 'LEFT' : 'IN'

  const round = await deps.prisma.podRound.findUnique({
    where: { id: podRoundId },
    include: { organizer: true },
  })
  if (!round) {
    return err(notFound('Pod round not found'))
  }

  // The round may have already left COLLECTING before this call started —
  // fired by an earlier signup that hit POD_CAPACITY, fired by the
  // periodic deadline sweep (jobs/expirePodRounds.ts), cancelled via
  // /cancel-pod, or expired. In every one of those cases the correct RSVP
  // message already reflects that terminal state; upserting the signup
  // and building a "still collecting" response here would let a late
  // click stomp that correct message with a stale one (the fields that
  // signal a terminal state — podCreated/shareUrl/chatUrl — only ever get
  // set a few lines down, inside the `full && round.status === 'COLLECTING'`
  // check, so any other status silently fell through to a bogus in-progress
  // response). Bail out before the upsert/count so a resolved round is
  // never touched by a late signup at all.
  if (round.status === 'THRESHOLD_REACHED' || round.status === 'POD_CREATED') {
    return err(validationError('This round has already started — no need to sign up.'))
  }
  if (round.status === 'CANCELLED') {
    return err(validationError('This round was cancelled by the organizer.'))
  }
  if (round.status === 'EXPIRED') {
    return err(validationError('This round expired before enough players joined.'))
  }
  if (round.status === 'CONCLUDED') {
    return err(validationError('This round has already concluded.'))
  }

  await deps.prisma.podRoundSignup.upsert({
    where: { podRoundId_discordId: { podRoundId, discordId } },
    create: { podRoundId, discordId, usernameSnapshot: username, sourceGuildId, status },
    update: { status },
  })

  // Single findMany instead of a separate count-then-list pair — count is
  // just the result's length, and signupDiscordIds (below) needs this same
  // row set anyway for the "Players:" line (discord/podMessage.ts). One
  // query instead of two also closes a tiny theoretical race between a
  // separate count and list read landing on different underlying data.
  const signups = await deps.prisma.podRoundSignup.findMany({
    where: { podRoundId, status: 'IN' },
  })
  const count = signups.length
  // Sorted by the username captured at signup time (not a live lookup —
  // this function is Discord-agnostic) so the "Players:" list renders in a
  // stable, predictable order rather than insertion order; discord/
  // podMessage.ts still renders each entry as a live `<@id>` mention, this
  // sort only controls the list's order, not what text is actually shown.
  const signupDiscordIds = [...signups]
    .sort((a, b) => a.usernameSnapshot.localeCompare(b.usernameSnapshot, undefined, { sensitivity: 'base' }))
    .map((s) => s.discordId)

  const full = count >= POD_CAPACITY
  let podCreated = false
  let shareUrl: string | undefined
  let chatUrl: string | undefined
  let chatChannelId: string | undefined

  if (full && round.status === 'COLLECTING') {
    // fireRound does its own separate signupDiscordIds fetch internally
    // (for the chat-channel/DM feature — see its FireRoundResult) — not
    // reused here to keep that fetch's purpose and this function's own
    // list-for-the-message-body purpose independent. In practice the two
    // are identical (nothing else touches podRoundSignup between them), so
    // this function's own `signupDiscordIds` above is used for the
    // returned field either way; fireResult.signupDiscordIds is discarded.
    const fireResult = await fireRound(deps, round, onFiring)
    podCreated = fireResult.podCreated
    shareUrl = fireResult.shareUrl
    chatUrl = fireResult.chatUrl
    chatChannelId = fireResult.chatChannelId
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

  return ok({
    count,
    threshold: round.threshold,
    setCode: round.setCode,
    full,
    podCreated,
    shareUrl,
    chatUrl,
    chatChannelId,
    signupDiscordIds,
    originGuildName: round.originGuildName,
    scheduledFor: round.scheduledFor,
    targets,
  })
}

export interface CancelPodParams {
  podRoundId: string
  requestedBy: string
}

// INTEGRATIONS.md §7.5 step 5.
export async function cancelPod(deps: PodServiceDeps, params: CancelPodParams): Promise<Result<void>> {
  const { podRoundId, requestedBy } = params

  const round = await deps.prisma.podRound.findUnique({ where: { id: podRoundId } })
  if (!round) {
    return err(notFound('Pod round not found'))
  }
  if (round.organizerDiscordId !== requestedBy) {
    return err(forbidden('Only the organizer who started this round can cancel it'))
  }

  await deps.prisma.podRound.update({
    where: { id: podRoundId },
    data: { status: 'CANCELLED' },
  })
  return ok(undefined)
}

export interface CancelActiveRoundResult {
  podRoundId: string
  setCode: string
  originGuildName: string | null
  targets: Array<{ channelId: string; messageId: string | null }>
}

// /cancel-pod takes no arguments (INTEGRATIONS.md's cancel-pod command
// definition has none) — it cancels the calling organizer's single most
// recently started round, and only if that specific round is still
// cancellable (COLLECTING/THRESHOLD_REACHED). Nothing today prevents an
// organizer from starting more than one round concurrently (no unique
// constraint on organizerDiscordId + active status), so "most recent" is
// a deliberate, documented choice for that edge case, not an oversight.
//
// Deliberately queries for the most recent round of ANY status first,
// then checks its status — not "most recent round that's still
// cancellable" (a bug this used to have): filtering the WHERE clause to
// cancellable statuses picks the most recent *matching* round, which can
// silently skip past an organizer's actual latest round (already fired,
// expired, or cancelled) and reach back to an older still-COLLECTING one
// instead. That reached back past what the organizer meant by "my
// current round" and cancelled a stale one they'd already moved on from.
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
    where: { organizerDiscordId },
    orderBy: { createdAt: 'desc' },
  })
  if (!round || (round.status !== 'COLLECTING' && round.status !== 'THRESHOLD_REACHED')) {
    return null
  }

  const cancelResult = await cancelPod(deps, { podRoundId: round.id, requestedBy: organizerDiscordId })
  if (!cancelResult.ok) {
    // Unreachable in practice — round was just found scoped to this exact
    // organizerDiscordId above, so cancelPod's own not-found/forbidden
    // checks can't fire here. A real Error (not a ServiceError) since
    // reaching this would mean an actual invariant violation, not a
    // business-rule outcome.
    throw new Error(`cancelPod unexpectedly failed for a round just found by the same organizer: ${cancelResult.error.kind}`)
  }

  const targetRows = await deps.prisma.podRoundTarget.findMany({ where: { podRoundId: round.id } })
  return {
    podRoundId: round.id,
    setCode: round.setCode,
    originGuildName: round.originGuildName,
    targets: targetRows.map((t) => ({ channelId: t.channelId, messageId: t.messageId })),
  }
}

export interface ConcludePodParams {
  podRoundId: string
  requestedBy: string
}

// New terminal transition (POD_CREATED -> CONCLUDED) for a round the
// organizer says has actually finished on PTP's side — see tasks/010.
// Trusts the organizer outright (resolved decision #1): no verification
// against PTP that the draft really finished, no elapsed-time guard. A
// plain conditional `update` is enough here, unlike fireRound's
// updateMany-as-compare-and-swap claim — there's no concurrent writer
// racing to conclude the same round, so the status checks below (which
// already read-then-branch) are sufficient guarding on their own.
export async function concludePod(deps: PodServiceDeps, params: ConcludePodParams): Promise<Result<void>> {
  const { podRoundId, requestedBy } = params

  const round = await deps.prisma.podRound.findUnique({ where: { id: podRoundId } })
  if (!round) {
    return err(notFound('Pod round not found'))
  }
  if (round.organizerDiscordId !== requestedBy) {
    return err(forbidden('Only the organizer who started this round can conclude it'))
  }

  if (round.status === 'COLLECTING' || round.status === 'THRESHOLD_REACHED') {
    return err(validationError("This round hasn't fired yet — nothing to conclude. Did you mean `/cancel-pod`?"))
  }
  if (round.status === 'CANCELLED') {
    return err(validationError('This round was already cancelled.'))
  }
  if (round.status === 'EXPIRED') {
    return err(validationError('This round already expired.'))
  }
  if (round.status === 'CONCLUDED') {
    return err(validationError('This round has already been concluded.'))
  }

  await deps.prisma.podRound.update({
    where: { id: podRoundId },
    data: { status: 'CONCLUDED' },
  })
  return ok(undefined)
}

export interface ConcludeActiveRoundResult {
  podRoundId: string
  setCode: string
  originGuildName: string | null
  chatChannelId: string | null
  targets: Array<{ channelId: string; messageId: string | null }>
}

// /conclude-pod takes no arguments, same as /cancel-pod — concludes the
// calling organizer's single most recently started round, and only if
// that specific round is in the one concludable state (POD_CREATED).
//
// Deliberately queries for the most recent round of ANY status first, then
// checks its status via concludePod below — not "most recent round that's
// still concludable" — for the exact same reason documented on
// cancelActiveRound above: filtering the WHERE clause to concludable
// statuses would pick the most recent *matching* round, which can
// silently reach back past the organizer's actual latest round (e.g. one
// that's already CANCELLED or CONCLUDED) to an older POD_CREATED one
// instead.
//
// Unlike cancelActiveRound, this returns a Result rather than `| null`:
// conclude has several distinct non-concludable statuses, each with its
// own message (see concludePod's guards), so the caller needs to surface
// *why* a round isn't concludable, not just that it isn't. "No round
// found at all" is reported the same way, as a not_found error, so the
// command handler has exactly one branch (result.ok === false) to turn
// into an ephemeral reply instead of two.
export async function concludeActiveRound(
  deps: PodServiceDeps,
  organizerDiscordId: string
): Promise<Result<ConcludeActiveRoundResult>> {
  const round = await deps.prisma.podRound.findFirst({
    where: { organizerDiscordId },
    orderBy: { createdAt: 'desc' },
  })
  if (!round) {
    return err(notFound("You don't have a pod round to conclude."))
  }

  const concludeResult = await concludePod(deps, { podRoundId: round.id, requestedBy: organizerDiscordId })
  if (!concludeResult.ok) {
    return err(concludeResult.error)
  }

  const targetRows = await deps.prisma.podRoundTarget.findMany({ where: { podRoundId: round.id } })
  return ok({
    podRoundId: round.id,
    setCode: round.setCode,
    originGuildName: round.originGuildName,
    chatChannelId: round.chatChannelId,
    targets: targetRows.map((t) => ({ channelId: t.channelId, messageId: t.messageId })),
  })
}

type ExpiredRoundTarget = { channelId: string; messageId: string | null }

export type ExpiredRoundInfo =
  | {
      podRoundId: string
      setCode: string
      outcome: 'expired'
      signupDiscordIds: string[]
      originGuildName: string | null
      targets: ExpiredRoundTarget[]
    }
  | {
      podRoundId: string
      setCode: string
      outcome: 'fired'
      count: number
      threshold: number
      shareUrl?: string
      chatUrl?: string
      chatChannelId?: string
      signupDiscordIds: string[]
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
export async function expireOverdueRounds(deps: PodServiceDeps, onFiring?: OnFiringHook): Promise<ExpiredRoundInfo[]> {
  const candidates = await deps.prisma.podRound.findMany({
    where: { status: 'COLLECTING', scheduledFor: { lte: new Date() } },
    include: { organizer: true },
  })

  const results: ExpiredRoundInfo[] = []
  for (const round of candidates) {
    // Single findMany instead of a separate count-then-list pair, same
    // restructuring as recordSignup above — count is just the result's
    // length, and signupDiscordIds is needed either way for the message
    // body's "Players:" line (discord/podMessage.ts). Fetched before firing
    // is even attempted, so it's a superset-safe source of truth for "who's
    // signed up" — used for both outcomes below rather than mixing in
    // fireRound's own separate internal fetch (which exists for the
    // chat-channel/DM feature, a different purpose).
    const signups = await deps.prisma.podRoundSignup.findMany({
      where: { podRoundId: round.id, status: 'IN' },
    })
    const count = signups.length
    // Sorted by signup-time username snapshot — see the matching comment
    // in recordSignup above for why (stable "Players:" list order, this
    // sort doesn't affect what discord/podMessage.ts actually renders).
    const signupDiscordIds = [...signups]
      .sort((a, b) => a.usernameSnapshot.localeCompare(b.usernameSnapshot, undefined, { sensitivity: 'base' }))
      .map((s) => s.discordId)

    if (count >= round.threshold) {
      const fireResult = await fireRound(deps, round, onFiring)
      if (!fireResult.podCreated) continue

      const targetRows = await deps.prisma.podRoundTarget.findMany({ where: { podRoundId: round.id } })
      results.push({
        podRoundId: round.id,
        setCode: round.setCode,
        outcome: 'fired',
        count,
        threshold: round.threshold,
        shareUrl: fireResult.shareUrl,
        chatUrl: fireResult.chatUrl,
        chatChannelId: fireResult.chatChannelId,
        signupDiscordIds,
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
      signupDiscordIds,
      setCode: round.setCode,
      outcome: 'expired',
      originGuildName: round.originGuildName,
      targets: targetRows.map((t) => ({ channelId: t.channelId, messageId: t.messageId })),
    })
  }

  return results
}

// Bounded window a round is allowed to keep retrying pod creation after its
// initial fireRound attempt failed (see issue #5 — a round stuck at
// THRESHOLD_REACHED with a failed PTP call used to notify no one). Once a
// round has been stuck this long without a successful create, retryFailedFires
// below gives up and sends a one-time visible failure notification instead
// of continuing to retry silently forever.
const RETRY_WINDOW_MS = 30 * 60 * 1000

type RetryRoundTarget = { channelId: string; messageId: string | null }

export type RetryFireResult =
  | {
      podRoundId: string
      setCode: string
      outcome: 'succeeded'
      count: number
      shareUrl: string
      chatUrl?: string
      chatChannelId?: string
      signupDiscordIds: string[]
      originGuildName: string | null
      targets: RetryRoundTarget[]
    }
  | {
      podRoundId: string
      setCode: string
      outcome: 'gave-up'
      originGuildName: string | null
      targets: RetryRoundTarget[]
    }

// Opaque, plain-data hook invoked only for a round that (a) just succeeded
// on retry and (b) already has a chat channel from its first attempt — asks
// the Discord-touching caller for a fresh invite link into that *existing*
// channel. Never recreates the channel or its permission overwrites (those
// already happened during the original fireRound call); see
// discord/podChat.ts's refreshPodChatInvite, the one real implementation.
// Same Discord-agnostic-services boundary rationale as OnFiringHook above —
// this file only ever deals in plain data in, a plain optional URL back out.
export type OnRetrySuccessHook = (ctx: { chatChannelId: string }) => Promise<string | undefined>

// Runs on a periodic sweep (jobs/retryFailedFires.ts), not on any user
// action — finds every round stuck at THRESHOLD_REACHED whose initial
// fireRound attempt failed to create the PTP pod (issue #5: previously such
// a round just sat there forever with zero visible signal to anyone).
// Query excludes fireFailureNotified: true so a round that already got its
// one give-up notification is never re-processed or re-notified on a later
// tick. For each candidate still within RETRY_WINDOW_MS of its
// thresholdReachedAt, this re-attempts only the PTP-creation step (via
// attemptPodCreation) — NOT the original claim, signups fetch, or onFiring
// chat-channel creation, all of which only ever happen once, during the
// first fireRound call. A round past the window (or with a null
// thresholdReachedAt — pre-migration data, or any other edge case that
// shouldn't crash this) gives up: fireFailureNotified is set so this never
// re-fires for that round again, but status stays THRESHOLD_REACHED,
// deliberately not auto-cancelled — still manually cancellable via
// /cancel-pod, preserving the ability to retry a still-recoverable round by
// hand if the operator intervenes.
export async function retryFailedFires(
  deps: PodServiceDeps,
  onRetrySuccess?: OnRetrySuccessHook
): Promise<RetryFireResult[]> {
  const candidates = await deps.prisma.podRound.findMany({
    where: { status: 'THRESHOLD_REACHED', fireFailureNotified: false },
    include: { organizer: true },
  })

  const results: RetryFireResult[] = []
  const now = Date.now()

  for (const round of candidates) {
    const stuckSince = round.thresholdReachedAt?.getTime()
    const withinWindow = stuckSince !== undefined && now - stuckSince < RETRY_WINDOW_MS

    if (withinWindow) {
      // Single findMany instead of a separate count-then-list pair, same
      // restructuring as recordSignup/expireOverdueRounds above — count is
      // just the result's length, and signupDiscordIds is needed either way
      // for the succeeded result's "Players:" line (discord/podMessage.ts).
      const signups = await deps.prisma.podRoundSignup.findMany({
        where: { podRoundId: round.id, status: 'IN' },
      })
      const count = signups.length
      const signupDiscordIds = [...signups]
        .sort((a, b) => a.usernameSnapshot.localeCompare(b.usernameSnapshot, undefined, { sensitivity: 'base' }))
        .map((s) => s.discordId)

      const attempt = await attemptPodCreation(deps, round, round.chatChannelId ?? undefined)
      if (!attempt.podCreated || !attempt.shareUrl) {
        // Still failing, still within the window — nothing to do this tick,
        // fireFailureNotified stays false so the next sweep tick picks this
        // round back up.
        continue
      }

      const chatUrl =
        round.chatChannelId && onRetrySuccess ? await onRetrySuccess({ chatChannelId: round.chatChannelId }) : undefined

      const targetRows = await deps.prisma.podRoundTarget.findMany({ where: { podRoundId: round.id } })
      results.push({
        podRoundId: round.id,
        setCode: round.setCode,
        outcome: 'succeeded',
        count,
        shareUrl: attempt.shareUrl,
        chatUrl,
        chatChannelId: round.chatChannelId ?? undefined,
        signupDiscordIds,
        originGuildName: round.originGuildName,
        targets: targetRows.map((t) => ({ channelId: t.channelId, messageId: t.messageId })),
      })
      continue
    }

    // Past the retry window (or thresholdReachedAt is null and so can't be
    // measured at all) — give up. Deliberately NOT a compare-and-swap
    // updateMany like fireRound's claim: there's no concurrent writer racing
    // to give up on the same round (this sweep is the only place
    // fireFailureNotified is ever set), so a plain update is sufficient.
    await deps.prisma.podRound.update({
      where: { id: round.id },
      data: { fireFailureNotified: true },
    })

    const targetRows = await deps.prisma.podRoundTarget.findMany({ where: { podRoundId: round.id } })
    results.push({
      podRoundId: round.id,
      setCode: round.setCode,
      outcome: 'gave-up',
      originGuildName: round.originGuildName,
      targets: targetRows.map((t) => ({ channelId: t.channelId, messageId: t.messageId })),
    })
  }

  return results
}
