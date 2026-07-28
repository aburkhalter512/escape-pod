import { describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'

// The load-bearing spike for Phase 3's design decision: this issues a
// real HTTP request through the Worker's default export (not an
// in-process function call, not runInDurableObject) - proving
// worker.ts's stub.fetch(request) forwarding and durableObject.ts's
// fetch() -> Hono handoff actually work end to end under real workerd,
// not just type-check. See the migration plan's Phase 3 section for why
// this was flagged as the plan's highest-uncertainty item.
describe('worker fetch to DO to Hono', () => {
  it('answers healthz through the full Worker to DO to Hono chain', async () => {
    const response = await SELF.fetch('https://example.com/healthz')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })

  it('serves multiple sequential requests against the one singleton DO instance', async () => {
    const first = await SELF.fetch('https://example.com/healthz')
    // vitest-pool-workers' isolated storage requires every response body to
    // be fully consumed (see the "known issues" doc's storage-isolation
    // section) — an unconsumed body left a dangling stream that broke
    // isolated-storage disposal between tests, confirmed by reproducing
    // and fixing this exact failure while writing this test.
    expect(await first.text()).toBe('ok')

    const second = await SELF.fetch('https://example.com/healthz')
    expect(await second.text()).toBe('ok')
  })
})
