import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIEmbed,
  type APIEmbedFooter,
} from 'discord-api-types/v10'
import { POD_CAPACITY } from '../podConfig.js'

const COLLECTING_COLOR = 0x5865f2 // Discord blurple
const POD_FULL_COLOR = 0x57f287 // green
const CANCELLED_COLOR = 0xed4245 // Discord red
const EXPIRED_COLOR = 0xfaa61a // Discord orange — distinct from CANCELLED
const CONCLUDED_COLOR = 0x99aab5 // Discord greyple — muted, distinct from all four above

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
}

// Shared across every message state below (collecting, fired, cancelled,
// expired) — the "where did this round come from" context is the same
// regardless of what else changed, so it lives in the embed footer rather
// than duplicated into every state's description text. Absent (not just
// empty) when there's no name to show, since APIEmbed's footer field is
// itself optional.
function originFooter(originGuildName: string | null | undefined): APIEmbedFooter | undefined {
  return originGuildName ? { text: `Started from ${originGuildName}` } : undefined
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
    return {
      embeds: [
        {
          title: `${state.setCode} Draft Pod — Starting!`,
          description: `${state.count} confirmed. The draft is starting.`,
          color: POD_FULL_COLOR,
          footer: originFooter(state.originGuildName),
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

  return {
    embeds: [
      {
        title: `${state.setCode} Draft Pod`,
        description: `${state.count}/${POD_CAPACITY} confirmed.${deadlineNote}`,
        color: COLLECTING_COLOR,
        footer: originFooter(state.originGuildName),
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
  return {
    embeds: [
      {
        title: `${setCode} Draft Pod — Cancelled`,
        description: 'The organizer cancelled this round.',
        color: CANCELLED_COLOR,
        footer: originFooter(originGuildName),
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
  return {
    embeds: [
      {
        title: `${setCode} Draft Pod — Expired`,
        description: 'Not enough players joined before the deadline.',
        color: EXPIRED_COLOR,
        footer: originFooter(originGuildName),
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
  return {
    embeds: [
      {
        title: `${setCode} Draft Pod — Concluded`,
        description: 'This draft has concluded.',
        color: CONCLUDED_COLOR,
        footer: originFooter(originGuildName),
      },
    ],
    components: [],
  }
}
