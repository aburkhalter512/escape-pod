import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
} from 'discord-api-types/v10'
import { ephemeral } from './helpers.js'
import type { CommandHandler } from './types.js'

// Replaces connectPtp.ts (PTP, dropped entirely — hard cutover). Unlike
// PTP's per-organizer linking, a Niamos token is scoped to this server —
// any admin (default_member_permissions: ManageGuild, see
// definitions.ts) can run this once to link the whole server, after
// which any eligible organizer can /start-pod from it. No third-party
// OAuth exists on Niamos's side either, so this is the same
// instructions-plus-modal-button flow /connect-ptp used.
export const connectNiamos: CommandHandler = async ({ interaction }) => {
  // A guild-scoped link needs a guild — same DM guard as startPod.ts,
  // for the same reason: the button below carries guild_id forward to
  // interactions/components.ts's modal-submit handler, which is what
  // actually stores the token, so there's no guild to link to from a DM.
  if (!interaction.guild_id) {
    return ephemeral('Run `/connect-niamos` from inside a server, not a DM.')
  }

  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      flags: MessageFlags.Ephemeral,
      content:
        "**Link this server's Niamos token**\n\n" +
        '1. Sign in (if needed) and generate a bot token: https://niamos.net/settings\n' +
        '2. Give it a label, click "generate token", then copy it.\n' +
        '3. Click the button below and paste it in. Only one token is allowed per server — linking again replaces the previous one.',
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              custom_id: 'connect-niamos:open-modal',
              label: 'Paste your token',
            },
          ],
        },
      ],
    },
  }
}
