import type { Logger } from './services/errors.js'

// ECS sends SIGTERM on every deploy and gives the container 30s (no
// stopTimeout override in infra/ecs.tf — see that file) before SIGKILL.
// This ceiling has to stay meaningfully under that so there's headroom for
// the SIGKILL itself to not be what actually stops us — if we ever hang
// past this, force-exiting ourselves with a clear log line beats a silent
// SIGKILL with nothing in CloudWatch to explain it.
export const SHUTDOWN_TIMEOUT_MS = 20_000

// One periodic job — the pod-round expiry sweep and the PTP token-refresh
// job (see server.ts) are both registered this way, each with its own
// interval and its own in-flight tracking, but sharing one shutdown
// lifecycle (one SIGTERM drains all of them, not one per job).
export interface ScheduledSweep {
  name: string
  run: () => Promise<unknown>
  intervalMs: number
}

export interface ShutdownDeps {
  app: { close(): Promise<void> }
  prisma: { $disconnect(): Promise<void> }
  logger: Logger
  sweeps: ScheduledSweep[]
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

// Owns every sweep's setInterval directly (rather than server.ts owning
// the intervals and this module only being told "a sweep is running") so
// that "stop scheduling new ticks" and "know whether one is in flight"
// live in one place per job, with no risk of the two getting out of sync.
// Each registered sweep keeps its own interval and its own in-flight
// tracking — a slow token-refresh run in progress doesn't block the
// pod-round sweep's own ticks, or vice versa — but shutdown() waits for
// all of them together before closing the server. server.ts's own
// per-job behavior is unchanged: same intervals, same sweep functions,
// same catch-and-log-don't-crash — this just wraps that in a lifecycle
// that SIGTERM/SIGINT can hook into.
export function createGracefulShutdown(deps: ShutdownDeps): GracefulShutdown {
  const { app, prisma, logger, sweeps, timeoutMs = SHUTDOWN_TIMEOUT_MS } = deps

  interface SweepState {
    sweep: ScheduledSweep
    timer: ReturnType<typeof setInterval> | undefined
    inFlight: Promise<unknown> | undefined
  }
  const state: SweepState[] = sweeps.map((sweep) => ({ sweep, timer: undefined, inFlight: undefined }))
  let shutdownPromise: Promise<void> | undefined

  function tick(entry: SweepState): void {
    // Overlapping ticks for the same sweep shouldn't happen against a job
    // that's expected to be fast relative to its own interval, but
    // guarding here costs nothing and keeps "is this sweep running"
    // unambiguous for shutdown() below.
    if (entry.inFlight) return

    const run = entry.sweep.run().catch((err) => {
      logger.error({ err, sweep: entry.sweep.name }, `${entry.sweep.name} sweep failed`)
    })
    entry.inFlight = run
    void run.finally(() => {
      if (entry.inFlight === run) entry.inFlight = undefined
    })
  }

  return {
    start() {
      for (const entry of state) {
        entry.timer = setInterval(() => tick(entry), entry.sweep.intervalMs)
      }
    },

    shutdown(signal: string) {
      if (shutdownPromise) return shutdownPromise

      shutdownPromise = (async () => {
        logger.error({ signal }, 'shutdown signal received, draining before exit')

        // Stop scheduling new ticks immediately, for every sweep — a tick
        // due right after the signal must never start a fresh fireRound
        // claim (see fireRound's one-way-door comment in services/pods.ts)
        // once we're on our way out, and the same caution applies to
        // starting a fresh token-refresh batch mid-shutdown.
        for (const entry of state) {
          if (entry.timer) clearInterval(entry.timer)
        }

        let timedOut = false
        const timeout = new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true
            resolve()
          }, timeoutMs).unref()
        })

        const work = (async () => {
          // Let any sweep iteration already in flight finish, across every
          // registered job — one may be mid-way through claiming/firing a
          // round, and killing it there is exactly the stuck-round failure
          // mode this module exists to avoid.
          await Promise.all(state.map((entry) => entry.inFlight))

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
