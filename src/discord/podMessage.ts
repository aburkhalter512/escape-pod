import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIEmbed,
} from 'discord-api-types/v10'

const COLLECTING_COLOR = 0x5865f2 // Discord blurple
const POD_FULL_COLOR = 0x57f287 // green
const CANCELLED_COLOR = 0xed4245 // Discord red
const EXPIRED_COLOR = 0xfaa61a // Discord orange — distinct from CANCELLED

export interface PodRoundMessageState {
  podRoundId: string
  setCode: string
  threshold: number
  count: number
  /** Present once the round has created its PTP pod (§7.5 step 4). */
  shareUrl?: string
  /** If present, rendered via Discord's own <t:epoch:R> timestamp markup
   * (auto-localized per viewer) — see util/duration.ts for why the
   * deadline itself is collected as a relative duration, not this. */
  scheduledFor?: Date
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
          title: `${state.setCode} Draft Pod — Full!`,
          description: `${state.count}/${state.threshold} confirmed. The draft is starting.`,
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
          ],
        },
      ],
    }
  }

  const deadlineNote = state.scheduledFor
    ? ` Cancels automatically <t:${Math.floor(state.scheduledFor.getTime() / 1000)}:R> if not full.`
    : ''

  return {
    embeds: [
      {
        title: `${state.setCode} Draft Pod`,
        description: `${state.count}/${state.threshold} confirmed.${deadlineNote}`,
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
export function buildCancelledPodMessage(setCode: string): PodRoundMessageBody {
  return {
    embeds: [
      {
        title: `${setCode} Draft Pod — Cancelled`,
        description: 'The organizer cancelled this round.',
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
export function buildExpiredPodMessage(setCode: string): PodRoundMessageBody {
  return {
    embeds: [
      {
        title: `${setCode} Draft Pod — Expired`,
        description: 'Not enough players joined before the deadline.',
        color: EXPIRED_COLOR,
      },
    ],
    components: [],
  }
}
