import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord-api-types/v10'
import type { DiscordRestClient } from './rest.js'

const VIEW_AND_SEND = (PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages).toString()
const DENY_VIEW = PermissionFlagsBits.ViewChannel.toString()

// Best-effort supplement to the "Starting!" broadcast message (see
// discord/podMessage.ts) — a private text channel in the round's origin
// guild, shared by the organizer and everyone who signed up (regardless of
// which guild *they* joined from), created before the PTP pod itself so
// everyone lands in a shared space first. Never throws: channel/invite
// creation can fail for reasons entirely outside the bot's control (no
// "Manage Channels" permission in that guild, the bot no longer being a
// member of it, etc.), and none of that should ever block the pod creation
// that follows in services/pods.ts's fireRound. On any failure this logs
// via the passed callback and returns undefined — the caller just omits the
// "Join the chat" button.
export async function createPodChatSpace(
  discordRest: DiscordRestClient,
  params: { setCode: string; originGuildId: string; organizerDiscordId: string; signupDiscordIds: string[] },
  log: (err: unknown, message: string) => void
): Promise<string | undefined> {
  try {
    // Overwrites for IDs who aren't currently members of originGuildId are
    // inert until they join — this is what lets a signup from a different
    // guild still land with access the moment they use the invite link
    // below, with no membership check needed up front.
    const memberIds = new Set([params.organizerDiscordId, ...params.signupDiscordIds])

    const channel = await discordRest.createChannel(params.originGuildId, {
      name: `${params.setCode}-pod-chat`,
      type: ChannelType.GuildText,
      permission_overwrites: [
        // @everyone's role ID is the guild ID itself.
        { id: params.originGuildId, type: OverwriteType.Role, allow: '0', deny: DENY_VIEW },
        ...[...memberIds].map((id) => ({
          id,
          type: OverwriteType.Member,
          allow: VIEW_AND_SEND,
          deny: '0',
        })),
      ],
    })

    const invite = await discordRest.createInvite(channel.id)
    return `https://discord.com/invite/${invite.code}`
  } catch (err) {
    log(err, 'failed to create pod chat channel')
    return undefined
  }
}
