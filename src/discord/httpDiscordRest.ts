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
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageResult,
} from 'discord-api-types/v10'
import type { RequestData, RouteLike } from '@discordjs/rest'
import type { DiscordRestClient } from './rest.js'

// The DiscordRestClient logic (route/body shapes, response typing) shared
// by both platforms — split out of rest.ts specifically so
// discord/restWorkers.ts (Workers) can reuse this class without pulling
// @discordjs/rest's actual runtime into the Workers bundle. The
// RequestData/RouteLike imports above are type-only (erased at compile
// time), so importing this file never bundles @discordjs/rest itself;
// only rest.ts's createDiscordRest (a real `import { REST } from
// '@discordjs/rest'`) does that, and only the AWS side ever imports
// createDiscordRest.
export interface RawRestClient {
  get(fullRoute: RouteLike, options?: RequestData): Promise<unknown>
  post(fullRoute: RouteLike, options?: RequestData): Promise<unknown>
  patch(fullRoute: RouteLike, options?: RequestData): Promise<unknown>
  delete(fullRoute: RouteLike, options?: RequestData): Promise<unknown>
}

// The only place `unknown` gets cast away — every other consumer works
// with DiscordRestClient's real response types directly. rest.ts's
// createDiscordRest constructs this with a real @discordjs/rest REST
// instance; restWorkers.ts's createFetchDiscordRest constructs it with a
// plain-fetch-based RawRestClient instead — same class, same route/body
// logic, different transport underneath.
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

  async editOriginalInteractionResponse(
    applicationId: string,
    interactionToken: string,
    body: RESTPatchAPIWebhookWithTokenMessageJSONBody
  ): Promise<RESTPatchAPIWebhookWithTokenMessageResult> {
    return this.#raw.patch(Routes.webhookMessage(applicationId, interactionToken, '@original'), {
      body,
    }) as Promise<RESTPatchAPIWebhookWithTokenMessageResult>
  }
}
