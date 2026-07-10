import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  PermissionFlagsBits,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord-api-types/v10'

// Command set from INTEGRATIONS.md §7.4. Registered globally per guild the
// bot is installed in via scripts/register-commands.ts.
export const commandDefinitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  {
    name: 'connect-ptp',
    description: 'Link your Protect the Pod account so you can organize draft pods',
    type: ApplicationCommandType.ChatInput,
  },
  {
    name: 'subscribe-guild',
    description: 'Opt this server in to receive draft pod LFG broadcasts',
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        name: 'channel',
        description: 'Channel to post LFG rounds into',
        type: ApplicationCommandOptionType.Channel,
        required: true,
      },
    ],
  },
  {
    name: 'allow-organizer',
    description: 'Approve an organizer to post draft pod rounds into this server',
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        name: 'organizer',
        description: 'The organizer to approve',
        type: ApplicationCommandOptionType.User,
        required: true,
      },
    ],
  },
  {
    name: 'start-pod',
    description: 'Start a new draft pod RSVP round across your eligible servers',
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: 'set',
        description: 'Set code to draft (e.g. JTL, LOF, SOR)',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'threshold',
        description: 'Players needed before the pod is created (default 8)',
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 6,
        max_value: 8,
      },
      {
        name: 'deadline',
        description: 'Auto-cancel if threshold isn\'t reached by then, e.g. "2h", "90m", "1d" (optional)',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
  {
    name: 'cancel-pod',
    description: 'Cancel your in-progress draft pod round',
    type: ApplicationCommandType.ChatInput,
  },
]
