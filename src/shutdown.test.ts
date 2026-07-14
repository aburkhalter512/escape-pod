import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stub, type Stub } from './testUtils/stub.js'
import { createGracefulShutdown } from './shutdown.js'

const SWEEP_INTERVAL_MS = 60_000

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// Stub-backed shape (rather than ShutdownDeps directly) so every test can
// read `.calls` off any dependency without re-widening back to the plain
// function types ShutdownDeps declares. Defaults to a single sweep named
// 'test-sweep' — tests that care about multiple sweeps pass their own
// `sweeps` array instead.
interface FakeDepsOverrides {
  app?: { close: Stub<[], Promise<void>> }
  prisma?: { $disconnect: Stub<[], Promise<void>> }
  logger?: { error: Stub<[unknown, string], void> }
  runSweep?: Stub<[], Promise<unknown>>
  sweeps?: Array<{ name: string; run: () => Promise<unknown>; intervalMs: number }>
  timeoutMs?: number
}

function fakeDeps(overrides: FakeDepsOverrides = {}) {
  return {
    app: overrides.app ?? { close: stub(async () => {}) },
    prisma: overrides.prisma ?? { $disconnect: stub(async () => {}) },
    logger: overrides.logger ?? { error: stub((_obj: unknown, _msg: string) => {}) },
    sweeps: overrides.sweeps ?? [
      { name: 'test-sweep', run: overrides.runSweep ?? stub(async () => {}), intervalMs: SWEEP_INTERVAL_MS },
    ],
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  }
}

describe('createGracefulShutdown', () => {
  let exitSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    exitSpy = vi.fn()
    vi.spyOn(process, 'exit').mockImplementation(exitSpy as unknown as typeof process.exit)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('closes the server and disconnects prisma when no sweep is running', async () => {
    const deps = fakeDeps()
    const shutdown = createGracefulShutdown(deps)
    shutdown.start()

    await shutdown.shutdown('SIGTERM')

    expect(deps.app.close.calls.length).toBe(1)
    expect(deps.prisma.$disconnect.calls.length).toBe(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('waits for an in-flight sweep to finish before closing the server', async () => {
    const sweepGate = deferred<void>()
    const closeOrder: string[] = []
    const deps = fakeDeps({
      runSweep: stub(() => sweepGate.promise),
      app: {
        close: stub(async () => {
          closeOrder.push('close')
        }),
      },
    })
    const shutdown = createGracefulShutdown(deps)
    shutdown.start()

    // Trigger the sweep tick so it's "in flight" when shutdown starts.
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)

    const shutdownPromise = shutdown.shutdown('SIGTERM')

    // Give pending microtasks a chance to run; close() must not have
    // happened yet because the sweep hasn't resolved.
    await vi.advanceTimersByTimeAsync(0)
    expect(closeOrder).toEqual([])
    expect(deps.app.close.calls.length).toBe(0)

    sweepGate.resolve()
    await shutdownPromise

    expect(closeOrder).toEqual(['close'])
    expect(deps.app.close.calls.length).toBe(1)
    expect(deps.prisma.$disconnect.calls.length).toBe(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('stops scheduling new sweep ticks the moment shutdown starts', async () => {
    const runSweep = stub(async () => {})
    const deps = fakeDeps({ runSweep })
    const shutdown = createGracefulShutdown(deps)
    shutdown.start()

    await shutdown.shutdown('SIGTERM')
    expect(runSweep.calls.length).toBe(0)

    // A tick due right after the signal must not fire a new sweep.
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)
    expect(runSweep.calls.length).toBe(0)
  })

  it('is idempotent under a second signal', async () => {
    const deps = fakeDeps()
    const shutdown = createGracefulShutdown(deps)
    shutdown.start()

    const first = shutdown.shutdown('SIGTERM')
    const second = shutdown.shutdown('SIGINT')

    await Promise.all([first, second])

    expect(deps.app.close.calls.length).toBe(1)
    expect(deps.prisma.$disconnect.calls.length).toBe(1)
    expect(exitSpy).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('runs multiple registered sweeps independently and waits for all of them on shutdown', async () => {
    const fastGate = deferred<void>()
    const slowGate = deferred<void>()
    const fastRun = stub(() => fastGate.promise)
    const slowRun = stub(() => slowGate.promise)
    const closeOrder: string[] = []
    const deps = fakeDeps({
      sweeps: [
        { name: 'fast-sweep', run: fastRun, intervalMs: 1_000 },
        { name: 'slow-sweep', run: slowRun, intervalMs: 5_000 },
      ],
      app: {
        close: stub(async () => {
          closeOrder.push('close')
        }),
      },
    })
    const shutdown = createGracefulShutdown(deps)
    shutdown.start()

    // Only the fast sweep's interval has elapsed — the slow one shouldn't
    // have ticked yet, confirming each sweep really does run on its own
    // schedule rather than sharing one interval.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fastRun.calls.length).toBe(1)
    expect(slowRun.calls.length).toBe(0)

    // Now get the slow sweep in flight too, so shutdown() has both to wait on.
    await vi.advanceTimersByTimeAsync(4_000)
    expect(slowRun.calls.length).toBe(1)

    const shutdownPromise = shutdown.shutdown('SIGTERM')
    await vi.advanceTimersByTimeAsync(0)
    expect(closeOrder).toEqual([])

    fastGate.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(closeOrder).toEqual([]) // slow sweep still in flight

    slowGate.resolve()
    await shutdownPromise

    expect(closeOrder).toEqual(['close'])
    expect(deps.prisma.$disconnect.calls.length).toBe(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('force-exits with a clear log line if the timeout elapses before everything finishes', async () => {
    const never = new Promise<void>(() => {})
    const errorLog = stub((_obj: unknown, _msg: string) => {})
    const deps = fakeDeps({
      runSweep: stub(() => never),
      logger: { error: errorLog },
      timeoutMs: 1_000,
    })
    const shutdown = createGracefulShutdown(deps)
    shutdown.start()

    // Get a sweep in flight so shutdown() actually has something to wait on.
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)

    const shutdownPromise = shutdown.shutdown('SIGTERM')
    await vi.advanceTimersByTimeAsync(1_000)
    await shutdownPromise

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(deps.app.close.calls.length).toBe(0)
    const timeoutLog = errorLog.calls.find((call) => call[1] === 'graceful shutdown timed out, forcing exit')
    expect(timeoutLog).toBeDefined()
  })
})
