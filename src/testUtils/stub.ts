// A hand-rolled stand-in for vi.fn(): records every call's arguments into
// `.calls` and delegates to `impl` for the return value. No argument-
// matching or assertion magic beyond a plain array — each call site decides
// what "correct arguments" means and returns real vs. invalid data itself
// (see e.g. testUtils/fakePtpClient.ts and its test overrides).
export interface Stub<Args extends unknown[], Result> {
  (...args: Args): Result
  readonly calls: Args[]
}

export function stub<Args extends unknown[], Result>(impl: (...args: Args) => Result): Stub<Args, Result> {
  const calls: Args[] = []
  const fn = ((...args: Args) => {
    calls.push(args)
    return impl(...args)
  }) as Stub<Args, Result>
  Object.defineProperty(fn, 'calls', { value: calls })
  return fn
}

// Default for fixture methods no override was provided for — calling one
// means a test exercised a dependency it didn't set up, which is itself a
// bug in the test.
export function unimplemented<Args extends unknown[], Result>(name: string): Stub<Args, Result> {
  return stub((..._args: Args): Result => {
    throw new Error(`${name} was called without a test override`)
  })
}
