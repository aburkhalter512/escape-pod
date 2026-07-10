// Protect the Pod integration. Every call here is grounded in a specific
// route read directly from github.com/ledwards/swupod — see
// INTEGRATIONS.md §4.1.1, §8.2, §8.3 for the reasoning and caveats behind
// each one.

export interface PtpClientConfig {
  baseUrl: string
}

export interface CreatePodParams {
  setCode: string
  maxPlayers: number
}

export interface CreatePodResult {
  id: string
  shareId: string
  shareUrl: string
  createdAt: string
}

// The contract routes/jobs depend on. Real calls happen in HttpPtpClient
// below; tests get a hand-written stub via testUtils/fakePtpClient.ts that
// fully satisfies this interface, with no `as unknown as` needed — see the
// "manual test fixtures over a mocking library" discussion this replaces.
export interface PtpClient {
  validateToken(token: string): Promise<boolean>
  createPod(token: string, params: CreatePodParams): Promise<CreatePodResult>
  refreshToken(currentToken: string): Promise<string | null>
}

export class HttpPtpClient implements PtpClient {
  constructor(private readonly config: PtpClientConfig) {}

  // §8.2 check (d) — the live validation call at link time. Read-only,
  // low-stakes, requireAuth()-gated route that happens to exist for
  // listing a user's own drafts.
  async validateToken(token: string): Promise<boolean> {
    const response = await fetch(`${this.config.baseUrl}/api/me/drafts?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
      // The only signal callers get back is `false` (organizersService
      // turns that into a generic "PTP rejected this token" for the
      // user) — logging PTP's real status/body here is the only way to
      // tell "token genuinely invalid" apart from "PTP's endpoint/WAF
      // rejected the request for an unrelated reason" from CloudWatch.
      console.error(`PTP validateToken rejected: ${response.status} ${await response.text()}`)
    }
    return response.ok
  }

  // §4.1.1 — the capability the whole system exists to call. Requires a
  // real user JWT (requireAuth()), which is exactly what the organizer's
  // linked Option B token is.
  async createPod(token: string, params: CreatePodParams): Promise<CreatePodResult> {
    const response = await fetch(`${this.config.baseUrl}/api/draft`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        setCode: params.setCode,
        maxPlayers: params.maxPlayers,
        isPublic: true,
      }),
    })

    if (!response.ok) {
      throw new Error(`PTP pod creation failed: ${response.status} ${await response.text()}`)
    }

    return (await response.json()) as CreatePodResult
  }

  // §8.3 — NOT a documented Bearer-token-refresh contract. This route is
  // named/shaped as session-cookie refresh; we're reusing it because
  // getSession() accepts a Bearer token same as everywhere else, and the
  // fresh JWT it mints is readable off the Set-Cookie response header.
  // Treat this as "works today per the current code," not a guarantee.
  async refreshToken(currentToken: string): Promise<string | null> {
    const response = await fetch(`${this.config.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${currentToken}` },
    })

    if (!response.ok) return null

    const setCookie = response.headers.get('set-cookie')
    if (!setCookie) return null

    const match = /swupod_session=([^;]+)/.exec(setCookie)
    return match ? decodeURIComponent(match[1]) : null
  }
}
