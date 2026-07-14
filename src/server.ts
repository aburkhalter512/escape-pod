import { PrismaClient } from '@prisma/client'
import { buildApp } from './app.js'
import { createDiscordRest } from './discord/rest.js'
import { HttpPtpClient } from './ptp/client.js'
import { expireOverduePodRounds } from './jobs/expirePodRounds.js'
import { retryOverdueFailedFires } from './jobs/retryFailedFires.js'
import { refreshExpiringTokens } from './jobs/refreshTokens.js'
import { createGracefulShutdown } from './shutdown.js'

// All required config up front, fail-fast at boot — a missing var is a
// clear crash-loop with a log line, not a silent runtime failure. This
// includes DATABASE_URL even though Prisma would eventually throw on its
// own first query if it were missing: without this explicit check, a
// missing DATABASE_URL would let the container pass /healthz and only fail
// on the first real interaction, a worse failure mode than crash-looping
// at boot.
const discordPublicKey = requireEnv('DISCORD_PUBLIC_KEY')
const discordBotToken = requireEnv('DISCORD_BOT_TOKEN')
// A bot's user ID is always identical to its application/client ID — see
// discord/rest.ts's DiscordRestClient.botUserId doc comment for why this
// is threaded in rather than fetched live.
const discordApplicationId = requireEnv('DISCORD_APPLICATION_ID')
const botApiKey = requireEnv('BOT_API_KEY')
const tokenEncryptionKey = requireEnv('TOKEN_ENCRYPTION_KEY')
const ptpBaseUrl = requireEnv('PTP_BASE_URL')
requireEnv('DATABASE_URL')

const prisma = new PrismaClient()
const ptp = new HttpPtpClient({ baseUrl: ptpBaseUrl })
const discordRest = createDiscordRest(discordBotToken, discordApplicationId)

const app = await buildApp({ prisma, ptp, discordRest, discordPublicKey, botApiKey, tokenEncryptionKey })

// Same shape buildApp constructs internally for its own route
// registration — rebuilt here (rather than returned out of buildApp) so
// buildApp's return type stays a plain FastifyInstance, the only thing a
// test calling it actually needs.
const backendDeps = { prisma, ptp, tokenEncryptionKey, logger: app.log }

// Three periodic jobs, all in-process rather than separate scheduled AWS
// resources since none needs state beyond what's already in Postgres.
// All three are registered as sweeps on the one shutdown lifecycle (see
// shutdown.ts) — SIGTERM/SIGINT stop new ticks for all of them and wait out
// whichever is in flight before the process (and its DB connection) goes
// away.
//
// Pod-round deadlines (see util/duration.ts, jobs/expirePodRounds.ts): a
// 1-minute interval bounds worst-case lateness without being noisy, and
// reuses the same atomic-claim pattern already proven safe under
// concurrent execution (tasks/001).
const SWEEP_INTERVAL_MS = 60_000
// PTP token refresh (jobs/refreshTokens.ts, INTEGRATIONS.md §8.3):
// proactively rotates tokens expiring within the job's own 5-day window,
// so a daily cadence comfortably keeps every organizer inside that
// window well before their token actually expires.
const TOKEN_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const gracefulShutdown = createGracefulShutdown({
  app,
  prisma,
  logger: app.log,
  sweeps: [
    {
      name: 'pod-round-expiration',
      run: () => expireOverduePodRounds(backendDeps, discordRest),
      intervalMs: SWEEP_INTERVAL_MS,
    },
    {
      // Retries a round stuck at THRESHOLD_REACHED after its initial
      // fireRound attempt failed to create the PTP pod (issue #5) — reuses
      // the same 1-minute cadence as pod-round-expiration since retries
      // should be checked at least as often as rounds fire in the first
      // place; services/pods.ts's RETRY_WINDOW_MS (30 minutes) bounds how
      // long a round keeps retrying before this sweep gives up and sends a
      // visible failure notification instead.
      name: 'fire-retry',
      run: () => retryOverdueFailedFires(backendDeps, discordRest),
      intervalMs: SWEEP_INTERVAL_MS,
    },
    {
      name: 'token-refresh',
      run: () => refreshExpiringTokens(prisma, ptp, tokenEncryptionKey),
      intervalMs: TOKEN_REFRESH_INTERVAL_MS,
    },
  ],
})
gracefulShutdown.start()

const port = Number(process.env.PORT ?? 3000)
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`escape-pod listening on :${port}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

// SIGTERM: what ECS sends on every deploy. SIGINT: Ctrl+C during local
// `npm run dev`. Both get the same graceful drain — see shutdown.ts.
process.on('SIGTERM', () => {
  void gracefulShutdown.shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  void gracefulShutdown.shutdown('SIGINT')
})

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}
