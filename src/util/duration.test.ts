import { describe, expect, it } from 'vitest'
import { parseDurationMs } from './duration.js'

describe('parseDurationMs', () => {
  it('parses minutes', () => {
    expect(parseDurationMs('90m')).toBe(90 * 60_000)
  })

  it('parses hours', () => {
    expect(parseDurationMs('2h')).toBe(2 * 60 * 60_000)
  })

  it('parses days', () => {
    expect(parseDurationMs('1d')).toBe(24 * 60 * 60_000)
  })

  it('trims surrounding whitespace', () => {
    expect(parseDurationMs('  2h  ')).toBe(2 * 60 * 60_000)
  })

  it('returns null for zero or negative amounts', () => {
    expect(parseDurationMs('0m')).toBeNull()
    expect(parseDurationMs('-5m')).toBeNull()
  })

  it('returns null for an unrecognized unit', () => {
    expect(parseDurationMs('5w')).toBeNull()
    expect(parseDurationMs('5s')).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(parseDurationMs('two hours')).toBeNull()
    expect(parseDurationMs('h5')).toBeNull()
    expect(parseDurationMs('')).toBeNull()
    expect(parseDurationMs('5')).toBeNull()
  })
})
