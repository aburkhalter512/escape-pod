import { describe, expect, it } from 'vitest'
import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { ComponentType, InteractionResponseType } from 'discord-api-types/v10'
import type { EscapePodDurableObject, Env } from './durableObject.js'
import { POD_CAPACITY } from './podConfig.js'
import { encryptToken } from './crypto/tokenCrypto.js'
import { fakeMember, fakeMessageComponentInteraction, fakeUser } from './testUtils/fakeInteraction.js'

declare module 'cloudflare:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}

// The load-bearing go/no-go gate for the whole DO-based architecture bet
// (see the migration plan's Phase 4). appSqlStorage.workers.test.ts
// (Phase 1) already proves the SQL itself is correct against a real DO;
// this file proves something different and load-bearing in its own
// right — that real, genuinely concurrent HTTP requests dispatched
// through the actual production path (worker.ts's stub.fetch(request) ->
// durableObject.ts's fetch() -> honoApp.ts's Hono app -> routeInteraction
// -> services/pods.ts) never see a torn/racy result, because Cloudflare
// serializes all requests to one DO instance. Driven via SELF.fetch(),
// not runInDurableObject or direct service calls — see worker.workers.
// test.ts for why direct in-process calls wouldn't actually exercise this
// (JS is single-threaded regardless of transport; the property under
// test is specifically about the platform's real request queuing).
//
// pod-signup:/start-pod:confirm: both defer their real work (see
// components.ts) and return immediately with a DeferredMessageUpdate —
// router.ts has no hook to await that background work externally (by
// design; it's fire-and-forget in production too, matching a real
// Discord webhook's 3-second budget). So this polls on observable
// side effects (a stubbed Niamos call counter, and the DO's own persisted
// storage state) with a bounded timeout, rather than trying to await
// anything directly.

const DO_NAME = 'global' // matches worker.ts's getGlobalStub exactly

// Generated once, hardcoded — the private half of the fixed keypair whose
// public half is baked into vitest.workers.config.ts's DISCORD_PUBLIC_KEY
// binding. Not regenerated per run: the public half is a static config
// value, so the private half signing test requests has to match it.
const PRIVATE_KEY_PKCS8_B64 = 'MC4CAQAwBQYDK2VwBCIEIEMmk/xvpeB9B99c6of29Vj+I7jdXtUjNJPfByY9D6Ix'

async function importPrivateKey(): Promise<CryptoKey> {
  const der = Uint8Array.from(atob(PRIVATE_KEY_PKCS8_B64), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign'])
}

async function sign(privateKey: CryptoKey, timestamp: string, body: string): Promise<string> {
  const message = new TextEncoder().encode(timestamp + body)
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message)
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function signedInteractionsRequest(privateKey: CryptoKey, bodyObj: unknown): Promise<Request> {
  const body = JSON.stringify(bodyObj)
  const timestamp = '1700000000'
  const signature = await sign(privateKey, timestamp, body)
  return new Request('https://example.com/interactions', {
    method: 'POST',
    headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp, 'content-type': 'application/json' },
    body,
  })
}

function getGlobalStub() {
  const id = env.ESCAPE_POD_DO.idFromName(DO_NAME)
  return env.ESCAPE_POD_DO.get(id)
}

// Every outbound fetch() this test's requests trigger (Discord REST via
// restWorkers.ts, Niamos via niamos/client.ts's HttpNiamosClient) gets
// intercepted here — nothing makes a real network call. Matches by URL
// substring rather than modeling every route precisely, since correctness
// of the Discord/Niamos REST clients themselves is restWorkers.test.ts's/
// niamos/client.test.ts's job, not this file's.
function stubGlobalFetch(options: { createDraftDelayMs?: number } = {}) {
  const original = globalThis.fetch
  const createDraftCalls: unknown[] = []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'

    if (url.includes('/api/bot/drafts') && method === 'POST') {
      createDraftCalls.push(init?.body)
      if (options.createDraftDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.createDraftDelayMs))
      }
      return new Response(
        JSON.stringify({ draft: { id: 1, uuid: 'draft-1', status: 'pending', createdAt: new Date().toISOString() }, seats: [] }),
        { status: 200 }
      )
    }
    if (url.includes('/guilds/') && method === 'GET') {
      return new Response(JSON.stringify({ id: 'guild-x', name: 'Test Guild' }), { status: 200 })
    }
    if (method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    // Every other Discord REST call this background work might make
    // (postMessage, editMessage, editOriginalInteractionResponse,
    // createChannel, createInvite, createDmChannel) — a generic success
    // body is enough; none of these tests assert on their content.
    return new Response(JSON.stringify({ id: 'generic-ok' }), { status: 200 })
  }) as typeof fetch

  return {
    createDraftCalls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs = 4000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  if (!(await check())) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`)
}

// Creates the organizer row as a side effect (no separate linking step
// exists anymore — see organizer.incrementNextRoundNumber's upsert) so
// pod_rounds' FK to organizers(discord_id) is satisfiable for tests that
// seed a round directly; increment: 0 is a test-only seeding trick, real
// callers always increment by 1. The username param is now unused (the
// old organizer row carried it, the new one doesn't) but kept so call
// sites reads the same as before.
async function seedOrganizer(discordId: string, _username: string): Promise<void> {
  const stub = getGlobalStub()
  await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
    await instance.appStorage.organizer.incrementNextRoundNumber({
      where: { discordId },
      data: { increment: 0 },
    })
  })
}

async function seedGuildSubscription(guildId: string, installedBy: string): Promise<void> {
  const stub = getGlobalStub()
  await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
    await instance.appStorage.guildSubscription.createSubscription({
      data: { guildId, broadcastChannelId: `channel-${guildId}`, installedByDiscordId: installedBy },
    })
  })
}

// Firing a round now resolves its Niamos token via originGuildId, not the
// organizer — every guild a test's round(s) fire from needs one linked.
async function seedGuildNiamosToken(guildId: string): Promise<void> {
  const stub = getGlobalStub()
  await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
    await instance.appStorage.guildNiamosToken.linkToken({
      where: { guildId },
      create: {
        guildId,
        encryptedToken: encryptToken('fake-niamos-token', env.TOKEN_ENCRYPTION_KEY),
        linkedByDiscordId: 'admin-1',
        displayName: 'Niamos',
      },
      update: {
        encryptedToken: encryptToken('fake-niamos-token', env.TOKEN_ENCRYPTION_KEY),
        linkedByDiscordId: 'admin-1',
        displayName: 'Niamos',
      },
    })
  })
}

async function seedCollectingRound(organizerDiscordId: string, originGuildId?: string): Promise<string> {
  const stub = getGlobalStub()
  return runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
    const round = await instance.appStorage.podRound.createRoundWithTargets({
      data: {
        organizerDiscordId,
        organizerRoundNumber: 1,
        setCode: 'JTL',
        threshold: POD_CAPACITY,
        originGuildId,
        targets: { create: [] },
      },
    })
    return round.id
  })
}

describe('signing up under real concurrent requests (Phase 4 go/no-go gate)', () => {
  it('fires the round exactly once even when many signups race past POD_CAPACITY simultaneously', async () => {
    const privateKey = await importPrivateKey()
    // Widens the race window so concurrent callers are still mid-flight
    // through fireRound's claim at the same moment — same technique as
    // podConcurrency.integration.test.ts's real-Postgres version.
    const { createDraftCalls, restore } = stubGlobalFetch({ createDraftDelayMs: 25 })

    try {
      await seedOrganizer('organizer-1', 'OrganizerOne')
      await seedGuildNiamosToken('guild-1')
      const podRoundId = await seedCollectingRound('organizer-1', 'guild-1')

      const signupCount = POD_CAPACITY + 4
      const responses = await Promise.all(
        Array.from({ length: signupCount }, async (_, i) => {
          const interaction = fakeMessageComponentInteraction({
            guild_id: 'guild-1',
            data: { custom_id: `pod-signup:${podRoundId}:in`, component_type: ComponentType.Button },
            member: fakeMember({ user: fakeUser({ id: `player-${i}`, username: `Player${i}` }) }),
          })
          const response = await SELF.fetch(await signedInteractionsRequest(privateKey, interaction))
          const body = (await response.json()) as { type: number }
          return { status: response.status, body }
        })
      )

      // Every concurrent signup gets a real deferred ack, not a 401/500 —
      // proves every one of these concurrent requests actually reached
      // and was accepted by routeInteraction, not just N-1 of them.
      for (const { status, body } of responses) {
        expect(status).toBe(200)
        expect(body.type).toBe(InteractionResponseType.DeferredMessageUpdate)
      }

      const stub = getGlobalStub()
      async function countRecordedSignups(): Promise<number> {
        return runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
          const signups = await instance.appStorage.podRoundSignup.findSignedUp(podRoundId)
          return signups.length
        })
      }

      // The real proof: exactly one of these concurrent requests' detached
      // background work won the compare-and-swap and actually created the
      // Niamos draft, no matter how many raced past POD_CAPACITY at once.
      await waitUntil(() => createDraftCalls.length >= 1)
      // Give any (incorrect) second winner, and any still-settling
      // requests behind it, a little longer to show up before asserting —
      // a flaky "happened to only fire once" isn't the same as a proven
      // exactly-once guarantee.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(createDraftCalls).toHaveLength(1)

      // NOT asserting all signupCount signups landed — unlike
      // podConcurrency.integration.test.ts's real-Postgres version, this
      // is a genuine, discovered platform difference, not a test bug: a
      // DO instance serializes requests via fast, non-yielding local
      // SQLite calls with no real per-request I/O latency in between, so
      // one request's entire recordSignup call (including fireRound's
      // claim) can fully resolve before the next one even starts —
      // unlike real, separate Postgres connections, which each pay a
      // network round-trip that lets several near-simultaneous callers'
      // *reads* land before any of their writes do. So a signup that
      // starts processing after the round has already flipped past
      // COLLECTING correctly gets rejected server-side (see
      // services/pods.ts's recordSignup — "Bail out before the upsert/
      // count so a resolved round is never touched by a late signup at
      // all", a deliberate, pre-existing rule on both platforms) — it's
      // just far more likely to actually happen under the DO's
      // effectively-serialized timing than under Postgres's genuinely
      // concurrent one. The safety invariant that actually matters here
      // — createPod is never called more than once — holds regardless,
      // proven above; this only checks the accepted count landed
      // somewhere sane (at least a full table, never more than attempted).
      const finalCount = await countRecordedSignups()
      expect(finalCount).toBeGreaterThanOrEqual(POD_CAPACITY)
      expect(finalCount).toBeLessThanOrEqual(signupCount)

      await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
        const round = await instance.appStorage.podRound.findRoundById(podRoundId)
        expect(round?.status).toBe('POD_CREATED')
      })
    } finally {
      restore()
    }
  })
})

describe('per-organizer round numbering under real concurrent requests (Phase 4 go/no-go gate)', () => {
  function selectGuildsInteraction(organizerDiscordId: string, username: string) {
    return fakeMessageComponentInteraction({
      guild_id: 'guild-1',
      data: {
        custom_id: 'start-pod:select-guilds:JTL:8:',
        component_type: ComponentType.StringSelect,
        values: ['guild-1'],
      },
      member: fakeMember({ user: fakeUser({ id: organizerDiscordId, username }) }),
    })
  }

  // start-pod:select-guilds: only stores a pending selection (in the DO's
  // in-memory pendingStartPods store) and hands back a confirm button's
  // token — the real backend.startPod call (the thing under test) only
  // happens once start-pod:confirm: is clicked, so this has to run once
  // per token needed before the real concurrent part below.
  async function createPendingToken(privateKey: CryptoKey, organizerDiscordId: string, username: string): Promise<string> {
    const response = await SELF.fetch(
      await signedInteractionsRequest(privateKey, selectGuildsInteraction(organizerDiscordId, username))
    )
    const body = (await response.json()) as { data?: { components?: Array<{ components?: Array<{ custom_id?: string }> }> } }
    const customId = body.data?.components?.[0]?.components?.[0]?.custom_id
    if (!customId?.startsWith('start-pod:confirm:')) {
      throw new Error(`expected a start-pod:confirm: button, got: ${JSON.stringify(body)}`)
    }
    return customId
  }

  async function confirmToken(privateKey: CryptoKey, organizerDiscordId: string, customId: string): Promise<void> {
    const interaction = fakeMessageComponentInteraction({
      guild_id: 'guild-1',
      data: { custom_id: customId, component_type: ComponentType.Button },
      member: fakeMember({ user: fakeUser({ id: organizerDiscordId }) }),
    })
    const response = await SELF.fetch(await signedInteractionsRequest(privateKey, interaction))
    const body = (await response.json()) as { type: number }
    expect(response.status).toBe(200)
    expect(body.type).toBe(InteractionResponseType.DeferredMessageUpdate)
  }

  async function roundNumbersFor(organizerDiscordId: string): Promise<number[]> {
    const stub = getGlobalStub()
    return runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const rounds = await instance.appStorage.podRound.findActiveRoundsForOrganizer(organizerDiscordId, ['COLLECTING'])
      return rounds.map((r) => r.organizerRoundNumber)
    })
  }

  it('assigns distinct, gap-free sequential numbers even when many /start-pod calls race for the same organizer', async () => {
    const privateKey = await importPrivateKey()
    const { restore } = stubGlobalFetch()

    try {
      await seedOrganizer('organizer-1', 'OrganizerOne')
      await seedGuildSubscription('guild-1', 'organizer-1')

      const startCount = 20
      const tokens = []
      for (let i = 0; i < startCount; i++) {
        tokens.push(await createPendingToken(privateKey, 'organizer-1', 'OrganizerOne'))
      }

      await Promise.all(tokens.map((token) => confirmToken(privateKey, 'organizer-1', token)))

      await waitUntil(async () => (await roundNumbersFor('organizer-1')).length === startCount)
      const numbers = (await roundNumbersFor('organizer-1')).sort((a, b) => a - b)
      expect(new Set(numbers).size).toBe(startCount) // no duplicates
      expect(numbers).toEqual(Array.from({ length: startCount }, (_, i) => i + 1)) // exactly 1..N, no gaps
    } finally {
      restore()
    }
  })

  it("scopes numbering per organizer - two organizers racing simultaneously never see each other's numbers", async () => {
    const privateKey = await importPrivateKey()
    const { restore } = stubGlobalFetch()

    try {
      await seedOrganizer('organizer-1', 'OrganizerOne')
      await seedOrganizer('organizer-2', 'OrganizerTwo')
      await seedGuildSubscription('guild-1', 'organizer-1')

      const startCount = 10
      const tokensOne = []
      const tokensTwo = []
      for (let i = 0; i < startCount; i++) {
        tokensOne.push(await createPendingToken(privateKey, 'organizer-1', 'OrganizerOne'))
        tokensTwo.push(await createPendingToken(privateKey, 'organizer-2', 'OrganizerTwo'))
      }

      await Promise.all([
        ...tokensOne.map((token) => confirmToken(privateKey, 'organizer-1', token)),
        ...tokensTwo.map((token) => confirmToken(privateKey, 'organizer-2', token)),
      ])

      await waitUntil(async () => {
        const [one, two] = await Promise.all([roundNumbersFor('organizer-1'), roundNumbersFor('organizer-2')])
        return one.length === startCount && two.length === startCount
      })

      const expected = Array.from({ length: startCount }, (_, i) => i + 1)
      const [numbersOne, numbersTwo] = await Promise.all([roundNumbersFor('organizer-1'), roundNumbersFor('organizer-2')])
      expect(numbersOne.sort((a, b) => a - b)).toEqual(expected)
      expect(numbersTwo.sort((a, b) => a - b)).toEqual(expected)
    } finally {
      restore()
    }
  })
})
