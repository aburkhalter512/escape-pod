// Parses a relative duration like "2h", "90m", "1d" — used for
// /start-pod's deadline option. Deliberately not an absolute date/time:
// that would require deciding whose timezone it's interpreted in, where a
// duration sidesteps the question entirely (see commands/startPod.ts,
// which converts the result to an absolute epoch timestamp and displays
// it via Discord's own <t:epoch:R> markup, auto-localized per viewer).
//
// No min/max bounds here — those are policy (what's a *sensible* deadline
// for this app), not what "is this syntactically a duration" means, so
// they live in the caller instead.
const DURATION_PATTERN = /^(\d+)(m|h|d)$/

const UNIT_MS: Record<'m' | 'h' | 'd', number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
}

export function parseDurationMs(input: string): number | null {
  const match = DURATION_PATTERN.exec(input.trim())
  if (!match) return null

  const amount = Number.parseInt(match[1], 10)
  if (amount <= 0) return null

  const unit = match[2] as 'm' | 'h' | 'd'
  return amount * UNIT_MS[unit]
}
