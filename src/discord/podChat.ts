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
// "Join the chat" button. Returns the created channel's ID alongside the
// invite URL — the PTP share URL doesn't exist yet at this point (this runs
// before ptp.createPod), so the caller needs the channel ID to come back
// out through fireRound and post the welcome message (see
// postPodChatWelcomeMessage below) once that URL is known.
export async function createPodChatSpace(
  discordRest: DiscordRestClient,
  params: { setCode: string; originGuildId: string; organizerDiscordId: string; signupDiscordIds: string[] },
  log: (err: unknown, message: string) => void
): Promise<{ channelId: string; inviteUrl: string } | undefined> {
  try {
    // Overwrites for IDs who aren't currently members of originGuildId are
    // inert until they join — this is what lets a signup from a different
    // guild still land with access the moment they use the invite link
    // below, with no membership check needed up front. The bot's own ID
    // has to be included too, not just implied by its guild-wide OAuth
    // permissions: the @everyone deny below applies to every member
    // including the bot itself, and nothing else in this overwrite list
    // grants it back — omitting it caused a live "Missing Access" 403 the
    // first time postPodChatWelcomeMessage tried to post into a channel
    // the bot had just created but denied itself access to.
    const memberIds = new Set([params.organizerDiscordId, discordRest.botUserId, ...params.signupDiscordIds])

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
    return { channelId: channel.id, inviteUrl: `https://discord.com/invite/${invite.code}` }
  } catch (err) {
    log(err, 'failed to create pod chat channel')
    return undefined
  }
}

// Best-effort welcome message posted into the chat channel createPodChatSpace
// above just created — has to happen as a separate step, after fireRound
// returns, because the PTP share URL doesn't exist until ptp.createPod runs,
// which happens AFTER the channel is created (see services/pods.ts's
// fireRound for why that ordering is deliberate and not being changed here).
// Never throws, same one-big-try-catch shape as createPodChatSpace above and
// discord/dmSignups.ts's notifyPlayersByDm — this is Discord-API-call
// handling, not a business-rule Result. On failure this just logs via the
// passed callback; there's no fallback UI for a missed welcome message, the
// "Join the chat" button (built from createPodChatSpace's inviteUrl) already
// got everyone into the channel regardless.
export async function postPodChatWelcomeMessage(
  discordRest: DiscordRestClient,
  channelId: string,
  params: { shareUrl: string; signupDiscordIds: string[] },
  log: (err: unknown, message: string) => void
): Promise<void> {
  try {
    const mentions = params.signupDiscordIds.map((id) => `<@${id}>`).join(' ')
    const content = mentions
      ? `${mentions} the draft is ready — join here: ${params.shareUrl}`
      : `The draft is ready — join here: ${params.shareUrl}`

    await discordRest.postMessage(channelId, { content })
  } catch (err) {
    log(err, 'failed to post pod chat welcome message')
  }
}

// Best-effort supplement used only by the fire-retry path (see
// services/pods.ts's retryFailedFires, jobs/retryFailedFires.ts) — gets a
// fresh invite link for a chat channel that createPodChatSpace above already
// created on the round's first (failed) fire attempt. Deliberately does NOT
// recreate the channel or its permission overwrites: those already
// happened, and re-running them on a retry would be wasteful at best and
// wrong at worst (e.g. clobbering overwrites for players who left/joined
// since). Same never-throws, single-try-catch, log-and-return-undefined
// shape as createPodChatSpace/postPodChatWelcomeMessage above — the caller
// just omits the "Join the chat" button/message if this fails.
export async function refreshPodChatInvite(
  discordRest: DiscordRestClient,
  channelId: string,
  log: (err: unknown, message: string) => void
): Promise<string | undefined> {
  try {
    const invite = await discordRest.createInvite(channelId)
    return `https://discord.com/invite/${invite.code}`
  } catch (err) {
    log(err, 'failed to refresh pod chat invite')
    return undefined
  }
}
