import type { Logger } from './services/errors.js'

// ECS sends SIGTERM on every deploy and gives the container 30s (no
// stopTimeout override in infra/ecs.tf — see that file) before SIGKILL.
// This ceiling has to stay meaningfully under that so there's headroom for
// the SIGKILL itself to not be what actually stops us — if we ever hang
// past this, force-exiting ourselves with a clear log line beats a silent
// SIGKILL with nothing in CloudWatch to explain it.
export const SHUTDOWN_TIMEOUT_MS = 20_000

export interface ShutdownDeps {
  app: { close(): Promise<void> }
  prisma: { $disconnect(): Promise<void> }
  logger: Logger
  runSweep: () => Promise<unknown>
  sweepIntervalMs: number
  // Overridable only for tests — production always gets the real ceiling.
  timeoutMs?: number
}

export interface GracefulShutdown {
  // Starts the periodic sweep. Call once, after construction.
  start(): void
  // Runs the graceful-shutdown sequence. Safe to call more than once (e.g.
  // a second SIGTERM/SIGINT arriving mid-shutdown) — every call after the
  // first just awaits the same in-flight sequence rather than re-running it.
  shutdown(signal: string): Promise<void>
}

// Owns the sweep's setInterval directly (rather than server.ts owning the
// interval and this module only being told "a sweep is running") so that
// "stop scheduling new ticks" and "know whether one is in flight" live in
// one place with no risk of the two getting out of sync. server.ts's own
// behavior is unchanged: same interval, same sweep function, same
// catch-and-log-don't-crash — this just wraps that in a lifecycle that
// SIGTERM/SIGINT can hook into.
export function createGracefulShutdown(deps: ShutdownDeps): GracefulShutdown {
  const { app, prisma, logger, runSweep, sweepIntervalMs, timeoutMs = SHUTDOWN_TIMEOUT_MS } = deps

  let timer: ReturnType<typeof setInterval> | undefined
  let sweepInFlight: Promise<unknown> | undefined
  let shutdownPromise: Promise<void> | undefined

  function tick(): void {
    // Overlapping ticks shouldn't happen at a 60s interval against a sweep
    // that's expected to be fast, but guarding here costs nothing and keeps
    // "is a sweep running" unambiguous for shutdown() below.
    if (sweepInFlight) return

    const run = runSweep().catch((err) => {
      logger.error({ err }, 'pod-round expiration sweep failed')
    })
    sweepInFlight = run
    void run.finally(() => {
      if (sweepInFlight === run) sweepInFlight = undefined
    })
  }

  return {
    start() {
      timer = setInterval(tick, sweepIntervalMs)
    },

    shutdown(signal: string) {
      if (shutdownPromise) return shutdownPromise

      shutdownPromise = (async () => {
        logger.error({ signal }, 'shutdown signal received, draining before exit')

        // Stop scheduling new ticks immediately — a tick due right after the
        // signal must never start a fresh fireRound claim (see fireRound's
        // one-way-door comment in services/pods.ts) once we're on our way out.
        if (timer) clearInterval(timer)

        let timedOut = false
        const timeout = new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true
            resolve()
          }, timeoutMs).unref()
        })

        const work = (async () => {
          // Let any sweep iteration already in flight finish — it may be
          // mid-way through claiming/firing a round, and killing it there is
          // exactly the stuck-round failure mode this module exists to avoid.
          if (sweepInFlight) await sweepInFlight

          // Fastify's close() already waits for in-flight HTTP requests
          // (e.g. an in-flight /interactions call) before resolving.
          await app.close()
          await prisma.$disconnect()
        })()

        await Promise.race([work, timeout])

        if (timedOut) {
          logger.error({ signal }, 'graceful shutdown timed out, forcing exit')
          process.exit(1)
        }

        process.exit(0)
      })()

      return shutdownPromise
    },
  }
}
