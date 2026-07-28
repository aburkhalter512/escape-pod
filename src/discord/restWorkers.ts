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
import type { DiscordRestClient } from './rest.js'

// The Worker-side counterpart to rest.ts's HttpDiscordRest — same
// DiscordRestClient contract, hand-rolled plain fetch() instead of
// @discordjs/rest, which isn't clean on Workers (undici/Node-compat
// friction; Discord's own Workers tutorial hand-rolls fetch() for the
// same reason, see the migration plan's Phase 5 research). Routes.* is a
// pure, framework-agnostic path-string builder from discord-api-types —
// reused as-is from rest.ts, no Workers-specific replacement needed.
//
// Known, accepted gap (flagged in the migration plan, not a silent
// omission): no automatic rate-limit backoff/retry, unlike
// @discordjs/rest's built-in bucket handling. A 429 surfaces as a
// regular failed fetch to the caller. Low risk at this bot's traffic
// scale (a handful of guilds), but a real capability regression worth
// knowing about.
const DISCORD_API_BASE = 'https://discord.com/api/v10'

interface FetchDiscordRestOptions {
  botToken: string
  botUserId: string
}

export function createFetchDiscordRest(options: FetchDiscordRestOptions): DiscordRestClient {
  return new FetchDiscordRest(options.botToken, options.botUserId)
}

class FetchDiscordRest implements DiscordRestClient {
  readonly botUserId: string
  #botToken: string

  constructor(botToken: string, botUserId: string) {
    this.#botToken = botToken
    this.botUserId = botUserId
  }

  async #request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${DISCORD_API_BASE}${route}`, {
      method,
      headers: {
        Authorization: `Bot ${this.#botToken}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Discord API ${method} ${route} failed: ${response.status} ${detail}`)
    }

    // DELETE responses have no body (204 No Content) — every other method
    // here always returns a real JSON payload.
    if (response.status === 204) {
      return undefined as T
    }
    return (await response.json()) as T
  }

  async postMessage(
    channelId: string,
    body: RESTPostAPIChannelMessageJSONBody
  ): Promise<RESTPostAPIChannelMessageResult> {
    return this.#request('POST', Routes.channelMessages(channelId), body)
  }

  async editMessage(
    channelId: string,
    messageId: string,
    body: RESTPatchAPIChannelMessageJSONBody
  ): Promise<RESTPatchAPIChannelMessageResult> {
    return this.#request('PATCH', Routes.channelMessage(channelId, messageId), body)
  }

  async getGuild(guildId: string): Promise<RESTGetAPIGuildResult> {
    return this.#request('GET', Routes.guild(guildId))
  }

  async createChannel(
    guildId: string,
    body: RESTPostAPIGuildChannelJSONBody
  ): Promise<RESTPostAPIGuildChannelResult> {
    return this.#request('POST', Routes.guildChannels(guildId), body)
  }

  async createInvite(channelId: string): Promise<RESTPostAPIChannelInviteResult> {
    return this.#request('POST', Routes.channelInvites(channelId), { max_age: 21600 })
  }

  async createDmChannel(userId: string): Promise<RESTPostAPICurrentUserCreateDMChannelResult> {
    return this.#request('POST', Routes.userChannels(), { recipient_id: userId })
  }

  async deleteChannel(channelId: string): Promise<void> {
    await this.#request('DELETE', Routes.channel(channelId))
  }

  async editOriginalInteractionResponse(
    applicationId: string,
    interactionToken: string,
    body: RESTPatchAPIWebhookWithTokenMessageJSONBody
  ): Promise<RESTPatchAPIWebhookWithTokenMessageResult> {
    return this.#request('PATCH', Routes.webhookMessage(applicationId, interactionToken, '@original'), body)
  }
}
