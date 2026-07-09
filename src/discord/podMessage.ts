import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIEmbed,
} from 'discord-api-types/v10'

const COLLECTING_COLOR = 0x5865f2 // Discord blurple
const POD_FULL_COLOR = 0x57f287 // green

export interface PodRoundMessageState {
  podRoundId: string
  setCode: string
  threshold: number
  count: number
  /** Present once the round has created its PTP pod (§7.5 step 4). */
  shareUrl?: string
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

  return {
    embeds: [
      {
        title: `${state.setCode} Draft Pod`,
        description: `${state.count}/${state.threshold} confirmed.`,
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
