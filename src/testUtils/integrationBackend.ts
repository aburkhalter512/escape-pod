import type { PrismaClient } from '@prisma/client'
import { LocalBackendClient, type BackendClient } from '../backendClient.js'
import type { PodServiceDeps } from '../services/pods.js'
import type { PtpClient } from '../ptp/client.js'
import type { Logger } from '../services/errors.js'
import { createFakePtpClient } from './fakePtpClient.js'

export const INTEGRATION_TOKEN_KEY = '33'.repeat(32)

export const NO_LOGGER: Logger = { error: () => undefined }

// The one legitimate seam integration tests are allowed to build test data
// and observe outcomes through: LocalBackendClient is the exact class
// commands/* and interactions/* call in production (see backendClient.ts's
// own doc comment — "commands/* and interactions/* only depend on the
// BackendClient interface"), wired here to a real Prisma client instead of
// a fake one. Tests should never import services/*.ts directly or call
// `prisma.<model>.*` themselves to set up fixtures or assert on outcomes —
// prisma is only ever handed to this constructor (or to
// createIntegrationPodServiceDeps below) as a wiring dependency, the same
// way server.ts wires it, never queried directly from test code.
//
// Defaults validateToken to always-succeed, since nearly every scenario
// needs an organizer linked before anything else is possible (PodRound.
// organizerDiscordId is a required FK to Organizer) and "PTP accepts this
// token" isn't usually what a given test is about; override createPod (or
// validateToken, to test the rejected-token path) per test as needed. Pass
// a pre-built PtpClient (rather than overrides) when a test also needs the
// exact same instance for a job-wrapper call (see
// createIntegrationPodServiceDeps) — e.g. a retry test where the same
// stateful createPod stub must be shared between the signup that first
// attempts the fire and the later retry sweep.
export function createIntegrationBackend(
  prisma: PrismaClient,
  ptp: PtpClient = createFakePtpClient({ validateToken: async () => true })
): BackendClient {
  return new LocalBackendClient({ prisma, ptp, tokenEncryptionKey: INTEGRATION_TOKEN_KEY, logger: NO_LOGGER })
}

// The periodic sweeps (jobs/expirePodRounds.ts, jobs/retryFailedFires.ts)
// aren't slash commands — server.ts calls them directly on a timer, not
// through BackendClient — so this is their equivalent real dependency
// shape, for tests that need to trigger a deadline/retry sweep the same
// way production does. Pass the same `ptp` instance already given to
// createIntegrationBackend when a test needs call-count assertions to
// span both an initial signup-triggered fire and a later sweep call.
export function createIntegrationPodServiceDeps(prisma: PrismaClient, ptp: PtpClient): PodServiceDeps {
  return { prisma, ptp, tokenEncryptionKey: INTEGRATION_TOKEN_KEY, logger: NO_LOGGER }
}

// Matches services/organizers.test.ts's own local fakeJwt — duplicated
// rather than shared from a *.test.ts file. decodeJwtPayloadUnverified
// (util/jwt.ts) only cares about the payload segment's shape, not a real
// signature, so this is enough to drive backend.linkOrganizer end to end.
export function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.sig`
}

export function futureExpiry(): number {
  return Math.floor(Date.now() / 1000) + 3600
}

// Links an organizer via the real backend.linkOrganizer path (PTP token
// validation + JWT decode + encrypted storage) rather than inserting an
// Organizer row directly — every pod-round scenario needs one of these
// before startPod can succeed (PodRound.organizerDiscordId is a required
// FK), and this is how a real /connect-ptp submission does it.
export async function linkFakeOrganizer(backend: BackendClient, discordId: string, username: string): Promise<void> {
  const result = await backend.linkOrganizer(discordId, fakeJwt({ discord_id: discordId, username, exp: futureExpiry() }))
  if (!result.ok) {
    throw new Error(`linkFakeOrganizer failed unexpectedly: ${result.error.message}`)
  }
}
