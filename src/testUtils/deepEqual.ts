import { deepStrictEqual } from 'node:assert'

// Structural equality for verifying stub() call arguments — built on
// Node's own assert module rather than a matcher/mocking library.
export function deepEqual(actual: unknown, expected: unknown): boolean {
  try {
    deepStrictEqual(actual, expected)
    return true
  } catch {
    return false
  }
}
