// Thin client for the backend service, which owns all durable state
// (Organizer, GuildSubscription, PodRound, ... — see INTEGRATIONS.md §7.3)
// and the PTP integration (§4.1, §8). This bot repo is deliberately kept
// dumb: verify the request, figure out *what* is being asked, forward it.

export interface BackendClientConfig {
  baseUrl: string
  apiKey: string
}

// The contract commands/handlers depend on. Real calls happen in
// HttpBackendClient below; tests get a hand-written stub via
// testUtils/fakeBackendClient.ts that fully satisfies this interface, no
// `as unknown as` needed.
export interface BackendClient {
  linkOrganizer(discordId: string, token: string): Promise<{ username: string }>
  subscribeGuild(guildId: string, channelId: string, installedBy: string): Promise<void>
  allowOrganizer(guildId: string, organizerDiscordId: string, approvedBy: string): Promise<void>
  listEligibleGuilds(organizerDiscordId: string): Promise<Array<{ guildId: string; name: string }>>
  startPod(params: {
    organizerDiscordId: string
    setCode: string
    threshold: number
    guildIds: string[]
  }): Promise<{ podRoundId: string; targets: Array<{ guildId: string; channelId: string }> }>
  recordMessagePosted(podRoundId: string, guildId: string, messageId: string): Promise<void>
  recordSignup(
    podRoundId: string,
    discordId: string,
    username: string,
    sourceGuildId: string
  ): Promise<{
    count: number
    threshold: number
    setCode: string
    thresholdReached: boolean
    podCreated: boolean
    shareUrl?: string
    targets: Array<{ guildId: string; channelId: string; messageId: string | null }>
  }>
  cancelPod(podRoundId: string, requestedBy: string): Promise<void>
}

export class HttpBackendClient implements BackendClient {
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

  // §8.2: submit a pasted PTP token for validation + storage.
  linkOrganizer(discordId: string, token: string): Promise<{ username: string }> {
    return this.request('/organizers/link', {
      method: 'POST',
      body: JSON.stringify({ discordId, token }),
    })
  }

  // §7.2: register/update a guild's broadcast subscription.
  subscribeGuild(guildId: string, channelId: string, installedBy: string): Promise<void> {
    return this.request('/guilds/subscribe', {
      method: 'POST',
      body: JSON.stringify({ guildId, channelId, installedBy }),
    })
  }

  // §7.2: allow-list an organizer for a guild with `allowlist` policy.
  allowOrganizer(guildId: string, organizerDiscordId: string, approvedBy: string): Promise<void> {
    return this.request('/guilds/allow-organizer', {
      method: 'POST',
      body: JSON.stringify({ guildId, organizerDiscordId, approvedBy }),
    })
  }

  // §7.5: start a round; backend returns eligible target guilds.
  listEligibleGuilds(organizerDiscordId: string): Promise<Array<{ guildId: string; name: string }>> {
    return this.request(`/organizers/${organizerDiscordId}/eligible-guilds`)
  }

  // §7.5 steps 1-2: creates the round + PodRoundTarget rows. Returns each
  // target's resolved channel so the caller can actually post there.
  startPod(params: {
    organizerDiscordId: string
    setCode: string
    threshold: number
    guildIds: string[]
  }): Promise<{ podRoundId: string; targets: Array<{ guildId: string; channelId: string }> }> {
    return this.request('/pods/start', { method: 'POST', body: JSON.stringify(params) })
  }

  // §7.5 step 2: persists the Discord message ID for one target guild once
  // it's been posted, so a later signup's fan-out (step 3) knows what to edit.
  recordMessagePosted(podRoundId: string, guildId: string, messageId: string): Promise<void> {
    return this.request(`/pods/${podRoundId}/targets/${guildId}/message`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    })
  }

  // §7.5 step 4: record a signup; backend returns the updated shared count,
  // whether the pod was just created, and every target (for the caller to
  // fan the update out to guilds other than the one this signup came from).
  recordSignup(
    podRoundId: string,
    discordId: string,
    username: string,
    sourceGuildId: string
  ): Promise<{
    count: number
    threshold: number
    setCode: string
    thresholdReached: boolean
    podCreated: boolean
    shareUrl?: string
    targets: Array<{ guildId: string; channelId: string; messageId: string | null }>
  }> {
    return this.request(`/pods/${podRoundId}/signup`, {
      method: 'POST',
      body: JSON.stringify({ discordId, username, sourceGuildId }),
    })
  }

  // §7.5 step 5: cancel a round.
  cancelPod(podRoundId: string, requestedBy: string): Promise<void> {
    return this.request(`/pods/${podRoundId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ requestedBy }),
    })
  }
}
