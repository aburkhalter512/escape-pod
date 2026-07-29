import { REST } from '@discordjs/rest'
import type {
  RESTPostAPIChannelMessageJSONBody,
  RESTPostAPIChannelMessageResult,
  RESTPatchAPIChannelMessageJSONBody,
  RESTPatchAPIChannelMessageResult,
  RESTGetAPIGuildResult,
  RESTPostAPIGuildChannelJSONBody,
  RESTPostAPIGuildChannelResult,
  RESTPostAPIChannelInviteResult,
  RESTPostAPICurrentUserCreateDMChannelResult,
  RESTPatchAPIWebhookWithTokenMessageJSONBody,
  RESTPatchAPIWebhookWithTokenMessageResult,
} from 'discord-api-types/v10'
import { HttpDiscordRest } from './httpDiscordRest.js'

// The contract the app depends on for talking to Discord — scoped to the
// operations we actually perform, with real response types (no
// `unknown`). See testUtils/fakeDiscordRest.ts. The actual route/body
// logic (HttpDiscordRest) lives in httpDiscordRest.ts, shared by both
// platforms — this file only has the interface plus the AWS-specific
// factory below, which is the one place that needs a real
// @discordjs/rest runtime import; discord/restWorkers.ts (Workers) never
// imports this file's createDiscordRest, only HttpDiscordRest itself
// from httpDiscordRest.ts, so @discordjs/rest's actual code never ends
// up in the Workers bundle.
export interface DiscordRestClient {
  // A bot's user ID is always identical to its application/client ID
  // (standard Discord convention) — exposed here rather than fetched via
  // an extra `GET /users/@me` call, since discord/podChat.ts's
  // createPodChatSpace needs it synchronously to grant itself a
  // permission overwrite on a channel it's about to create.
  readonly botUserId: string
  postMessage(channelId: string, body: RESTPostAPIChannelMessageJSONBody): Promise<RESTPostAPIChannelMessageResult>
  editMessage(
    channelId: string,
    messageId: string,
    body: RESTPatchAPIChannelMessageJSONBody
  ): Promise<RESTPatchAPIChannelMessageResult>
  // /subscribe-guild's only use of this — the interaction payload itself
  // only ever includes { id, features, locale } for the invoking guild
  // (APIPartialInteractionGuild), never a display name, so getting a real
  // name for the eligible-guilds select menu in /start-pod means fetching
  // and storing it once here rather than on every /start-pod call.
  getGuild(guildId: string): Promise<RESTGetAPIGuildResult>
  // src/discord/podChat.ts's only use of this — creates the private
  // per-round chat channel in the organizer's origin guild.
  createChannel(guildId: string, body: RESTPostAPIGuildChannelJSONBody): Promise<RESTPostAPIGuildChannelResult>
  // Scoped to the channel just created above; a 6h max_age keeps this a
  // "temporary" invite that expires on its own rather than needing cleanup.
  createInvite(channelId: string): Promise<RESTPostAPIChannelInviteResult>
  // src/discord/dmSignups.ts's only use of this — opens (or reuses) a DM
  // channel with a given user so postMessage can send into it, same as
  // any other channel ID.
  createDmChannel(userId: string): Promise<RESTPostAPICurrentUserCreateDMChannelResult>
  // commands/concludePod.ts's only use of this — deletes the temporary
  // per-round chat channel (discord/podChat.ts's createPodChatSpace) once
  // the organizer concludes the round. Best-effort at the call site: a 404
  // from an already-deleted channel is swallowed there, not here.
  deleteChannel(channelId: string): Promise<void>
  // Followup for a *deferred* interaction response (InteractionResponseType
  // .DeferredMessageUpdate) — edits the interaction's own original response
  // via `PATCH /webhooks/{application_id}/{interaction_token}/messages/@original`,
  // any time within the interaction token's 15-minute validity window.
  // Distinct from editMessage above: editMessage edits a normal channel
  // message by ID using bot-token auth against a guild channel (and
  // requires the bot to actually be present there); this instead
  // authenticates with the interaction token itself and always works
  // regardless of bot guild presence, but only for that interaction's own
  // original response. Used by interactions/components.ts's pod-signup:/
  // start-pod:confirm: branches to deliver the real result once background
  // work finishes, after already acking with a deferred response to stay
  // inside Discord's 3-second budget (see rest.test.ts for exact route
  // shape). applicationId is the same value as botUserId (see doc comment
  // above) — passed explicitly here rather than implied, since this method
  // is about a specific interaction's webhook, not the bot's own identity.
  editOriginalInteractionResponse(
    applicationId: string,
    interactionToken: string,
    body: RESTPatchAPIWebhookWithTokenMessageJSONBody
  ): Promise<RESTPatchAPIWebhookWithTokenMessageResult>
}

export { HttpDiscordRest }

// Pure REST client — no gateway connection. Used for anything the
// interaction response itself can't do inline, e.g. editing a message in a
// *different* guild than the one that triggered the interaction (needed for
// the cross-guild shared-counter sync in INTEGRATIONS.md §7.5 step 3).
export function createDiscordRest(botToken: string, botUserId: string): DiscordRestClient {
  return new HttpDiscordRest(new REST({ version: '10' }).setToken(botToken), botUserId)
}
