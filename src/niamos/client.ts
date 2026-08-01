// Niamos integration — replaces src/ptp/client.ts (PTP, dropped entirely
// per the hard-cutover migration plan). Every call here is grounded in
// the bot API surface confirmed directly with Niamos's author: flat JSON
// responses (no {success, data, message} envelope like PTP used),
// opaque `nms_`-prefixed bearer tokens (not JWTs — nothing to decode
// client-side), and tokens that never expire (no refresh endpoint
// exists or is needed).

export interface NiamosClientConfig {
  // Hosts the bot API (/api/bot/whoami, /api/bot/drafts).
  apiBaseUrl: string
  // Hosts the public site drafts are joined through — a different
  // domain than apiBaseUrl (niamos.net vs. niamos-backend.onrender.com),
  // unlike PTP where one baseUrl served both purposes.
  shareBaseUrl: string
  // Injected rather than referencing the global fetch directly inside
  // HttpNiamosClient's methods — per PR review, foundational IO
  // functions (fetch, file I/O, etc.) should be defined once at the
  // application's entry point and passed down, not referenced ad hoc
  // wherever needed. Same pattern as discord/restWorkers.ts's
  // createFetchDiscordRest. durableObject.ts (the one real caller)
  // passes the ambient global `fetch` explicitly; tests can inject a
  // stub function directly here instead of monkey-patching
  // globalThis.fetch.
  fetch: typeof fetch
}

export interface WhoamiResult {
  displayName: string
}

export interface CreateDraftParams {
  setName: string
  numSeats: number
  // Always false for this bot's calls — the token-holder (a guild's
  // linked Niamos account) never occupies one of the numSeats slots.
  // This is the capability the whole migration exists for; see
  // services/pods.ts's attemptPodCreation, the one real caller.
  seatCreator: boolean
}

export interface CreateDraftResult {
  uuid: string
  shareUrl: string
}

// The contract services/pods.ts and services/niamosTokens.ts depend on.
// Real calls happen in HttpNiamosClient below; tests get a hand-written
// stub via testUtils/fakeNiamosClient.ts that fully satisfies this
// interface, with no `as unknown as` needed.
export interface NiamosClient {
  // Validates a token at link time (services/niamosTokens.ts) and
  // supplies a display name for the confirmation message — replaces
  // PTP's client-side JWT-decoded username, since Niamos tokens are
  // opaque. Returns null for any invalid/revoked/malformed-response
  // token rather than throwing; callers turn that into a validation
  // error, mirroring PtpClient.validateToken's boolean-not-throw
  // contract.
  whoami(token: string): Promise<WhoamiResult | null>
  createDraft(token: string, params: CreateDraftParams): Promise<CreateDraftResult>
}

export class HttpNiamosClient implements NiamosClient {
  constructor(private readonly config: NiamosClientConfig) {}

  async whoami(token: string): Promise<WhoamiResult | null> {
    const response = await this.config.fetch(`${this.config.apiBaseUrl}/api/bot/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
      // Confirmed shape for a rejected token: 401 {detail: "Invalid or
      // revoked token"} — logging the real status/body here is the only
      // way to tell "token genuinely invalid" apart from "Niamos's
      // endpoint rejected the request for an unrelated reason" from
      // `wrangler tail`, since callers only ever see null back.
      console.error(`Niamos whoami rejected: ${response.status} ${await response.text()}`)
      return null
    }

    const body = (await response.json()) as Partial<{ displayName: string; playerUuid: string; valid: boolean }>
    if (body.valid !== true || typeof body.displayName !== 'string') {
      return null
    }
    return { displayName: body.displayName }
  }

  // The capability the whole migration exists to call — confirmed live
  // against a real Niamos token: POST /api/bot/drafts with
  // {numSeats, setName, seatCreator: false} returns
  // {draft: {id, uuid, status, setName, createdAt, ...}, seats: []}.
  async createDraft(token: string, params: CreateDraftParams): Promise<CreateDraftResult> {
    const response = await this.config.fetch(`${this.config.apiBaseUrl}/api/bot/drafts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        setName: params.setName,
        numSeats: params.numSeats,
        seatCreator: params.seatCreator,
      }),
    })

    if (!response.ok) {
      throw new Error(`Niamos draft creation failed: ${response.status} ${await response.text()}`)
    }

    const rawBody = await response.text()
    const body = JSON.parse(rawBody) as Partial<{ draft: Partial<{ uuid: string }> }>

    if (typeof body.draft?.uuid !== 'string' || body.draft.uuid.length === 0) {
      throw new Error(`Niamos draft creation response missing a usable draft.uuid: ${rawBody}`)
    }

    // Niamos's response has no shareUrl field at all (unlike PTP, which
    // sent one anyway despite it needing to be derived) — the share URL
    // is always built from shareBaseUrl + the draft's uuid, confirmed
    // directly by Niamos's author.
    return {
      uuid: body.draft.uuid,
      shareUrl: `${this.config.shareBaseUrl}/drafts/${body.draft.uuid}`,
    }
  }
}
