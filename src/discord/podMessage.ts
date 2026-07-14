import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIEmbed,
} from 'discord-api-types/v10'
import { POD_CAPACITY } from '../podConfig.js'

const COLLECTING_COLOR = 0x5865f2 // Discord blurple
const POD_FULL_COLOR = 0x57f287 // green
const CANCELLED_COLOR = 0xed4245 // Discord red
const EXPIRED_COLOR = 0xfaa61a // Discord orange — distinct from CANCELLED
const CONCLUDED_COLOR = 0x99aab5 // Discord greyple — muted, distinct from all four above
const FIRE_FAILED_COLOR = 0x992d22 // Discord dark red — distinct from CANCELLED's brighter red

export interface PodRoundMessageState {
  podRoundId: string
  setCode: string
  /** The organizer's configured minimum — only relevant while still
   * COLLECTING (shown alongside the deadline, if any). Once shareUrl is
   * set the round has already fired, against POD_CAPACITY or `threshold`
   * players depending on why (see services/pods.ts's fireRound), so this
   * isn't consulted for that state. */
  threshold: number
  count: number
  /** Present once the round has created its PTP pod (§7.5 step 4). */
  shareUrl?: string
  /** If present, rendered via Discord's own <t:epoch:R> timestamp markup
   * (auto-localized per viewer) — see util/duration.ts for why the
   * deadline itself is collected as a relative duration, not this. */
  scheduledFor?: Date
  /** Name of the guild /start-pod was invoked in — shown so a guild
   * receiving a cross-posted round (§1's "reach beyond their own server")
   * knows where it originated. Resolved once at round-creation time (see
   * services/pods.ts's StartPodParams), not looked up here. */
  originGuildName?: string | null
  /** Invite link to the temporary per-round chat channel created in the
   * origin guild once the round fires (see discord/podChat.ts) — only ever
   * populated alongside shareUrl (the fired state), never during
   * COLLECTING. Absent when chat-channel creation itself failed (best-
   * effort; see createPodChatSpace) or the round has no origin guild. */
  chatUrl?: string
  /** Everyone currently signed up (status: 'IN'), as raw Discord IDs — only
   * ever populated for buildPodRoundMessage's two branches (collecting and
   * fired); buildCancelledPodMessage/buildExpiredPodMessage don't take this
   * at all. Rendered as `<@id>` mentions so Discord shows live-updating
   * usernames rather than a point-in-time snapshot. Omitted (not an empty
   * array's worth of content) when empty — a freshly-posted round with zero
   * signups yet shouldn't show a bare "Players:" line. */
  signupDiscordIds?: string[]
}

// Shared across every message state below (collecting, fired, cancelled,
// expired) — the "where did this round come from" context is the same
// regardless of what else changed, so it's a consistent labeled line in
// every state's description body (previously the embed footer — moved so
// this round's message reads the same way across every state it gets
// edited into, rather than body text in some states and a footer in
// others). Omitted entirely (not "Organizer: Unknown") when there's no name
// to show, same convention as the rest of this file.
function organizerLine(originGuildName: string | null | undefined): string | undefined {
  return originGuildName ? `Organizer: ${originGuildName}` : undefined
}

// Only used by buildPodRoundMessage's two branches (see point 2) — everyone
// currently signed up, rendered as a bulleted list of Discord mentions so
// the list stays live (renders the viewer's current nickname, not a stale
// username snapshot) while still reading as a scannable roster rather than
// a comma-dump. Already sorted by signup-time username (see
// services/pods.ts's recordSignup/expireOverdueRounds) — this function just
// renders whatever order it's given, it doesn't sort. Omitted entirely
// when there's nobody signed up yet, same "just omit if absent" convention
// as organizerLine above.
function playersLine(signupDiscordIds: string[] | undefined): string | undefined {
  return signupDiscordIds && signupDiscordIds.length > 0
    ? `Players:\n${signupDiscordIds.map((id) => `- <@${id}>`).join('\n')}`
    : undefined
}

export interface PodRoundMessageBody {
  embeds: APIEmbed[]
  components: APIActionRowComponent<APIButtonComponent>[]
}

// Shared by both the initial post (start-pod) and every subsequent edit
// (signup fan-out) — see INTEGRATIONS.md §7.5 steps 2-4. Keeping this pure
// and side-effect-free means it's cheap to unit test independent of any
// Discord API call.
export function buildPodRoundMessage(state: PodRoundMessageState): PodRoundMessageBody {
  if (state.shareUrl) {
    const firedDescription = [
      `${state.count} confirmed. The draft is starting.`,
      organizerLine(state.originGuildName),
      playersLine(state.signupDiscordIds),
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n')

    return {
      embeds: [
        {
          title: `${state.setCode} Draft Pod — Starting!`,
          description: firedDescription,
          color: POD_FULL_COLOR,
        },
      ],
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: 'Join the draft',
              url: state.shareUrl,
            },
            ...(state.chatUrl
              ? [
                  {
                    type: ComponentType.Button as const,
                    style: ButtonStyle.Link as const,
                    label: 'Join the chat',
                    url: state.chatUrl,
                  },
                ]
              : []),
          ],
        },
      ],
    }
  }

  const deadlineNote = state.scheduledFor
    ? ` Fires automatically <t:${Math.floor(state.scheduledFor.getTime() / 1000)}:R> if at least ${state.threshold} have joined, otherwise cancels.`
    : ''

  const collectingDescription = [
    `${state.count}/${POD_CAPACITY} confirmed.${deadlineNote}`,
    organizerLine(state.originGuildName),
    playersLine(state.signupDiscordIds),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')

  return {
    embeds: [
      {
        title: `${state.setCode} Draft Pod`,
        description: collectingDescription,
        color: COLLECTING_COLOR,
      },
    ],
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Success,
            label: "I'm in",
            custom_id: `pod-signup:${state.podRoundId}:in`,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            label: 'Leave',
            custom_id: `pod-signup:${state.podRoundId}:leave`,
          },
        ],
      },
    ],
  }
}

// §7.5 step 5 — what every target guild's RSVP message gets edited to once
// the organizer cancels. No buttons: the round is over, so there's
// nothing left to click — an explicit empty components array, not an
// omitted field, since Discord treats a missing components field on an
// edit as "leave the existing components alone," not "remove them."
export function buildCancelledPodMessage(setCode: string, originGuildName?: string | null): PodRoundMessageBody {
  const description = ['The organizer cancelled this round.', organizerLine(originGuildName)]
    .filter((line): line is string => Boolean(line))
    .join('\n')

  return {
    embeds: [
      {
        title: `${setCode} Draft Pod — Cancelled`,
        description,
        color: CANCELLED_COLOR,
      },
    ],
    components: [],
  }
}

// What every target guild's RSVP message gets edited to when the
// periodic sweep (jobs/expirePodRounds.ts) auto-expires a round whose
// deadline passed without reaching threshold. Same no-buttons shape as
// buildCancelledPodMessage, but visually and textually distinct — this
// wasn't the organizer giving up, it's just running out the clock.
export function buildExpiredPodMessage(setCode: string, originGuildName?: string | null): PodRoundMessageBody {
  const description = ['Not enough players joined before the deadline.', organizerLine(originGuildName)]
    .filter((line): line is string => Boolean(line))
    .join('\n')

  return {
    embeds: [
      {
        title: `${setCode} Draft Pod — Expired`,
        description,
        color: EXPIRED_COLOR,
      },
    ],
    components: [],
  }
}

// What every target guild's RSVP message gets edited to when the organizer
// manually runs /conclude-pod on a fired (POD_CREATED) round — see
// services/pods.ts's concludePod/concludeActiveRound. Same no-buttons shape
// as buildCancelledPodMessage/buildExpiredPodMessage, but its own title,
// copy, and color: this is the "the draft actually finished" terminal
// state, distinct from a round that never got off the ground.
export function buildConcludedPodMessage(setCode: string, originGuildName?: string | null): PodRoundMessageBody {
  const description = ['This draft has concluded.', organizerLine(originGuildName)]
    .filter((line): line is string => Boolean(line))
    .join('\n')

  return {
    embeds: [
      {
        title: `${setCode} Draft Pod — Concluded`,
        description,
        color: CONCLUDED_COLOR,
      },
    ],
    components: [],
  }
}

// What every target guild's RSVP message gets edited to when the retry
// sweep (services/pods.ts's retryFailedFires, jobs/retryFailedFires.ts)
// gives up after RETRY_WINDOW_MS of failed PTP pod-creation attempts (issue
// #5 — this round would otherwise sit at THRESHOLD_REACHED forever with no
// visible signal to anyone). Same no-buttons shape as
// buildCancelledPodMessage/buildExpiredPodMessage/buildConcludedPodMessage,
// but its own title, copy, and color: unlike those, the round is NOT
// auto-cancelled here (still THRESHOLD_REACHED under the hood, still
// cancellable via /cancel-pod) — the copy says so explicitly since there
// are no buttons left on this message to do it from.
export function buildFireFailedPodMessage(setCode: string, originGuildName?: string | null): PodRoundMessageBody {
  const description = [
    'Something went wrong creating this draft pod after several attempts. Run `/cancel-pod` and try again.',
    organizerLine(originGuildName),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')

  return {
    embeds: [
      {
        title: `${setCode} Draft Pod — Failed`,
        description,
        color: FIRE_FAILED_COLOR,
      },
    ],
    components: [],
  }
}
