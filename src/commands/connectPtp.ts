import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
} from 'discord-api-types/v10'
import type { CommandHandler } from './types.js'

// INTEGRATIONS.md §8.2 step 1 — no third-party OAuth exists on PTP's side
// (§8.1), so this is instructions + a button that opens a modal for the
// organizer to paste a manually-retrieved token into.
export const connectPtp: CommandHandler = async () => {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      flags: MessageFlags.Ephemeral,
      content:
        '**Link your Protect the Pod account**\n\n' +
        '1. Sign in (if needed): https://www.protectthepod.com/api/auth/signin/discord\n' +
        '2. Grab a token: https://www.protectthepod.com/api/auth/token\n' +
        '3. Copy the `token` value from the response, then click the button below and paste it in.',
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              custom_id: 'connect-ptp:open-modal',
              label: 'Paste your token',
            },
          ],
        },
      ],
    },
  }
}
