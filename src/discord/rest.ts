import { REST, type RequestData, type RouteLike } from '@discordjs/rest'
import {
  Routes,
  type RESTPostAPIChannelMessageJSONBody,
  type RESTPostAPIChannelMessageResult,
  type RESTPatchAPIChannelMessageJSONBody,
  type RESTPatchAPIChannelMessageResult,
  type RESTGetAPIGuildResult,
  type RESTPostAPIGuildChannelJSONBody,
  type RESTPostAPIGuildChannelResult,
  type RESTPostAPIChannelInviteResult,
  type RESTPostAPICurrentUserCreateDMChannelResult,
} from 'discord-api-types/v10'

// The contract the app depends on for talking to Discord — scoped to the
// operations we actually perform, with real response types (no
// `unknown`). See testUtils/fakeDiscordRest.ts.
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
}

// The raw @discordjs/rest surface HttpDiscordRest wraps. A real REST
// instance satisfies this structurally; tests can inject a plain stub
// instead of spinning up a real REST client.
interface RawRestClient {
  get(fullRoute: RouteLike, options?: RequestData): Promise<unknown>
  post(fullRoute: RouteLike, options?: RequestData): Promise<unknown>
  patch(fullRoute: RouteLike, options?: RequestData): Promise<unknown>
  delete(fullRoute: RouteLike, options?: RequestData): Promise<unknown>
}

// The only place `unknown` gets cast away — every other consumer works
// with DiscordRestClient's real response types directly.
export class HttpDiscordRest implements DiscordRestClient {
  #raw: RawRestClient
  readonly botUserId: string

  constructor(raw: RawRestClient, botUserId: string) {
    this.#raw = raw
    this.botUserId = botUserId
  }

  async postMessage(
    channelId: string,
    body: RESTPostAPIChannelMessageJSONBody
  ): Promise<RESTPostAPIChannelMessageResult> {
    return this.#raw.post(Routes.channelMessages(channelId), { body }) as Promise<RESTPostAPIChannelMessageResult>
  }

  async editMessage(
    channelId: string,
    messageId: string,
    body: RESTPatchAPIChannelMessageJSONBody
  ): Promise<RESTPatchAPIChannelMessageResult> {
    return this.#raw.patch(Routes.channelMessage(channelId, messageId), {
      body,
    }) as Promise<RESTPatchAPIChannelMessageResult>
  }

  async getGuild(guildId: string): Promise<RESTGetAPIGuildResult> {
    return this.#raw.get(Routes.guild(guildId)) as Promise<RESTGetAPIGuildResult>
  }

  async createChannel(
    guildId: string,
    body: RESTPostAPIGuildChannelJSONBody
  ): Promise<RESTPostAPIGuildChannelResult> {
    return this.#raw.post(Routes.guildChannels(guildId), { body }) as Promise<RESTPostAPIGuildChannelResult>
  }

  async createInvite(channelId: string): Promise<RESTPostAPIChannelInviteResult> {
    return this.#raw.post(Routes.channelInvites(channelId), {
      body: { max_age: 21600 },
    }) as Promise<RESTPostAPIChannelInviteResult>
  }

  async createDmChannel(userId: string): Promise<RESTPostAPICurrentUserCreateDMChannelResult> {
    return this.#raw.post(Routes.userChannels(), {
      body: { recipient_id: userId },
    }) as Promise<RESTPostAPICurrentUserCreateDMChannelResult>
  }

  async deleteChannel(channelId: string): Promise<void> {
    await this.#raw.delete(Routes.channel(channelId))
  }
}

// Pure REST client — no gateway connection. Used for anything the
// interaction response itself can't do inline, e.g. editing a message in a
// *different* guild than the one that triggered the interaction (needed for
// the cross-guild shared-counter sync in INTEGRATIONS.md §7.5 step 3).
export function createDiscordRest(botToken: string, botUserId: string): DiscordRestClient {
  return new HttpDiscordRest(new REST({ version: '10' }).setToken(botToken), botUserId)
}
