// Thin client for the backend service, which owns all durable state
// (Organizer, GuildSubscription, PodRound, ... — see INTEGRATIONS.md §7.3)
// and the PTP integration (§4.1, §8). This bot repo is deliberately kept
// dumb: verify the request, figure out *what* is being asked, forward it.

export interface BackendClientConfig {
  baseUrl: string
  apiKey: string
}

export class BackendClient {
  constructor(private readonly config: BackendClientConfig) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        ...init.headers,
      },
    })

    if (!response.ok) {
      throw new Error(`Backend request failed: ${response.status} ${await response.text()}`)
    }

    return (await response.json()) as T
  }

  // TODO(§8.2): submit a pasted PTP token for validation + storage.
  linkOrganizer(discordId: string, token: string): Promise<{ username: string }> {
    return this.request('/organizers/link', {
      method: 'POST',
      body: JSON.stringify({ discordId, token }),
    })
  }

  // TODO(§7.2): register/update a guild's broadcast subscription.
  subscribeGuild(guildId: string, channelId: string, installedBy: string): Promise<void> {
    return this.request('/guilds/subscribe', {
      method: 'POST',
      body: JSON.stringify({ guildId, channelId, installedBy }),
    })
  }

  // TODO(§7.2): allow-list an organizer for a guild with `allowlist` policy.
  allowOrganizer(guildId: string, organizerDiscordId: string, approvedBy: string): Promise<void> {
    return this.request('/guilds/allow-organizer', {
      method: 'POST',
      body: JSON.stringify({ guildId, organizerDiscordId, approvedBy }),
    })
  }

  // TODO(§7.5): start a round; backend returns eligible target guilds.
  listEligibleGuilds(organizerDiscordId: string): Promise<Array<{ guildId: string; name: string }>> {
    return this.request(`/organizers/${organizerDiscordId}/eligible-guilds`)
  }

  // TODO(§7.5): create the round + fan out; backend owns PodRoundTarget rows.
  startPod(params: {
    organizerDiscordId: string
    setCode: string
    threshold: number
    guildIds: string[]
  }): Promise<{ podRoundId: string }> {
    return this.request('/pods/start', { method: 'POST', body: JSON.stringify(params) })
  }

  // TODO(§7.5 step 3): record a signup, backend returns the updated shared count.
  recordSignup(
    podRoundId: string,
    discordId: string,
    username: string,
    sourceGuildId: string
  ): Promise<{ count: number; threshold: number; thresholdReached: boolean }> {
    return this.request(`/pods/${podRoundId}/signup`, {
      method: 'POST',
      body: JSON.stringify({ discordId, username, sourceGuildId }),
    })
  }

  // TODO(§7.5 step 5): cancel a round.
  cancelPod(podRoundId: string, requestedBy: string): Promise<void> {
    return this.request(`/pods/${podRoundId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ requestedBy }),
    })
  }
}
