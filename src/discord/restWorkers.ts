import { HttpDiscordRest, type RawRestClient } from './httpDiscordRest.js'
import type { DiscordRestClient } from './rest.js'

// The Worker-side counterpart to rest.ts's createDiscordRest — same
// HttpDiscordRest class (route/body shapes, response typing, shared via
// httpDiscordRest.ts), just a different RawRestClient transport
// underneath: hand-rolled plain fetch() instead of @discordjs/rest,
// which isn't clean on Workers (undici/Node-compat friction; Discord's
// own Workers tutorial hand-rolls fetch() for the same reason, see the
// migration plan's Phase 5 research).
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
  return new HttpDiscordRest(createFetchRawRestClient(options.botToken), options.botUserId)
}

function createFetchRawRestClient(botToken: string): RawRestClient {
  async function request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', fullRoute: string, options?: { body?: unknown }) {
    const response = await fetch(`${DISCORD_API_BASE}${fullRoute}`, {
      method,
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    })

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Discord API ${method} ${fullRoute} failed: ${response.status} ${detail}`)
    }

    // DELETE responses have no body (204 No Content) — every other route
    // HttpDiscordRest calls always returns a real JSON payload.
    if (response.status === 204) {
      return undefined
    }
    return response.json()
  }

  return {
    get: (fullRoute, options) => request('GET', fullRoute, options),
    post: (fullRoute, options) => request('POST', fullRoute, options),
    patch: (fullRoute, options) => request('PATCH', fullRoute, options),
    delete: (fullRoute, options) => request('DELETE', fullRoute, options),
  }
}
