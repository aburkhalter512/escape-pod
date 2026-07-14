import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  PermissionFlagsBits,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord-api-types/v10'
import { SWU_SETS } from '../swuSets.js'

// Command set from INTEGRATIONS.md §7.4. Registered globally per guild the
// bot is installed in via scripts/register-commands.ts.
export const commandDefinitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  {
    name: 'connect-ptp',
    description: 'Link your Protect the Pod account so you can organize draft pods',
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
  },
  {
    name: 'subscribe-guild',
    description: 'Opt this server in to receive draft pod LFG broadcasts, or reconfigure it',
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        name: 'channel',
        description: 'Channel to post LFG rounds into (required the first time; omit to leave unchanged)',
        type: ApplicationCommandOptionType.Channel,
        required: false,
      },
      {
        name: 'policy',
        description: 'Who can post rounds here (omit to leave unchanged; default on first setup: allow-list)',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: 'Allow-list — only organizers you approve', value: 'ALLOWLIST' },
          { name: 'Open — any linked organizer can post', value: 'OPEN' },
        ],
      },
    ],
  },
  {
    name: 'unsubscribe-guild',
    description: 'Stop this server from receiving draft pod LFG broadcasts',
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
  },
  {
    name: 'allow-organizer',
    description: 'Deprecated — use /allow-guild instead to trust an entire origin server',
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        name: 'organizer',
        description: 'Ignored — this command no longer grants access, see /allow-guild',
        type: ApplicationCommandOptionType.User,
        required: true,
      },
    ],
  },
  {
    name: 'allow-guild',
    description: 'Trust an entire server\'s organizers to post draft pod rounds into this server',
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        name: 'origin-server-id',
        // No native cross-guild picker exists for slash commands — the
        // admin supplies the raw ID (Developer Mode -> right-click the
        // other server's icon -> Copy Server ID).
        description: 'The other server\'s ID (enable Developer Mode, right-click its icon, Copy Server ID)',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: 'start-pod',
    description: 'Start a new draft pod RSVP round across your eligible servers',
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        name: 'set',
        description: 'Set to draft',
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: SWU_SETS.map((set) => ({ name: `${set.name} (${set.code})`, value: set.code })),
      },
      {
        name: 'threshold',
        description: 'Min players to still fire at the deadline, if set (default 8 = full table only)',
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 2,
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
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        name: 'round',
        // GitHub issue #6 — only needed when the organizer has more than
        // one active round at once; omitting it still works exactly as
        // before when there's just one. autocomplete: true is backed by
        // interactions/autocomplete.ts, which lists this organizer's own
        // currently-cancellable rounds live.
        description: 'Which round number (see the "#N" in its broadcast message) — omit if you only have one active',
        type: ApplicationCommandOptionType.Integer,
        required: false,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'conclude-pod',
    description: 'Conclude your finished draft pod round',
    type: ApplicationCommandType.ChatInput,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        name: 'round',
        description: 'Which round number (see the "#N" in its broadcast message) — omit if you only have one active',
        type: ApplicationCommandOptionType.Integer,
        required: false,
        autocomplete: true,
      },
    ],
  },
]
